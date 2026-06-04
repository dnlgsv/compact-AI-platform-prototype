import type { AgentRunResult } from "../src/index.ts";
import { createFileRunStorage } from "../src/run-storage.ts";

const storage = createFileRunStorage();
const result: AgentRunResult = {
  runId: "demo_research_run",
  status: "completed",
  answer: "Demo answer grounded in the saved source.",
  citations: [
    {
      title: "Demo Source",
      url: "https://example.com/demo-source",
    },
  ],
  observations: [
    {
      step: 1,
      toolName: "searchWeb",
      input: {
        query: "demo research task",
        maxResults: 1,
      },
      result: {
        ok: true,
        data: [
          {
            title: "Demo Source",
            url: "https://example.com/demo-source",
          },
        ],
      },
      sources: [
        {
          title: "Demo Source",
          url: "https://example.com/demo-source",
        },
      ],
    },
    {
      step: 2,
      toolName: "fetchUrl",
      input: {
        url: "https://example.com/demo-source",
        maxChars: 8000,
      },
      result: {
        ok: true,
        data: {
          title: "Demo Source",
          url: "https://example.com/demo-source",
          status: 200,
          contentType: "text/html",
          fetchedAt: "2026-06-04T00:00:00.000Z",
          text: "Demo source text.",
        },
      },
      sources: [
        {
          title: "Demo Source",
          url: "https://example.com/demo-source",
          fetchedAt: "2026-06-04T00:00:00.000Z",
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
      startedAt: "2026-06-04T00:00:00.000Z",
      endedAt: "2026-06-04T00:00:00.001Z",
      durationMs: 1,
      status: "ok",
    },
    {
      id: "span_2",
      name: "tool.searchWeb",
      kind: "tool",
      step: 1,
      startedAt: "2026-06-04T00:00:00.001Z",
      endedAt: "2026-06-04T00:00:00.002Z",
      durationMs: 1,
      status: "ok",
    },
    {
      id: "span_3",
      name: "run.stop",
      kind: "runtime",
      step: 3,
      startedAt: "2026-06-04T00:00:00.003Z",
      endedAt: "2026-06-04T00:00:00.003Z",
      durationMs: 0,
      status: "ok",
      attributes: {
        stopReason: "final_answer",
      },
    },
  ],
  metadata: {
    startedAt: "2026-06-04T00:00:00.000Z",
    endedAt: "2026-06-04T00:00:00.003Z",
    totalLatencyMs: 3,
    modelLatencyMs: 1,
    toolLatencyMs: 1,
    modelName: "offline-demo",
    promptVersion: "research-v1",
    workflowVersion: "research:v1",
    tokens: {
      promptTokens: 120,
      completionTokens: 24,
      totalTokens: 144,
      source: "estimated",
    },
    cost: {
      estimatedUsd: 0,
      source: "not_configured",
    },
  },
  stopReason: "final_answer",
};

await storage.save("Demo research task", result);

console.log("Created runs/demo_research_run.json");
console.log("");
console.log("Replay it:");
console.log("npm.cmd run research -- --replay runs/demo_research_run.json");
console.log("");
console.log("Inspect it in the dashboard:");
console.log("npm.cmd run api");
console.log("Open http://127.0.0.1:3000/");
