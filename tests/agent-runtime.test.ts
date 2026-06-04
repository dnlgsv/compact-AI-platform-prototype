import assert from "node:assert/strict";
import test from "node:test";
import { createAgent, defineTool, type ModelAction } from "../src/index.ts";
import { createInMemoryTraceSink } from "../src/observability.ts";

const echoTool = defineTool({
  name: "echo",
  description: "Returns the provided text.",
  validateInput(input: unknown) {
    if (!input || typeof input !== "object" || typeof (input as { text?: unknown }).text !== "string") {
      throw new Error("Expected input.text to be a string.");
    }
    return input as { text: string; apiKey?: string };
  },
  execute(input) {
    return {
      text: input.text,
      apiKey: input.apiKey,
    };
  },
});

test("returns a final answer without tool calls", async () => {
  const agent = createAgent({
    tools: [echoTool],
    model: {
      complete() {
        return {
          type: "final",
          answer: "done",
        };
      },
    },
  });

  const result = await agent.run("Say done");

  assert.equal(result.status, "completed");
  assert.equal(result.answer, "done");
  assert.equal(result.stopReason, "final_answer");
  assert.equal(result.trace.length, 2);
  assert.equal(result.trace.at(-1)?.name, "run.stop");
  assert.deepEqual(result.trace.at(-1)?.attributes, {
    stopReason: "final_answer",
  });
  assert.equal(result.observations.length, 0);
});

test("records run metadata and observability sink output", async () => {
  const traceSink = createInMemoryTraceSink();
  const agent = createAgent({
    tools: [echoTool],
    traceSink,
    metadata: {
      modelName: "test-model",
      promptVersion: "prompt-v2",
      workflowVersion: "workflow-v3",
      tokenPricing: {
        promptUsdPer1MTokens: 1,
        completionUsdPer1MTokens: 2,
      },
    },
    model: {
      complete() {
        return {
          type: "final",
          answer: "done",
        };
      },
    },
  });

  const result = await agent.run("Say done", { runId: "run_metadata" });

  assert.equal(result.runId, "run_metadata");
  assert.equal(result.metadata.modelName, "test-model");
  assert.equal(result.metadata.promptVersion, "prompt-v2");
  assert.equal(result.metadata.workflowVersion, "workflow-v3");
  assert.ok(result.metadata.totalLatencyMs >= result.metadata.modelLatencyMs);
  assert.ok(result.metadata.tokens.promptTokens > 0);
  assert.ok(result.metadata.tokens.completionTokens > 0);
  assert.equal(result.metadata.tokens.totalTokens, result.metadata.tokens.promptTokens + result.metadata.tokens.completionTokens);
  assert.equal(result.metadata.cost.source, "estimated");
  assert.ok(traceSink.spans.some((span) => span.name === "model.complete"));
  assert.ok(traceSink.metrics.some((metric) => metric.name === "runtime.run.latency_ms"));
  assert.ok(traceSink.metrics.some((metric) => metric.name === "runtime.tokens.total"));
});

test("executes one validated tool call per step and records an observation", async () => {
  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "echo",
      input: {
        text: "hello",
        apiKey: "secret-value",
      },
    },
    {
      type: "final",
      answer: "The tool said hello.",
      citations: [
        {
          title: "Example",
          url: "https://example.com",
        },
      ],
    },
  ];

  const agent = createAgent({
    tools: [echoTool],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Echo hello");

  assert.equal(result.status, "completed");
  assert.equal(result.answer, "The tool said hello.");
  assert.equal(result.citations.length, 1);
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0].input, {
    text: "hello",
    apiKey: "[redacted]",
  });
  assert.deepEqual(result.observations[0].result, {
    ok: true,
    data: {
      text: "hello",
      apiKey: "[redacted]",
    },
  });
  assert.deepEqual(
    result.trace.map((span) => span.name),
    ["model.complete", "tool.echo", "model.complete", "run.stop"],
  );
});

test("turns invalid tool input into a structured observation", async () => {
  const agent = createAgent({
    tools: [echoTool],
    policy: {
      maxSteps: 1,
    },
    model: {
      complete() {
        return {
          type: "tool_call",
          toolName: "echo",
          input: {
            text: 42,
          },
        };
      },
    },
  });

  const result = await agent.run("Echo bad input");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_limit");
  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0].result, {
    ok: false,
    error: {
      code: "invalid_tool_input",
      message: "Expected input.text to be a string.",
    },
  });
});

test("denies side effects not allowed by policy", async () => {
  const writeTool = defineTool({
    name: "writeFile",
    description: "Writes local files.",
    sideEffect: "local_write",
    validateInput(input: unknown) {
      return input;
    },
    execute(): unknown {
      throw new Error("Should not execute.");
    },
  });

  const agent = createAgent({
    tools: [writeTool],
    policy: {
      maxSteps: 1,
      allowedSideEffects: ["none"],
    },
    model: {
      complete() {
        return {
          type: "tool_call",
          toolName: "writeFile",
          input: {
            path: "x",
          },
        };
      },
    },
  });

  const result = await agent.run("Write a file");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_limit");
  assert.deepEqual(result.observations[0].result, {
    ok: false,
    error: {
      code: "permission_denied",
      message: 'Tool side effect "local_write" is not allowed by policy.',
    },
  });
});

