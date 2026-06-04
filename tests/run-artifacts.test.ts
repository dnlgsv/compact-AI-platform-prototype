import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunResult } from "../src/index.ts";
import {
  createRunArtifact,
  readRunArtifact,
  replayRunArtifact,
  validateRunArtifact,
  writeRunArtifact,
} from "../src/run-artifacts.ts";
import { testRunMetadata } from "./fixtures.ts";

test("createRunArtifact validates and preserves a completed run", () => {
  const artifact = createRunArtifact("Research task", completedRun);

  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.task, "Research task");
  assert.match(artifact.savedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(artifact.result, completedRun);
  assert.equal(replayRunArtifact(artifact).answer, "Grounded answer.");
});

test("writeRunArtifact and readRunArtifact round-trip valid JSON", async () => {
  const artifact = createRunArtifact("Research task", completedRun);
  await writeRunArtifact("runs/test-artifact.json", artifact);

  const restored = await readRunArtifact("runs/test-artifact.json");

  assert.equal(restored.task, "Research task");
  assert.deepEqual(restored.result, completedRun);
});

test("validateRunArtifact rejects malformed artifacts", () => {
  assert.throws(
    () => validateRunArtifact({
      schemaVersion: 1,
      task: "",
      savedAt: "2026-06-03T00:00:00.000Z",
      result: completedRun,
    }),
    /task must be a non-empty string/,
  );

  assert.throws(
    () => validateRunArtifact({
      schemaVersion: 1,
      task: "Research task",
      savedAt: "2026-06-03T00:00:00.000Z",
      result: {
        ...completedRun,
        citations: "bad",
      },
    }),
    /citations must be an array/,
  );
});

test("replayRunArtifact rejects citations missing from saved observations", () => {
  const artifact = createRunArtifact("Research task", {
    ...completedRun,
    citations: [
      {
        title: "Missing",
        url: "https://example.com/missing",
      },
    ],
  });

  assert.throws(
    () => replayRunArtifact(artifact),
    /Replay citation validation failed: https:\/\/example.com\/missing was not observed/,
  );
});

test("failed run artifacts preserve observations and stop reason", () => {
  const artifact = createRunArtifact("Failing task", failedRun);
  const replayed = replayRunArtifact(artifact);

  assert.equal(replayed.status, "failed");
  assert.equal(replayed.stopReason, "step_limit");
  assert.equal(replayed.observations[0].result.ok, false);
});

const completedRun: AgentRunResult = {
  runId: "run_completed",
  status: "completed",
  answer: "Grounded answer.",
  citations: [
    {
      title: "Observed",
      url: "https://example.com/observed",
    },
  ],
  observations: [
    {
      step: 1,
      toolName: "fetchUrl",
      input: {
        url: "https://example.com/observed",
      },
      result: {
        ok: true,
        data: {
          title: "Observed",
        },
      },
      sources: [
        {
          title: "Observed",
          url: "https://example.com/observed",
          fetchedAt: "2026-06-03T00:00:00.000Z",
        },
      ],
    },
  ],
  trace: [
    {
      id: "span_1",
      name: "model.complete",
      kind: "model",
      step: 1,
      startedAt: "2026-06-03T00:00:00.000Z",
      endedAt: "2026-06-03T00:00:00.001Z",
      durationMs: 1,
      status: "ok",
    },
  ],
  metadata: testRunMetadata({
    startedAt: "2026-06-03T00:00:00.000Z",
    endedAt: "2026-06-03T00:00:00.010Z",
  }),
  stopReason: "final_answer",
};

const failedRun: AgentRunResult = {
  runId: "run_failed",
  status: "failed",
  citations: [],
  observations: [
    {
      step: 1,
      toolName: "fetchUrl",
      input: {
        url: "https://example.com/unavailable",
      },
      result: {
        ok: false,
        error: {
          code: "tool_failed",
          message: "Fetch failed with HTTP 503.",
        },
      },
    },
  ],
  trace: [
    {
      id: "span_1",
      name: "tool.fetchUrl",
      kind: "tool",
      step: 1,
      startedAt: "2026-06-03T00:00:00.000Z",
      endedAt: "2026-06-03T00:00:00.001Z",
      durationMs: 1,
      status: "error",
      error: {
        code: "span_failed",
        message: "Fetch failed with HTTP 503.",
      },
    },
  ],
  metadata: testRunMetadata({
    startedAt: "2026-06-03T00:00:00.000Z",
    endedAt: "2026-06-03T00:00:00.010Z",
    modelLatencyMs: 0,
    toolLatencyMs: 1,
  }),
  stopReason: "step_limit",
};
