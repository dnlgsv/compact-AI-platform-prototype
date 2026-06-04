import { defineTool, type Source, type ToolContext } from "./index.ts";

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type SearchWebInput = {
  query: string;
  maxResults: number;
};

export type FetchUrlInput = {
  url: string;
  maxChars: number;
};

export type DateMathInput = {
  operation: "elapsedYears";
  fromDate: string;
  toDate: string;
};

export type DateMathResult = DateMathInput & {
  years: number;
};

export type FetchedPage = Source & {
  status: number;
  contentType: string;
  text: string;
};

export type SearchProvider = (
  input: SearchWebInput,
  context: ToolContext,
) => SearchResult[] | Promise<SearchResult[]>;

export type Fetcher = (
  url: string,
  context: ToolContext,
) => Promise<{
  status: number;
  ok: boolean;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}>;

export function createSearchWebTool(provider: SearchProvider) {
  return defineTool<SearchWebInput, SearchResult[]>({
    name: "searchWeb",
    description: "Searches the web and returns candidate sources.",
    sideEffect: "none",
    validateInput(input: unknown) {
      if (!input || typeof input !== "object") {
        throw new Error("Expected an object input.");
      }

      const candidate = input as { query?: unknown; maxResults?: unknown };
      if (typeof candidate.query !== "string" || candidate.query.trim() === "") {
        throw new Error("Expected query to be a non-empty string.");
      }

      return {
        query: candidate.query.trim(),
        maxResults: readMaxChars(candidate.maxResults, 5, 10, "maxResults"),
      };
    },
    async execute(input, context) {
      const results = await provider(input, context);
      return results.slice(0, input.maxResults);
    },
    summarizeResult(results) {
      return results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
      }));
    },
    extractSources(results) {
      return results.map((result) => ({
        title: result.title,
        url: result.url,
      }));
    },
  });
}

export function createFetchUrlTool(fetcher: Fetcher = defaultFetcher) {
  return defineTool<FetchUrlInput, FetchedPage>({
    name: "fetchUrl",
    description: "Fetches an HTTP(S) page and returns bounded readable text.",
    sideEffect: "none",
    timeoutMs: 15_000,
    validateInput(input: unknown) {
      if (!input || typeof input !== "object") {
        throw new Error("Expected an object input.");
      }

      const candidate = input as { url?: unknown; maxChars?: unknown };
      if (typeof candidate.url !== "string") {
        throw new Error("Expected url to be a string.");
      }

      const url = new URL(candidate.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP(S) URLs are allowed.");
      }

      return {
        url: url.toString(),
        maxChars: readMaxChars(candidate.maxChars, 8_000, 50_000, "maxChars"),
      };
    },
    async execute(input, context) {
      const response = await fetcher(input.url, context);
      if (!response.ok) {
        throw new Error(`Fetch failed with HTTP ${response.status}.`);
      }

      const rawText = await response.text();
      const text = toReadableText(rawText).slice(0, input.maxChars);
      return {
        title: readTitle(rawText) ?? input.url,
        url: input.url,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        fetchedAt: new Date().toISOString(),
        text,
      };
    },
    summarizeResult(page) {
      return {
        title: page.title,
        url: page.url,
        status: page.status,
        contentType: page.contentType,
        fetchedAt: page.fetchedAt,
        text: page.text,
      };
    },
    extractSources(page) {
      return [
        {
          title: page.title,
          url: page.url,
          fetchedAt: page.fetchedAt,
        },
      ];
    },
  });
}

export function createDateMathTool(currentDate = new Date().toISOString().slice(0, 10)) {
  return defineTool<DateMathInput, DateMathResult>({
    name: "dateMath",
    description: "Performs deterministic date calculations on YYYY-MM-DD dates.",
    sideEffect: "none",
    validateInput(input: unknown) {
      if (!input || typeof input !== "object") {
        throw new Error("Expected an object input.");
      }

      const candidate = input as {
        operation?: unknown;
        fromDate?: unknown;
        toDate?: unknown;
      };
      if (candidate.operation !== "elapsedYears") {
        throw new Error('Expected operation to be "elapsedYears".');
      }
      if (typeof candidate.fromDate !== "string") {
        throw new Error("Expected fromDate to be a YYYY-MM-DD string.");
      }
      if (candidate.toDate !== undefined && typeof candidate.toDate !== "string") {
        throw new Error("Expected toDate to be a YYYY-MM-DD string.");
      }

      parseDateOnly(candidate.fromDate, "fromDate");
      parseDateOnly(candidate.toDate ?? currentDate, "toDate");

      return {
        operation: "elapsedYears",
        fromDate: candidate.fromDate,
        toDate: candidate.toDate ?? currentDate,
      };
    },
    execute(input) {
      return {
        ...input,
        years: calculateFullYears(input.fromDate, input.toDate),
      };
    },
  });
}

async function defaultFetcher(url: string, context: ToolContext) {
  return fetch(url, {
    signal: context.signal,
    redirect: "follow",
  });
}

function readMaxChars(
  value: unknown,
  defaultValue: number,
  maxValue: number,
  name: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maxValue) {
    throw new Error(`Expected ${name} to be an integer between 1 and ${maxValue}.`);
  }
  return Number(value);
}

function readTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return match ? decodeEntities(toReadableText(match[1])).trim() : undefined;
}

function toReadableText(text: string): string {
  return decodeEntities(
    text
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function calculateFullYears(fromDate: string, toDate: string): number {
  const from = parseDateOnly(fromDate, "fromDate");
  const to = parseDateOnly(toDate, "toDate");
  if (
    to.year < from.year ||
    (to.year === from.year && to.month < from.month) ||
    (to.year === from.year && to.month === from.month && to.day < from.day)
  ) {
    throw new Error("Expected toDate to be on or after fromDate.");
  }

  const anniversaryPassed =
    to.month > from.month ||
    (to.month === from.month && to.day >= from.day);
  return to.year - from.year - (anniversaryPassed ? 0 : 1);
}

function parseDateOnly(value: string, name: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Expected ${name} to be a YYYY-MM-DD string.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Expected ${name} to be a valid calendar date.`);
  }

  return { year, month, day };
}
