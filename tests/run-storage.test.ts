import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunResult } from "../src/index.ts";
import { createFileRunStorage } from "../src/run-storage.ts";

test("file run storage saves and reads run artifacts by run id", async () => {
  const storage = createFileRunStorage("runs/test-storage-save-read");

  const saved = await storage.save("Research task", completedRun);
  const restored = await storage.read("run_completed");

  assert.equal(saved.result.runId, "run_completed");
  assert.equal(restored.task, "Research task");
  assert.deepEqual(restored.result, completedRun);
});

test("file run storage lists run summaries newest first", async () => {
  const storage = createFileRunStorage("runs/test-storage-list");

  await storage.save("Older task", {
    ...completedRun,
    runId: "run_older",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await storage.save("Newer task", {
    ...failedRun,
    runId: "run_newer",
  });

  const summaries = await storage.list();

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].runId, "run_newer");
  assert.equal(summaries[0].status, "failed");
  assert.equal(summaries[1].runId, "run_older");
});

test("file run storage rejects unsafe run ids", async () => {
  const storage = createFileRunStorage("runs/test-storage-unsafe");

  await assert.rejects(
    () => storage.read("../secret"),
    /runId must contain only letters, numbers, underscores, or hyphens/,
  );
});

const completedRun: AgentRunResult = {
  runId: "run_completed",
  status: "completed",
  answer: "Grounded answer.",
  citations: [],
  observations: [],
  trace: [],
  stopReason: "final_answer",
};

const failedRun: AgentRunResult = {
  runId: "run_failed",
  status: "failed",
  citations: [],
  observations: [],
  trace: [],
  stopReason: "citation_validation_failed",
};
