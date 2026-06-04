import assert from "node:assert/strict";
import test from "node:test";
import { createBraveSearchProvider } from "../src/providers/brave-search.ts";
import { createDuckDuckGoSearchProvider, parseDuckDuckGoResults } from "../src/providers/duckduckgo-search.ts";
import { createOpenAIResearchSynthesizer } from "../src/providers/openai-synthesis.ts";
import type { HttpFetch } from "../src/providers/http.ts";

test("Brave Search provider calls the official web search endpoint", async () => {
  const calls: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
  const provider = createBraveSearchProvider({
    apiKey: "brave-key",
    country: "us",
    searchLang: "en",
    async fetcher(url, init) {
      calls.push({ url, init });
      return jsonResponse({
        web: {
          results: [
            {
              title: "Result one",
              url: "https://example.com/one",
              description: "Snippet one",
            },
          ],
        },
      });
    },
  });

  const results = await provider(
    {
      query: "solar policy",
      maxResults: 3,
    },
    {
      runId: "run_1",
      step: 1,
      signal: new AbortController().signal,
    },
  );

  const calledUrl = new URL(calls[0].url);
  assert.equal(calledUrl.origin + calledUrl.pathname, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(calledUrl.searchParams.get("q"), "solar policy");
  assert.equal(calledUrl.searchParams.get("count"), "3");
  assert.equal(calledUrl.searchParams.get("country"), "us");
  assert.equal(calls[0].init?.headers?.["X-Subscription-Token"], "brave-key");
  assert.deepEqual(results, [
    {
      title: "Result one",
      url: "https://example.com/one",
      snippet: "Snippet one",
    },
  ]);
});

test("OpenAI synthesizer requests structured JSON over the Responses API", async () => {
  const calls: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
  const synthesize = createOpenAIResearchSynthesizer({
    apiKey: "openai-key",
    model: "gpt-test",
    currentDate: "2026-06-03",
    async fetcher(url, init) {
      calls.push({ url, init });
      return jsonResponse({
        output_text: JSON.stringify({
          answer: "Answer grounded in source.",
          citations: [
            {
              title: "Observed",
              url: "https://example.com/observed",
            },
          ],
        }),
      });
    },
  });

  const result = await synthesize({
    task: "Summarize",
    sources: [
      {
        title: "Observed",
        url: "https://example.com/observed",
      },
    ],
    observations: [
      {
        step: 2,
        toolName: "fetchUrl",
        input: {
          url: "https://example.com/observed",
        },
        result: {
          ok: true,
          data: {
            title: "Observed",
            url: "https://example.com/observed",
            text: "Fetched evidence.",
          },
        },
      },
      {
        step: 3,
        toolName: "dateMath",
        input: {
          operation: "elapsedYears",
          fromDate: "1703-05-27",
          toDate: "2026-06-03",
        },
        result: {
          ok: true,
          data: {
            operation: "elapsedYears",
            fromDate: "1703-05-27",
            toDate: "2026-06-03",
            years: 323,
          },
        },
      },
    ],
  });

  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.headers?.Authorization, "Bearer openai-key");

  const body = JSON.parse(calls[0].init?.body ?? "{}");
  assert.equal(body.model, "gpt-test");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.match(body.instructions, /Today's date is 2026-06-03/);
  assert.match(body.input, /Current date: 2026-06-03/);
  assert.match(body.input, /Fetched evidence/);
  assert.match(body.input, /Deterministic calculations:/);
  assert.match(body.input, /Full elapsed years: 323/);
  assert.deepEqual(result, {
    answer: "Answer grounded in source.",
    citations: [
      {
        title: "Observed",
        url: "https://example.com/observed",
      },
    ],
  });
});

test("DuckDuckGo provider searches HTML results without an API key", async () => {
  const calls: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
  const provider = createDuckDuckGoSearchProvider({
    async fetcher(url, init) {
      calls.push({ url, init });
      return textResponse(`
        <html>
          <body>
            <a class="result__a" href="https://example.com/direct">Direct Result</a>
            <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fredirected&amp;rut=abc">Redirected Result</a>
          </body>
        </html>
      `);
    },
  });

  const results = await provider(
    {
      query: "solar policy",
      maxResults: 1,
    },
    {
      runId: "run_1",
      step: 1,
      signal: new AbortController().signal,
    },
  );

  const calledUrl = new URL(calls[0].url);
  assert.equal(calledUrl.origin + calledUrl.pathname, "https://duckduckgo.com/html/");
  assert.equal(calledUrl.searchParams.get("q"), "solar policy");
  assert.equal(calls[0].init?.headers?.Accept, "text/html");
  assert.deepEqual(results, [
    {
      title: "Direct Result",
      url: "https://example.com/direct",
    },
  ]);
});

test("DuckDuckGo parser decodes redirected result URLs", () => {
  const results = parseDuckDuckGoResults(`
    <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&amp;rut=abc">
      Example &amp; Result
    </a>
  `);

  assert.deepEqual(results, [
    {
      title: "Example & Result",
      url: "https://example.com/page?x=1",
    },
  ]);
});

test("providers fail fast when required keys are missing", () => {
  assert.throws(
    () => createBraveSearchProvider({ apiKey: "" }),
    /BRAVE_SEARCH_API_KEY is required/,
  );
  assert.throws(
    () => createOpenAIResearchSynthesizer({ apiKey: "", model: "gpt-test" }),
    /OPENAI_API_KEY is required/,
  );
  assert.throws(
    () => createOpenAIResearchSynthesizer({ apiKey: "openai-key", model: "" }),
    /OPENAI_MODEL is required/,
  );
});

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function textResponse(payload: string) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {};
    },
    async text() {
      return payload;
    },
  };
}
