import type { RunMetadata } from "../src/index.ts";

export function testRunMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    startedAt: "2026-06-04T00:00:00.000Z",
    endedAt: "2026-06-04T00:00:00.010Z",
    totalLatencyMs: 10,
    modelLatencyMs: 1,
    toolLatencyMs: 0,
    modelName: "test-model",
    promptVersion: "test-prompt-v1",
    workflowVersion: "test-workflow:v1",
    tokens: {
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      source: "estimated",
    },
    cost: {
      estimatedUsd: 0,
      source: "not_configured",
    },
    ...overrides,
  };
}
