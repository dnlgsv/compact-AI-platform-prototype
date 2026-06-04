import {
  createAgent,
  type AgentRunResult,
  type Citation,
  type ModelAdapter,
  type Observation,
  type Source,
} from "./index.ts";
import {
  createFetchUrlTool,
  createSearchWebTool,
  type Fetcher,
  type SearchResult,
  type SearchProvider,
} from "./research.ts";

export type ResearchSynthesisInput = {
  task: string;
  sources: Source[];
  observations: Observation[];
};

export type ResearchSynthesisResult = {
  answer: string;
  citations: Citation[];
};

export type ResearchWorkflowConfig = {
  searchProvider: SearchProvider;
  fetcher?: Fetcher;
  maxSources?: number;
  maxCharsPerSource?: number;
  maxSearchQueries?: number;
  synthesize: (
    input: ResearchSynthesisInput,
  ) => ResearchSynthesisResult | Promise<ResearchSynthesisResult>;
};

export function createResearchWorkflow(config: ResearchWorkflowConfig) {
  const maxSources = config.maxSources ?? 3;
  const maxCharsPerSource = config.maxCharsPerSource ?? 8_000;
  const maxSearchQueries = config.maxSearchQueries ?? 4;

  return {
    run(task: string): Promise<AgentRunResult> {
      const agent = createAgent({
        tools: [
          createSearchWebTool(config.searchProvider),
          createFetchUrlTool(config.fetcher),
        ],
        policy: {
          maxSteps: maxSearchQueries + maxSources + 2,
          requireObservedCitations: true,
        },
        model: createResearchModel({
          maxSources,
          maxCharsPerSource,
          maxSearchQueries,
          synthesize: config.synthesize,
        }),
      });

      return agent.run(task);
    },
  };
}

function createResearchModel(config: {
  maxSources: number;
  maxCharsPerSource: number;
  maxSearchQueries: number;
  synthesize: ResearchWorkflowConfig["synthesize"];
}): ModelAdapter {
  return {
    async complete(input) {
      const searchQueries = buildSearchQueries(input.task).slice(0, config.maxSearchQueries);
      const attemptedSearchQueries = new Set(
        input.observations
          .filter((observation) => observation.toolName === "searchWeb")
          .map((observation) => (observation.input as { query?: unknown }).query)
          .filter((query): query is string => typeof query === "string"),
      );
      const nextSearchQuery = searchQueries.find((query) => !attemptedSearchQueries.has(query));

      if (nextSearchQuery) {
        return {
          type: "tool_call",
          toolName: "searchWeb",
          input: {
            query: nextSearchQuery,
            maxResults: config.maxSources,
          },
        };
      }

      const searchSources = rankSearchResults(
        readSearchResults(input.observations),
        input.task,
      );
      const fetchedSources = input.observations
        .filter((observation) => observation.toolName === "fetchUrl")
        .flatMap((observation) => observation.sources ?? []);
      const attemptedFetchUrls = new Set(
        input.observations
          .filter((observation) => observation.toolName === "fetchUrl")
          .map((observation) => (observation.input as { url?: unknown }).url)
          .filter((url): url is string => typeof url === "string"),
      );
      const nextSource = searchSources.find((source) => !attemptedFetchUrls.has(source.url));

      if (nextSource && fetchedSources.length < config.maxSources) {
        return {
          type: "tool_call",
          toolName: "fetchUrl",
          input: {
            url: nextSource.url,
            maxChars: config.maxCharsPerSource,
          },
        };
      }

      const result = await config.synthesize({
        task: input.task,
        sources: fetchedSources,
        observations: input.observations,
      });

      return {
        type: "final",
        answer: result.answer,
        citations: result.citations,
      };
    },
  };
}

export function buildSearchQueries(task: string): string[] {
  const normalizedTask = normalizeWhitespace(task);
  const entity = extractEntityCandidate(normalizedTask);
  const queries = [normalizedTask];

  if (entity) {
    queries.push(`${entity} company`);
    if (hasRoleIntent(normalizedTask)) {
      queries.push(`${entity} AI engineer careers`);
    }
    queries.push(`${entity} LinkedIn company`);
  } else {
    const compact = removeQuestionFiller(normalizedTask);
    if (compact && compact !== normalizedTask) {
      queries.push(compact);
    }
  }

  return uniqueStrings(queries).slice(0, 4);
}

function readSearchResults(observations: Observation[]): SearchResult[] {
  return observations
    .filter((observation) => observation.toolName === "searchWeb" && observation.result.ok)
    .flatMap((observation) => Array.isArray(observation.result.data) ? observation.result.data : [])
    .map((value) => value as { title?: unknown; url?: unknown; snippet?: unknown })
    .filter((value): value is SearchResult =>
      typeof value.title === "string" && typeof value.url === "string"
    );
}

function rankSearchResults(results: SearchResult[], task: string): Source[] {
  const entity = extractEntityCandidate(task);
  const roleIntent = hasRoleIntent(task);
  return dedupeSearchResults(results)
    .map((result, index) => ({
      result,
      index,
      score: scoreSearchResult(result, entity, roleIntent),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ result }) => ({
      title: result.title,
      url: result.url,
    }));
}

function scoreSearchResult(result: SearchResult, entity: string | undefined, roleIntent: boolean): number {
  const haystack = `${result.title} ${result.url} ${result.snippet ?? ""}`.toLowerCase();
  let score = 0;
  if (entity && containsLoose(haystack, entity)) {
    score += 6;
  }
  if (/\b(company|about|profile|official)\b/i.test(haystack)) {
    score += 2;
  }
  if (roleIntent && /\b(ai engineer|machine learning|career|careers|job|jobs|hiring|recruit)\b/i.test(haystack)) {
    score += 4;
  }
  return score;
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrlKey(result.url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractEntityCandidate(task: string): string | undefined {
  const quoted = task.match(/"([^"]{2,80})"/);
  if (quoted) {
    return normalizeEntityCandidate(quoted[1]);
  }

  const beforeCompany = task.match(/\b([A-Za-z0-9][A-Za-z0-9&.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9&.-]*){0,3})\s+company\b/i);
  if (beforeCompany) {
    return normalizeEntityCandidate(beforeCompany[1]);
  }

  return undefined;
}

function normalizeEntityCandidate(value: string): string | undefined {
  const words = normalizeWhitespace(value)
    .replace(/[?!.,:;]+$/g, "")
    .split(" ")
    .filter((word) => !/^(what|who|why|how|does|do|is|are|the|a|an|tell|me|about)$/i.test(word));
  const candidate = words.join(" ").trim();
  return candidate || undefined;
}

function hasRoleIntent(task: string): boolean {
  return /\b(ai|artificial intelligence|machine learning|engineer|engineers|career|careers|job|jobs|hiring|role|roles|need|needs)\b/i.test(task);
}

function removeQuestionFiller(task: string): string {
  return normalizeWhitespace(
    task.replace(/\b(what|who|why|how|does|do|is|are|the|a|an|for|they|their|need|needs)\b/gi, " "),
  );
}

function containsLoose(haystack: string, needle: string): boolean {
  const compactHaystack = haystack.replace(/[^a-z0-9]+/g, "");
  const compactNeedle = needle.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return compactNeedle.length > 0 && compactHaystack.includes(compactNeedle);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values.map(normalizeWhitespace).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
