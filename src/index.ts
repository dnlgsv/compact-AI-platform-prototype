import type { RuntimeMetric, TraceSink } from "./observability.ts";

export type ToolSideEffect = "none" | "local_write" | "external_write" | "process";

export type Citation = {
  title: string;
  url: string;
};

export type Source = {
  title: string;
  url: string;
  fetchedAt?: string;
};

export type ToolSpec = {
  name: string;
  description: string;
  sideEffect: ToolSideEffect;
};

export type ToolContext = {
  runId: string;
  step: number;
  signal: AbortSignal;
};

export type ToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  sideEffect?: ToolSideEffect;
  timeoutMs?: number;
  validateInput: (input: unknown) => Input;
  execute: (input: Input, context: ToolContext) => Output | Promise<Output>;
  summarizeResult?: (output: Output) => unknown;
  extractSources?: (output: Output) => Source[];
};

export type ModelInput = {
  task: string;
  step: number;
  tools: ToolSpec[];
  observations: Observation[];
};

export type ModelAction =
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "final";
      answer: string;
      citations?: Citation[];
    };

export type ModelAdapter = {
  complete: (input: ModelInput) => unknown | Promise<unknown>;
};

export type PermissionPolicy = {
  maxSteps: number;
  maxRunMs?: number;
  allowedSideEffects: ToolSideEffect[];
  requireObservedCitations: boolean;
};

export type Observation = {
  step: number;
  toolName: string;
  input: unknown;
  result:
    | {
        ok: true;
        data: unknown;
      }
    | {
        ok: false;
        error: {
          code: string;
          message: string;
        };
      };
  sources?: Source[];
};

export type TraceSpan = {
  id: string;
  name: string;
  kind: "model" | "tool" | "runtime";
  step: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "estimated" | "reported";
};

export type RunCost = {
  estimatedUsd: number;
  source: "estimated" | "not_configured";
};

export type RunMetadata = {
  startedAt: string;
  endedAt: string;
  totalLatencyMs: number;
  modelLatencyMs: number;
  toolLatencyMs: number;
  modelName: string;
  promptVersion: string;
  workflowVersion: string;
  tokens: TokenUsage;
  cost: RunCost;
};

export type AgentRunResult = {
  runId: string;
  status: "completed" | "failed";
  answer?: string;
  citations: Citation[];
  observations: Observation[];
  trace: TraceSpan[];
  metadata: RunMetadata;
  stopReason: string;
};

export type TokenPricing = {
  promptUsdPer1MTokens: number;
  completionUsdPer1MTokens: number;
};

export type AgentConfig = {
  model: ModelAdapter;
  tools: ToolDefinition<any, any>[];
  policy?: Partial<PermissionPolicy>;
  traceSink?: TraceSink;
  metadata?: {
    modelName?: string;
    promptVersion?: string;
    workflowVersion?: string;
    tokenPricing?: TokenPricing;
  };
};

export type AgentRunOptions = {
  runId?: string;
};

const DEFAULT_POLICY: PermissionPolicy = {
  maxSteps: 8,
  allowedSideEffects: ["none"],
  requireObservedCitations: false,
};

export function defineTool<Input, Output>(
  definition: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return definition;
}

