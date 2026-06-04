import type { SearchProvider, SearchResult } from "../research.ts";
import { defaultHttpFetch, type HttpFetch } from "./http.ts";

export type DuckDuckGoSearchProviderConfig = {
  fetcher?: HttpFetch;
};

export function createDuckDuckGoSearchProvider(
  config: DuckDuckGoSearchProviderConfig = {},
): SearchProvider {
  const fetcher = config.fetcher ?? defaultHttpFetch;

  return async (input, context) => {
    const url = new URL("https://duckduckgo.com/html/");
    url.searchParams.set("q", input.query);

    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: {
        Accept: "text/html",
        "User-Agent": "ai-engine-lab/0.1",
      },
      signal: context.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed with HTTP ${response.status}: ${await response.text()}`);
    }

    return parseDuckDuckGoResults(await response.text()).slice(0, input.maxResults);
  };
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultLinkPattern = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;

  for (const match of html.matchAll(resultLinkPattern)) {
    const title = decodeHtml(stripTags(match[2])).trim();
    const url = decodeDuckDuckGoUrl(decodeHtml(match[1]));
    if (!title || !url || results.some((result) => result.url === url)) {
      continue;
    }
    results.push({
      title,
      url,
    });
  }

  return results;
}

function decodeDuckDuckGoUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) {
      return decodeURIComponent(redirected);
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
