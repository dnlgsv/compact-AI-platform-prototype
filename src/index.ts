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

export type AgentRunResult = {
  runId: string;
  status: "completed" | "failed";
  answer?: string;
  citations: Citation[];
  observations: Observation[];
  trace: TraceSpan[];
  stopReason: string;
};

export type AgentConfig = {
  model: ModelAdapter;
  tools: ToolDefinition[];
  policy?: Partial<PermissionPolicy>;
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

  const tools = new Map<string, ToolDefinition>();
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
    async run(task: string): Promise<AgentRunResult> {
      const runId = createRunId();
      const startedAt = Date.now();
      const observations: Observation[] = [];
      const trace: TraceSpan[] = [];

      for (let step = 1; step <= policy.maxSteps; step += 1) {
        if (policy.maxRunMs && Date.now() - startedAt > policy.maxRunMs) {
          return failed(runId, observations, trace, "run_timeout", step);
        }

        let rawAction: unknown;
        try {
          rawAction = await recordSpan(trace, "model.complete", "model", step, async () =>
            config.model.complete({
              task,
              step,
              observations,
              tools: [...tools.values()].map((tool) => ({
                name: tool.name,
                description: tool.description,
                sideEffect: tool.sideEffect ?? "none",
              })),
            }),
          );
        } catch (error) {
          trace.push(createRuntimeErrorSpan(step, "model.failure", "model_failed", errorMessage(error)));
          return failed(runId, observations, trace, "model_failed", step);
        }

        let action: ModelAction;
        try {
          action = validateModelAction(rawAction);
        } catch (error) {
          trace.push(createRuntimeErrorSpan(step, "model.action.validation", "invalid_model_action", errorMessage(error)));
          return failed(runId, observations, trace, "model_action_validation_failed", step);
        }

        if (policy.maxRunMs && Date.now() - startedAt > policy.maxRunMs) {
          return failed(runId, observations, trace, "run_timeout", step);
        }

        if (action.type === "final") {
          const citations = action.citations ?? [];
          const unobservedCitation = policy.requireObservedCitations
            ? findUnobservedCitation(citations, observations)
            : undefined;

          if (unobservedCitation) {
            trace.push(createRuntimeErrorSpan(step, "citation.validation", "unobserved_citation", `Citation URL was not observed: ${unobservedCitation.url}`));
            return failed(runId, observations, trace, "citation_validation_failed", step);
          }

          trace.push(createRuntimeStopSpan(step, "final_answer", "ok"));
          return {
            runId,
            status: "completed",
            answer: action.answer,
            citations,
            observations,
            trace,
            stopReason: "final_answer",
          };
        }

        const observation = await runToolAction({
          action,
          runId,
          step,
          tools,
          policy,
          trace,
        });
        observations.push(observation);
      }

      return failed(runId, observations, trace, "step_limit", policy.maxSteps);
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
    trace.push({
      id: `span_${trace.length + 1}`,
      name,
      kind,
      step,
      startedAt,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      status: "ok",
      attributes,
    });
    return result;
  } catch (error) {
    const ended = Date.now();
    trace.push({
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
    });
    throw error;
  }
}

function failed(
  runId: string,
  observations: Observation[],
  trace: TraceSpan[],
  stopReason: string,
  step: number,
): AgentRunResult {
  trace.push(createRuntimeStopSpan(step, stopReason, "error"));
  return {
    runId,
    status: "failed",
    citations: [],
    observations,
    trace,
    stopReason,
  };
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