export function createAgent(config: AgentConfig) {
  const policy = {
    ...DEFAULT_POLICY,
    ...config.policy,
    allowedSideEffects:
      config.policy?.allowedSideEffects ?? DEFAULT_POLICY.allowedSideEffects,
  };

  const tools = new Map<string, ToolDefinition<any, any>>();
  for (const tool of config.tools) {
    if (tools.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    tools.set(tool.name, {
      ...tool,
      sideEffect: tool.sideEffect ?? "none",
    });
  }

  return {
    async run(task: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
      const runId = options.runId ?? createRunId();
      const startedAt = Date.now();
      const runStartedAt = new Date(startedAt).toISOString();
      const observations: Observation[] = [];
      const trace: TraceSpan[] = [];
      const tokenUsage: TokenUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        source: "estimated",
      };

      for (let step = 1; step <= policy.maxSteps; step += 1) {
        if (policy.maxRunMs && Date.now() - startedAt > policy.maxRunMs) {
          return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "run_timeout", step);
        }

        let rawAction: unknown;
        const modelInput = {
          task,
          step,
          observations,
          tools: [...tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            sideEffect: tool.sideEffect ?? "none",
          })),
        };
        try {
          rawAction = await recordSpan(
            trace,
            config.traceSink,
            "model.complete",
            "model",
            step,
            async () => config.model.complete(modelInput),
            {
              modelName: config.metadata?.modelName ?? "unknown",
              promptVersion: config.metadata?.promptVersion ?? "unknown",
            },
          );
          addTokenEstimate(tokenUsage, modelInput, rawAction);
        } catch (error) {
          await pushSpan(trace, config.traceSink, createRuntimeErrorSpan(step, "model.failure", "model_failed", errorMessage(error)));
          return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "model_failed", step);
        }

        let action: ModelAction;
        try {
          action = validateModelAction(rawAction);
        } catch (error) {
          await pushSpan(trace, config.traceSink, createRuntimeErrorSpan(step, "model.action.validation", "invalid_model_action", errorMessage(error)));
          return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "model_action_validation_failed", step);
        }

        if (policy.maxRunMs && Date.now() - startedAt > policy.maxRunMs) {
          return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "run_timeout", step);
        }

        if (action.type === "final") {
          const citations = action.citations ?? [];
          const unobservedCitation = policy.requireObservedCitations
            ? findUnobservedCitation(citations, observations)
            : undefined;

          if (unobservedCitation) {
            await pushSpan(trace, config.traceSink, createRuntimeErrorSpan(step, "citation.validation", "unobserved_citation", `Citation URL was not observed: ${unobservedCitation.url}`));
            return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "citation_validation_failed", step);
          }

          await pushSpan(trace, config.traceSink, createRuntimeStopSpan(step, "final_answer", "ok"));
          const result = {
            runId,
            status: "completed",
            answer: action.answer,
            citations,
            observations,
            trace,
            metadata: createRunMetadata(trace, tokenUsage, runStartedAt, startedAt, config),
            stopReason: "final_answer",
          } satisfies AgentRunResult;
          await recordRunMetrics(config.traceSink, result);
          return result;
        }

        const observation = await runToolAction({
          action,
          runId,
          step,
          tools,
          policy,
          trace,
          traceSink: config.traceSink,
        });
        observations.push(observation);
      }

      return failed(runId, observations, trace, tokenUsage, runStartedAt, startedAt, config, "step_limit", policy.maxSteps);
    },
  };
}

async function runToolAction(args: {
  action: Extract<ModelAction, { type: "tool_call" }>;
  runId: string;
  step: number;
  tools: Map<string, ToolDefinition>;
  policy: PermissionPolicy;
  trace: TraceSpan[];
  traceSink?: TraceSink;
}): Promise<Observation> {
  const tool = args.tools.get(args.action.toolName);
  if (!tool) {
    return toolError(args.step, args.action.toolName, args.action.input, "tool_not_found", "Tool is not registered.");
  }

  const sideEffect = tool.sideEffect ?? "none";
  if (!args.policy.allowedSideEffects.includes(sideEffect)) {
    return toolError(
      args.step,
      tool.name,
      args.action.input,
      "permission_denied",
      `Tool side effect "${sideEffect}" is not allowed by policy.`,
    );
  }

  let input: unknown;
  try {
    input = tool.validateInput(args.action.input);
  } catch (error) {
    return toolError(args.step, tool.name, args.action.input, "invalid_tool_input", errorMessage(error));
  }

  try {
    const data = await recordSpan(
      args.trace,
      args.traceSink,
      `tool.${tool.name}`,
      "tool",
      args.step,
      () => executeWithTimeout(tool, input, args.runId, args.step),
      {
        toolName: tool.name,
        sideEffect,
        input: redact(input),
      },
    );

    return {
      step: args.step,
      toolName: tool.name,
      input: redact(input),
      result: {
        ok: true,
        data: tool.summarizeResult ? tool.summarizeResult(data) : redact(data),
      },
      sources: tool.extractSources ? tool.extractSources(data) : undefined,
    };
  } catch (error) {
    return toolError(args.step, tool.name, input, "tool_failed", errorMessage(error));
  }
}

