import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { TraceSpan } from "./index.ts";

export type RuntimeMetric = {
  name: string;
  value: number;
  unit: "ms" | "count" | "tokens" | "usd";
  recordedAt: string;
  attributes?: Record<string, unknown>;
};

export type TraceSink = {
  recordSpan(span: TraceSpan): Promise<void>;
  recordMetric(metric: RuntimeMetric): Promise<void>;
};

export type InMemoryTraceSink = TraceSink & {
  spans: TraceSpan[];
  metrics: RuntimeMetric[];
};

export function createInMemoryTraceSink(): InMemoryTraceSink {
  return {
    spans: [],
    metrics: [],
    async recordSpan(span) {
      this.spans.push(span);
    },
    async recordMetric(metric) {
      this.metrics.push(metric);
    },
  };
}

export function createConsoleTraceSink(log: Pick<Console, "log"> = console): TraceSink {
  return {
    async recordSpan(span) {
      log.log(JSON.stringify({ type: "span", span }));
    },
    async recordMetric(metric) {
      log.log(JSON.stringify({ type: "metric", metric }));
    },
  };
}

export function createLocalJsonTraceSink(path = "runs/observability.ndjson"): TraceSink {
  const target = resolveInsideWorkspace(path);

  return {
    async recordSpan(span) {
      await appendJsonLine(target, { type: "span", span });
    },
    async recordMetric(metric) {
      await appendJsonLine(target, { type: "metric", metric });
    },
  };
}

export function createOtelShapedJsonSink(path = "runs/otel.ndjson"): TraceSink {
  const target = resolveInsideWorkspace(path);

  return {
    async recordSpan(span) {
      await appendJsonLine(target, {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: span.attributes?.traceId ?? span.id,
                    spanId: span.id,
                    name: span.name,
                    kind: span.kind,
                    startTimeUnixNano: isoToUnixNano(span.startedAt),
                    endTimeUnixNano: isoToUnixNano(span.endedAt),
                    status: {
                      code: span.status === "ok" ? "STATUS_CODE_OK" : "STATUS_CODE_ERROR",
                      message: span.error?.message,
                    },
                    attributes: toOtelAttributes(span.attributes),
                  },
                ],
              },
            ],
          },
        ],
      });
    },
    async recordMetric(metric) {
      await appendJsonLine(target, {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: metric.name,
                    unit: metric.unit,
                    data: {
                      dataPoints: [
                        {
                          timeUnixNano: isoToUnixNano(metric.recordedAt),
                          asDouble: metric.value,
                          attributes: toOtelAttributes(metric.attributes),
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  };
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function toOtelAttributes(attributes: Record<string, unknown> | undefined) {
  if (!attributes) {
    return [];
  }

  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: toOtelValue(value),
  }));
}

function toOtelValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return { stringValue: JSON.stringify(value) };
}

function isoToUnixNano(value: string): string {
  return `${BigInt(Date.parse(value)) * 1_000_000n}`;
}

function resolveInsideWorkspace(path: string): string {
  const cwd = resolve(".");
  const target = resolve(path);
  if (target !== cwd && !target.startsWith(`${cwd}\\`) && !target.startsWith(`${cwd}/`)) {
    throw new Error("Observability path must stay inside the current workspace.");
  }
  return target;
}
