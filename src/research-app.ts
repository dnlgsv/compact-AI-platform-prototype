import { createResearchWorkflow } from "./research-workflow.ts";
import { createBraveSearchProvider } from "./providers/brave-search.ts";
import { createDuckDuckGoSearchProvider } from "./providers/duckduckgo-search.ts";
import { createOpenAIResearchSynthesizer } from "./providers/openai-synthesis.ts";

export function createResearchWorkflowFromEnv(env: Record<string, string | undefined> = process.env) {
  const currentDate = new Date().toISOString().slice(0, 10);
  return createResearchWorkflow({
    maxSources: readIntegerEnv(env, "MAX_SOURCES", 3),
    maxSearchQueries: readIntegerEnv(env, "MAX_SEARCH_QUERIES", 4),
    maxCharsPerSource: readIntegerEnv(env, "MAX_CHARS_PER_SOURCE", 8_000),
    searchProvider: createSearchProvider(env),
    synthesize: createOpenAIResearchSynthesizer({
      apiKey: readEnv(env, "OPENAI_API_KEY"),
      model: readEnv(env, "OPENAI_MODEL"),
      currentDate,
    }),
  });
}

function createSearchProvider(env: Record<string, string | undefined>) {
  const provider = env.SEARCH_PROVIDER ?? "duckduckgo";
  if (provider === "duckduckgo") {
    return createDuckDuckGoSearchProvider();
  }
  if (provider === "brave") {
    return createBraveSearchProvider({
      apiKey: readEnv(env, "BRAVE_SEARCH_API_KEY"),
      country: env.BRAVE_SEARCH_COUNTRY,
      searchLang: env.BRAVE_SEARCH_LANG,
    });
  }
  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
}

function readEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: number,
): number {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}