test("fails when final citations were not observed", async () => {
  const sourceTool = defineTool({
    name: "source",
    description: "Returns a source.",
    validateInput(input: unknown) {
      return input;
    },
    execute() {
      return {
        title: "Observed",
        url: "https://example.com/observed",
      };
    },
    extractSources(output) {
      return [output];
    },
  });

  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "source",
      input: {},
    },
    {
      type: "final",
      answer: "Unsupported claim.",
      citations: [
        {
          title: "Not observed",
          url: "https://example.com/not-observed",
        },
      ],
    },
  ];

  const agent = createAgent({
    tools: [sourceTool],
    policy: {
      requireObservedCitations: true,
    },
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Cite something");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "citation_validation_failed");
  assert.equal(result.trace.at(-2)?.name, "citation.validation");
  assert.equal(result.trace.at(-1)?.name, "run.stop");
});

test("fails deliberately when model returns a malformed action", async () => {
  const agent = createAgent({
    tools: [echoTool],
    model: {
      complete() {
        return {
          type: "tool_call",
          input: {
            text: "hello",
          },
        };
      },
    },
  });

  const result = await agent.run("Return malformed action");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "model_action_validation_failed");
  assert.equal(result.trace.at(-2)?.name, "model.action.validation");
  assert.deepEqual(result.trace.at(-2)?.error, {
    code: "invalid_model_action",
    message: "Tool call action must include toolName:string.",
  });
  assert.deepEqual(result.trace.at(-1)?.attributes, {
    stopReason: "model_action_validation_failed",
  });
});

test("fails deliberately when final model action has invalid shape", async () => {
  const agent = createAgent({
    tools: [echoTool],
    model: {
      complete() {
        return {
          type: "final",
          answer: 42,
        };
      },
    },
  });

  const result = await agent.run("Return malformed final action");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "model_action_validation_failed");
  assert.equal(result.trace.at(-2)?.error?.message, "Final action must include answer:string.");
});

test("turns model adapter errors into failed runs", async () => {
  const agent = createAgent({
    tools: [echoTool],
    model: {
      complete() {
        throw new Error("model unavailable");
      },
    },
  });

  const result = await agent.run("Model fails");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "model_failed");
  assert.equal(result.trace.at(-2)?.name, "model.failure");
  assert.equal(result.trace.at(-2)?.error?.code, "model_failed");
});

test("enforces max run duration after model calls", async () => {
  const agent = createAgent({
    tools: [echoTool],
    policy: {
      maxRunMs: 1,
    },
    model: {
      async complete() {
        await delay(20);
        return {
          type: "final",
          answer: "too late",
        };
      },
    },
  });

  const result = await agent.run("Timeout");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "run_timeout");
  assert.deepEqual(result.trace.at(-1)?.attributes, {
    stopReason: "run_timeout",
  });
});

test("records tool timeout as a structured failed observation", async () => {
  const slowTool = defineTool({
    name: "slow",
    description: "Never finishes.",
    timeoutMs: 1,
    validateInput(input: unknown) {
      return input;
    },
    async execute() {
      await new Promise(() => {});
    },
  });

  const agent = createAgent({
    tools: [slowTool],
    policy: {
      maxSteps: 1,
    },
    model: {
      complete() {
        return {
          type: "tool_call",
          toolName: "slow",
          input: {},
        };
      },
    },
  });

  const result = await agent.run("Slow tool");

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_limit");
  assert.deepEqual(result.observations[0].result, {
    ok: false,
    error: {
      code: "tool_failed",
      message: "Tool timed out after 1ms.",
    },
  });
  assert.equal(result.trace.find((span) => span.name === "tool.slow")?.status, "error");
});

test("redacts nested secrets in tool inputs and outputs", async () => {
  const secretTool = defineTool({
    name: "secret",
    description: "Returns nested secrets.",
    validateInput(input: unknown) {
      return input;
    },
    execute(input) {
      return {
        input,
        nested: {
          token: "output-token",
          values: [
            {
              password: "output-password",
            },
          ],
        },
      };
    },
  });

  const actions: ModelAction[] = [
    {
      type: "tool_call",
      toolName: "secret",
      input: {
        apiKey: "input-key",
        nested: {
          token: "input-token",
          values: [
            {
              password: "input-password",
            },
          ],
        },
      },
    },
    {
      type: "final",
      answer: "done",
    },
  ];

  const agent = createAgent({
    tools: [secretTool],
    model: {
      complete() {
        const action = actions.shift();
        assert.ok(action);
        return action;
      },
    },
  });

  const result = await agent.run("Redact nested secrets");

  assert.equal(result.status, "completed");
  assert.deepEqual(result.observations[0].input, {
    apiKey: "[redacted]",
    nested: {
      token: "[redacted]",
      values: [
        {
          password: "[redacted]",
        },
      ],
    },
  });
  assert.deepEqual(result.observations[0].result, {
    ok: true,
    data: {
      input: {
        apiKey: "[redacted]",
        nested: {
          token: "[redacted]",
          values: [
            {
              password: "[redacted]",
            },
          ],
        },
      },
      nested: {
        token: "[redacted]",
        values: [
          {
            password: "[redacted]",
          },
        ],
      },
    },
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
