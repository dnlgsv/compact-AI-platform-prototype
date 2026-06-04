import type { SearchProvider, SearchResult } from "../research.ts";
import { defaultHttpFetch, type HttpFetch } from "./http.ts";

export type BraveSearchProviderConfig = {
  apiKey: string;
  fetcher?: HttpFetch;
  country?: string;
  searchLang?: string;
};

export function createBraveSearchProvider(config: BraveSearchProviderConfig): SearchProvider {
  const fetcher = config.fetcher ?? defaultHttpFetch;
  const apiKey = required(config.apiKey, "BRAVE_SEARCH_API_KEY");

  return async (input, context) => {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.maxResults));
    if (config.country) {
      url.searchParams.set("country", config.country);
    }
    if (config.searchLang) {
      url.searchParams.set("search_lang", config.searchLang);
    }

    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: context.signal,
    });

    if (!response.ok) {
      throw new Error(`Brave Search failed with HTTP ${response.status}: ${await response.text()}`);
    }

    return parseBraveResults(await response.json());
  };
}

function parseBraveResults(payload: unknown): SearchResult[] {
  const results = (payload as { web?: { results?: unknown[] } }).web?.results;
  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .map((item) => {
      const result = item as { title?: unknown; url?: unknown; description?: unknown };
      if (typeof result.title !== "string" || typeof result.url !== "string") {
        return undefined;
      }
      return {
        title: result.title,
        url: result.url,
        snippet: typeof result.description === "string" ? result.description : undefined,
      };
    })
    .filter((item): item is SearchResult => item !== undefined);
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