async function executeWithTimeout(
  tool: ToolDefinition,
  input: unknown,
  runId: string,
  step: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = tool.timeoutMs ?? 10_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      tool.execute(input, {
        runId,
        step,
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error(`Tool timed out after ${timeoutMs}ms.`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function recordSpan<T>(
  trace: TraceSpan[],
  traceSink: TraceSink | undefined,
  name: string,
  kind: TraceSpan["kind"],
  step: number,
  fn: () => T | Promise<T>,
  attributes?: Record<string, unknown>,
): Promise<T> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  try {
    const result = await fn();
    const ended = Date.now();
    const span = {
      id: `span_${trace.length + 1}`,
      name,
      kind,
      step,
      startedAt,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      status: "ok",
      attributes,
    } satisfies TraceSpan;
    await pushSpan(trace, traceSink, span);
    return result;
  } catch (error) {
    const ended = Date.now();
    const span = {
      id: `span_${trace.length + 1}`,
      name,
      kind,
      step,
      startedAt,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      status: "error",
      attributes,
      error: {
        code: "span_failed",
        message: errorMessage(error),
      },
    } satisfies TraceSpan;
    await pushSpan(trace, traceSink, span);
    throw error;
  }
}

async function failed(
  runId: string,
  observations: Observation[],
  trace: TraceSpan[],
  tokenUsage: TokenUsage,
  runStartedAt: string,
  startedAt: number,
  config: AgentConfig,
  stopReason: string,
  step: number,
): Promise<AgentRunResult> {
  await pushSpan(trace, config.traceSink, createRuntimeStopSpan(step, stopReason, "error"));
  const result = {
    runId,
    status: "failed",
    citations: [],
    observations,
    trace,
    metadata: createRunMetadata(trace, tokenUsage, runStartedAt, startedAt, config),
    stopReason,
  } satisfies AgentRunResult;
  await recordRunMetrics(config.traceSink, result);
  return result;
}

async function pushSpan(trace: TraceSpan[], traceSink: TraceSink | undefined, span: TraceSpan): Promise<void> {
  trace.push(span);
  if (!traceSink) {
    return;
  }

  try {
    await traceSink.recordSpan(span);
  } catch {
    // Observability failures should not change agent behavior.
  }
}

async function recordRunMetrics(traceSink: TraceSink | undefined, result: AgentRunResult): Promise<void> {
  if (!traceSink) {
    return;
  }

  const metrics: RuntimeMetric[] = [
    metric("runtime.run.latency_ms", result.metadata.totalLatencyMs, "ms", result),
    metric("runtime.model.latency_ms", result.metadata.modelLatencyMs, "ms", result),
    metric("runtime.tool.latency_ms", result.metadata.toolLatencyMs, "ms", result),
    metric("runtime.tokens.total", result.metadata.tokens.totalTokens, "tokens", result),
    metric("runtime.cost.estimated_usd", result.metadata.cost.estimatedUsd, "usd", result),
  ];

  for (const item of metrics) {
    try {
      await traceSink.recordMetric(item);
    } catch {
      // Observability failures should not change agent behavior.
    }
  }
}

function metric(
  name: string,
  value: number,
  unit: RuntimeMetric["unit"],
  result: AgentRunResult,
): RuntimeMetric {
  return {
    name,
    value,
    unit,
    recordedAt: result.metadata.endedAt,
    attributes: {
      runId: result.runId,
      status: result.status,
      stopReason: result.stopReason,
      modelName: result.metadata.modelName,
      promptVersion: result.metadata.promptVersion,
      workflowVersion: result.metadata.workflowVersion,
    },
  };
}

function addTokenEstimate(tokenUsage: TokenUsage, modelInput: ModelInput, rawAction: unknown): void {
  tokenUsage.promptTokens += estimateTokens(modelInput);
  tokenUsage.completionTokens += estimateTokens(rawAction);
  tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens;
}

function createRunMetadata(
  trace: TraceSpan[],
  tokenUsage: TokenUsage,
  runStartedAt: string,
  startedAt: number,
  config: AgentConfig,
): RunMetadata {
  const endedAt = new Date().toISOString();
  const modelLatencyMs = sumSpanDuration(trace, "model");
  const toolLatencyMs = sumSpanDuration(trace, "tool");
  return {
    startedAt: runStartedAt,
    endedAt,
    totalLatencyMs: Date.now() - startedAt,
    modelLatencyMs,
    toolLatencyMs,
    modelName: config.metadata?.modelName ?? "unknown",
    promptVersion: config.metadata?.promptVersion ?? "unknown",
    workflowVersion: config.metadata?.workflowVersion ?? "unknown",
    tokens: {
      ...tokenUsage,
    },
    cost: estimateCost(tokenUsage, config.metadata?.tokenPricing),
  };
}

function sumSpanDuration(trace: TraceSpan[], kind: TraceSpan["kind"]): number {
  return trace
    .filter((span) => span.kind === kind)
    .reduce((total, span) => total + span.durationMs, 0);
}

function estimateTokens(value: unknown): number {
  const raw = JSON.stringify(value) ?? String(value);
  return Math.max(1, Math.ceil(raw.length / 4));
}

function estimateCost(tokenUsage: TokenUsage, pricing: TokenPricing | undefined): RunCost {
  if (!pricing) {
    return {
      estimatedUsd: 0,
      source: "not_configured",
    };
  }

  return {
    estimatedUsd: roundUsd(
      (tokenUsage.promptTokens / 1_000_000) * pricing.promptUsdPer1MTokens +
      (tokenUsage.completionTokens / 1_000_000) * pricing.completionUsdPer1MTokens,
    ),
    source: "estimated",
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toolError(
  step: number,
  toolName: string,
  input: unknown,
  code: string,
  message: string,
): Observation {
  return {
    step,
    toolName,
    input: redact(input),
    result: {
      ok: false,
      error: {
        code,
        message,
      },
    },
  };
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function findUnobservedCitation(citations: Citation[], observations: Observation[]): Citation | undefined {
  const observedUrls = new Set(
    observations.flatMap((observation) => observation.sources?.map((source) => source.url) ?? []),
  );
  return citations.find((citation) => !observedUrls.has(citation.url));
}

function createRuntimeErrorSpan(
  step: number,
  name: string,
  code: string,
  message: string,
): TraceSpan {
  const now = new Date().toISOString();
  return {
    id: `span_runtime_${step}`,
    name,
    kind: "runtime",
    step,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    status: "error",
    error: {
      code,
      message,
    },
  };
}

function createRuntimeStopSpan(
  step: number,
  stopReason: string,
  status: TraceSpan["status"],
): TraceSpan {
  const now = new Date().toISOString();
  return {
    id: `span_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: "run.stop",
    kind: "runtime",
    step,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    status,
    attributes: {
      stopReason,
    },
  };
}

function validateModelAction(action: unknown): ModelAction {
  if (!action || typeof action !== "object") {
    throw new Error("Model action must be an object.");
  }

  const candidate = action as { type?: unknown; toolName?: unknown; input?: unknown; answer?: unknown; citations?: unknown };
  if (candidate.type === "tool_call") {
    if (typeof candidate.toolName !== "string" || candidate.toolName.length === 0) {
      throw new Error("Tool call action must include toolName:string.");
    }
    return {
      type: "tool_call",
      toolName: candidate.toolName,
      input: candidate.input,
    };
  }

  if (candidate.type === "final") {
    if (typeof candidate.answer !== "string") {
      throw new Error("Final action must include answer:string.");
    }
    if (candidate.citations !== undefined && !Array.isArray(candidate.citations)) {
      throw new Error("Final action citations must be an array when present.");
    }
    return {
      type: "final",
      answer: candidate.answer,
      citations: candidate.citations?.map(validateCitation),
    };
  }

  throw new Error("Model action type must be tool_call or final.");
}

function validateCitation(value: unknown): Citation {
  const candidate = value as { title?: unknown; url?: unknown };
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Citation must be an object.");
  }
  if (typeof candidate.title !== "string" || candidate.title.length === 0) {
    throw new Error("Citation must include title:string.");
  }
  if (typeof candidate.url !== "string" || candidate.url.length === 0) {
    throw new Error("Citation must include url:string.");
  }
  return {
    title: candidate.title,
    url: candidate.url,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/api[_-]?key|token|secret|password/i.test(key)) {
        return [key, "[redacted]"];
      }
      return [key, redact(item)];
    }),
  );
}
