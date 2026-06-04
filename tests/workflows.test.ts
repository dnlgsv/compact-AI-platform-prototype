import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowRegistry } from "../src/workflows.ts";

test("workflow registry resolves named versions and latest version", async () => {
  const registry = createWorkflowRegistry([
    {
      name: "research",
      version: "v1",
      async run() {
        throw new Error("v1 should not be selected.");
      },
    },
    {
      name: "research",
      version: "v2",
      evalSuite: "research-evals",
      async run() {
        return {
          runId: "run_workflow",
          status: "completed",
          answer: "ok",
          citations: [],
          observations: [],
          trace: [],
          metadata: {
            startedAt: "2026-06-04T00:00:00.000Z",
            endedAt: "2026-06-04T00:00:00.001Z",
            totalLatencyMs: 1,
            modelLatencyMs: 0,
            toolLatencyMs: 0,
            modelName: "test",
            promptVersion: "test",
            workflowVersion: "research:v2",
            tokens: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              source: "estimated",
            },
            cost: {
              estimatedUsd: 0,
              source: "not_configured",
            },
          },
          stopReason: "final_answer",
        };
      },
    },
  ]);

  assert.equal(registry.listWorkflows().length, 2);
  assert.equal(registry.getWorkflow("research").version, "v2");
  assert.equal(registry.getWorkflow("research", "v1").version, "v1");
  assert.equal((await registry.getWorkflow("research", "v2").run("task")).answer, "ok");
});

test("workflow registry rejects duplicates", () => {
  const registry = createWorkflowRegistry();
  registry.registerWorkflow({
    name: "research",
    version: "v1",
    async run() {
      throw new Error("unused");
    },
  });

  assert.throws(
    () => registry.registerWorkflow({
      name: "research",
      version: "v1",
      async run() {
        throw new Error("unused");
      },
    }),
    /Workflow already registered: research@v1/,
  );
});
