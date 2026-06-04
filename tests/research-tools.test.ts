import assert from "node:assert/strict";
import test from "node:test";
import { createAgent, type ModelAction } from "../src/index.ts";
import {
  createDateMathTool,
  createFetchUrlTool,
  createSearchWebTool,
} from "../src/research.ts";

test("searchWeb returns bounded source results", async () => {
  const searchWeb = createSearchWebTool((input) => [
    {
      title: `Primary result for ${input.query}`,
      url: "https://example.com/primary",
      snippet: "Primary source",
    },
    {
      title: "Secondary result",
      url: "https://example.com/secondary",
    },
  ]);

  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "searchWeb",
      input: {
        query: "solar subsidy",
        maxResults: 1,
      },
    },
    {
      type: "final",
      answer: "done",
    },
  ];

  const agent = createAgent({
    tools: [searchWeb],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Find sources");

  assert.equal(result.status, "completed");
  assert.deepEqual(result.observations[0].sources, [
    {
      title: "Primary result for solar subsidy",
      url: "https://example.com/primary",
    },
  ]);
  assert.deepEqual(result.observations[0].result, {
    ok: true,
    data: [
      {
        title: "Primary result for solar subsidy",
        url: "https://example.com/primary",
        snippet: "Primary source",
      },
    ],
  });
});

test("fetchUrl extracts title, text, and fetched source metadata", async () => {
  const fetchUrl = createFetchUrlTool(async () => ({
    status: 200,
    ok: true,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/html" : null;
      },
    },
    async text() {
      return "<html><head><title>Policy &amp; Funding</title><style>body{}</style></head><body><h1>Solar</h1><script>x()</script><p>Battery subsidy details.</p></body></html>";
    },
  }));

  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "fetchUrl",
      input: {
        url: "https://example.com/policy",
        maxChars: 30,
      },
    },
    {
      type: "final",
      answer: "done",
    },
  ];

  const agent = createAgent({
    tools: [fetchUrl],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Fetch source");
  const observation = result.observations[0];

  assert.equal(result.status, "completed");
  assert.equal(observation.sources?.[0].title, "Policy & Funding");
  assert.equal(observation.sources?.[0].url, "https://example.com/policy");
  assert.match(observation.sources?.[0].fetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(observation.result.ok, true);
  if (observation.result.ok) {
    assert.equal((observation.result.data as { title: string }).title, "Policy & Funding");
    assert.equal((observation.result.data as { text: string }).text, "Policy & Funding Solar Battery");
  }
});

test("fetchUrl rejects non-HTTP URLs before execution", async () => {
  const fetchUrl = createFetchUrlTool(async () => {
    throw new Error("Should not fetch.");
  });

  const agent = createAgent({
    tools: [fetchUrl],
    policy: {
      maxSteps: 1,
    },
    model: {
      complete() {
        return {
          type: "tool_call",
          toolName: "fetchUrl",
          input: {
            url: "file:///etc/passwd",
          },
        };
      },
    },
  });

  const result = await agent.run("Fetch local file");

  assert.equal(result.status, "failed");
  assert.deepEqual(result.observations[0].result, {
    ok: false,
    error: {
      code: "invalid_tool_input",
      message: "Only HTTP(S) URLs are allowed.",
    },
  });
});

test("dateMath returns full elapsed years between exact dates", async () => {
  const dateMath = createDateMathTool("2026-06-03");
  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "dateMath",
      input: {
        operation: "elapsedYears",
        fromDate: "1703-05-27",
      },
    },
    {
      type: "final",
      answer: "done",
    },
  ];

  const agent = createAgent({
    tools: [dateMath],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Calculate age");

  assert.equal(result.status, "completed");
  assert.deepEqual(result.observations[0].result, {
    ok: true,
    data: {
      operation: "elapsedYears",
      fromDate: "1703-05-27",
      toDate: "2026-06-03",
      years: 323,
    },
  });
});

test("dateMath subtracts one year before the anniversary date", async () => {
  const dateMath = createDateMathTool("2026-05-26");
  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "dateMath",
      input: {
        operation: "elapsedYears",
        fromDate: "1703-05-27",
      },
    },
    {
      type: "final",
      answer: "done",
    },
  ];

  const agent = createAgent({
    tools: [dateMath],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Calculate age");

  assert.equal(result.status, "completed");
  assert.deepEqual(result.observations[0].result, {
    ok: true,
    data: {
      operation: "elapsedYears",
      fromDate: "1703-05-27",
      toDate: "2026-05-26",
      years: 322,
    },
  });
});
