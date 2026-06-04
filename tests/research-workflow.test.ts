import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQueries, createResearchWorkflow } from "../src/research-workflow.ts";

test("buildSearchQueries expands compound company and role questions", () => {
  assert.deepEqual(
    buildSearchQueries("What does Acme Robotics company do and what do they need AI engineers for?"),
    [
      "What does Acme Robotics company do and what do they need AI engineers for?",
      "Acme Robotics company",
      "Acme Robotics AI engineer careers",
      "Acme Robotics LinkedIn company",
    ],
  );
});

test("research workflow searches, fetches selected sources, and synthesizes with observed citations", async () => {
  const fetchedUrls: string[] = [];
  const workflow = createResearchWorkflow({
    maxSources: 2,
    searchProvider() {
      return [
        {
          title: "Source A",
          url: "https://example.com/a",
        },
        {
          title: "Source B",
          url: "https://example.com/b",
        },
      ];
    },
    async fetcher(url) {
      fetchedUrls.push(url);
      return {
        status: 200,
        ok: true,
        headers: {
          get() {
            return "text/html";
          },
        },
        async text() {
          return `<title>${url}</title><main>Useful evidence for ${url}</main>`;
        },
      };
    },
    synthesize(input) {
      assert.equal(input.sources.length, 2);
      return {
        answer: "Both sources were fetched.",
        citations: [
          {
            title: input.sources[0].title,
            url: input.sources[0].url,
          },
        ],
      };
    },
  });

  const result = await workflow.run("Compare sources");

  assert.equal(result.status, "completed");
  assert.equal(result.answer, "Both sources were fetched.");
  assert.deepEqual(fetchedUrls, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(
    result.observations.map((observation) => observation.toolName),
    ["searchWeb", "fetchUrl", "fetchUrl"],
  );
  assert.equal(result.citations[0].url, "https://example.com/a");
});

test("research workflow fails if synthesis cites a source that was not fetched", async () => {
  const workflow = createResearchWorkflow({
    maxSources: 1,
    searchProvider() {
      return [
        {
          title: "Observed candidate",
          url: "https://example.com/observed",
        },
      ];
    },
    async fetcher() {
      return {
        status: 200,
        ok: true,
        headers: {
          get() {
            return "text/html";
          },
        },
        async text() {
          return "<title>Observed candidate</title><p>Fetched evidence.</p>";
        },
      };
    },
    synthesize() {
      return {
        answer: "This cites a missing source.",
        citations: [
          {
            title: "Missing",
            url: "https://example.com/missing",
          },
        ],
      };
    },
  });

  const result = await workflow.run("Cite missing source");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "citation_validation_failed");
});

test("research workflow uses expanded search queries and ranks company role evidence", async () => {
  const searchQueries: string[] = [];
  const fetchedUrls: string[] = [];
  const workflow = createResearchWorkflow({
    maxSources: 2,
    searchProvider(input) {
      searchQueries.push(input.query);
      if (input.query === "What does Acme Robotics company do and what do they need AI engineers for?") {
        return [
          {
            title: "Acme Packaging Company",
            url: "https://example.com/noise",
            snippet: "Packaging company with a similar name.",
          },
        ];
      }
      if (input.query === "Acme Robotics company") {
        return [
          {
            title: "Acme Robotics - Official Company",
            url: "https://acme.example/about",
            snippet: "Acme Robotics builds warehouse automation robots.",
          },
        ];
      }
      if (input.query === "Acme Robotics AI engineer careers") {
        return [
          {
            title: "Acme Robotics AI Engineer Jobs",
            url: "https://acme.example/careers/ai-engineer",
            snippet: "Hiring AI engineers for perception and planning systems.",
          },
        ];
      }
      return [
        {
          title: "Acme Robotics LinkedIn Company",
          url: "https://www.linkedin.com/company/acme-robotics",
          snippet: "Company profile.",
        },
      ];
    },
    async fetcher(url) {
      fetchedUrls.push(url);
      return {
        status: 200,
        ok: true,
        headers: {
          get() {
            return "text/html";
          },
        },
        async text() {
          if (url.includes("careers")) {
            return "<title>AI Engineer Jobs</title><main>AI engineers work on perception and planning.</main>";
          }
          return "<title>About Acme Robotics</title><main>Acme Robotics builds warehouse automation robots.</main>";
        },
      };
    },
    synthesize(input) {
      assert.deepEqual(
        input.sources.map((source) => source.url),
        [
          "https://acme.example/careers/ai-engineer",
          "https://acme.example/about",
        ],
      );
      return {
        answer: "Acme Robotics builds warehouse automation robots and hires AI engineers for perception and planning.",
        citations: [
          {
            title: input.sources[0].title,
            url: input.sources[0].url,
          },
          {
            title: input.sources[1].title,
            url: input.sources[1].url,
          },
        ],
      };
    },
  });

  const result = await workflow.run("What does Acme Robotics company do and what do they need AI engineers for?");

  assert.equal(result.status, "completed");
  assert.deepEqual(searchQueries, [
    "What does Acme Robotics company do and what do they need AI engineers for?",
    "Acme Robotics company",
    "Acme Robotics AI engineer careers",
    "Acme Robotics LinkedIn company",
  ]);
  assert.deepEqual(fetchedUrls, [
    "https://acme.example/careers/ai-engineer",
    "https://acme.example/about",
  ]);
});
