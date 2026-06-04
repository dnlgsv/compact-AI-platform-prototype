import assert from "node:assert/strict";
import test from "node:test";
import { formatRunResult, parseCliArgs } from "../src/cli-format.ts";
import type { AgentRunResult } from "../src/index.ts";
import { testRunMetadata } from "./fixtures.ts";

test("parseCliArgs extracts --json and task text", () => {
  assert.deepEqual(parseCliArgs(["--json", "How", "old?"]), {
    json: true,
    output: undefined,
    replay: undefined,
    task: "How old?",
  });
  assert.deepEqual(parseCliArgs(["How", "old?"]), {
    json: false,
    output: undefined,
    replay: undefined,
    task: "How old?",
  });
});

test("parseCliArgs extracts output and replay paths", () => {
  assert.deepEqual(parseCliArgs(["--json", "--output", "runs/latest.json", "Research", "task"]), {
    json: true,
    output: "runs/latest.json",
    replay: undefined,
    task: "Research task",
  });
  assert.deepEqual(parseCliArgs(["--replay", "runs/latest.json"]), {
    json: false,
    output: undefined,
    replay: "runs/latest.json",
    task: "",
  });
  assert.throws(
    () => parseCliArgs(["--output"]),
    /Expected a path after --output/,
  );
});

test("formatRunResult prints readable answer and citations by default", () => {
  const output = formatRunResult(completedRun, { json: false });

  assert.match(output, /Status: completed/);
  assert.match(output, /Stop reason: final_answer/);
  assert.match(output, /Answer:\nSt\. Petersburg is 323 years old\./);
  assert.match(output, /- Britannica: https:\/\/example.com\/britannica/);
  assert.doesNotMatch(output, /observations/);
});

test("formatRunResult prints full JSON when requested", () => {
  const output = formatRunResult(completedRun, { json: true });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "completed");
  assert.deepEqual(parsed.observations, []);
});

test("formatRunResult includes last tool error for failed runs", () => {
  const output = formatRunResult({
    runId: "run_failed",
    status: "failed",
    citations: [],
    observations: [
      {
        step: 1,
        toolName: "searchWeb",
        input: {},
        result: {
          ok: false,
          error: {
            code: "tool_failed",
            message: "fetch failed",
          },
        },
      },
    ],
    trace: [],
    metadata: testRunMetadata({
      modelLatencyMs: 0,
      tokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        source: "estimated",
      },
    }),
    stopReason: "step_limit",
  }, { json: false });

  assert.match(output, /Status: failed/);
  assert.match(output, /Last error:\ntool_failed: fetch failed/);
});

const completedRun: AgentRunResult = {
  runId: "run_1",
  status: "completed",
  answer: "St. Petersburg is 323 years old.",
  citations: [
    {
      title: "Britannica",
      url: "https://example.com/britannica",
    },
  ],
  observations: [],
  trace: [],
  metadata: testRunMetadata(),
  stopReason: "final_answer",
};
