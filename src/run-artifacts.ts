import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AgentRunResult, Citation, Observation, Source, TraceSpan } from "./index.ts";

export type RunArtifact = {
  schemaVersion: 1;
  task: string;
  savedAt: string;
  result: AgentRunResult;
};

export function createRunArtifact(task: string, result: AgentRunResult): RunArtifact {
  const artifact = {
    schemaVersion: 1,
    task,
    savedAt: new Date().toISOString(),
    result,
  } satisfies RunArtifact;
  validateRunArtifact(artifact);
  return artifact;
}

export async function writeRunArtifact(path: string, artifact: RunArtifact): Promise<void> {
  validateRunArtifact(artifact);
  const target = resolveInsideWorkspace(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function readRunArtifact(path: string): Promise<RunArtifact> {
  const artifact = JSON.parse(await readFile(resolveInsideWorkspace(path), "utf8"));
  return validateRunArtifact(artifact);
}

export function replayRunArtifact(artifact: RunArtifact): AgentRunResult {
  validateRunArtifact(artifact);
  const unobservedCitation = findUnobservedCitation(artifact.result.citations, artifact.result.observations);
  if (unobservedCitation) {
    throw new Error(`Replay citation validation failed: ${unobservedCitation.url} was not observed.`);
  }
  return artifact.result;
}

export function validateRunArtifact(value: unknown): RunArtifact {
  const artifact = value as RunArtifact;
  if (!artifact || typeof artifact !== "object") {
    throw new Error("Run artifact must be an object.");
  }
  if (artifact.schemaVersion !== 1) {
    throw new Error("Run artifact schemaVersion must be 1.");
  }
  if (typeof artifact.task !== "string" || artifact.task.trim() === "") {
    throw new Error("Run artifact task must be a non-empty string.");
  }
  if (!isIsoDate(artifact.savedAt)) {
    throw new Error("Run artifact savedAt must be an ISO timestamp.");
  }

  validateRunResult(artifact.result);
  return artifact;
}

function validateRunResult(result: AgentRunResult): void {
  if (!result || typeof result !== "object") {
    throw new Error("Run artifact result must be an object.");
  }
  if (typeof result.runId !== "string" || result.runId.length === 0) {
    throw new Error("Run result runId must be a non-empty string.");
  }
  if (result.status !== "completed" && result.status !== "failed") {
    throw new Error("Run result status must be completed or failed.");
  }
  if (result.answer !== undefined && typeof result.answer !== "string") {
    throw new Error("Run result answer must be a string when present.");
  }
  if (!Array.isArray(result.citations)) {
    throw new Error("Run result citations must be an array.");
  }
  for (const citation of result.citations) {
    validateCitation(citation);
  }
  if (!Array.isArray(result.observations)) {
    throw new Error("Run result observations must be an array.");
  }
  for (const observation of result.observations) {
    validateObservation(observation);
  }
  if (!Array.isArray(result.trace)) {
    throw new Error("Run result trace must be an array.");
  }
  for (const span of result.trace) {
    validateTraceSpan(span);
  }
  if (typeof result.stopReason !== "string" || result.stopReason.length === 0) {
    throw new Error("Run result stopReason must be a non-empty string.");
  }
}

function validateCitation(citation: Citation): void {
  if (!citation || typeof citation !== "object") {
    throw new Error("Citation must be an object.");
  }
  if (typeof citation.title !== "string" || citation.title.length === 0) {
    throw new Error("Citation title must be a non-empty string.");
  }
  if (typeof citation.url !== "string" || citation.url.length === 0) {
    throw new Error("Citation url must be a non-empty string.");
  }
}

function validateObservation(observation: Observation): void {
  if (!Number.isInteger(observation.step) || observation.step < 1) {
    throw new Error("Observation step must be a positive integer.");
  }
  if (typeof observation.toolName !== "string" || observation.toolName.length === 0) {
    throw new Error("Observation toolName must be a non-empty string.");
  }
  if (!observation.result || typeof observation.result !== "object") {
    throw new Error("Observation result must be an object.");
  }
  if (observation.result.ok === true) {
    if (!("data" in observation.result)) {
      throw new Error("Successful observation result must include data.");
    }
  } else if (observation.result.ok === false) {
    if (
      !observation.result.error ||
      typeof observation.result.error.code !== "string" ||
      typeof observation.result.error.message !== "string"
    ) {
      throw new Error("Failed observation result must include error code and message.");
    }
  } else {
    throw new Error("Observation result ok must be boolean.");
  }

  if (observation.sources !== undefined) {
    if (!Array.isArray(observation.sources)) {
      throw new Error("Observation sources must be an array when present.");
    }
    for (const source of observation.sources) {
      validateSource(source);
    }
  }
}

function validateSource(source: Source): void {
  if (!source || typeof source !== "object") {
    throw new Error("Source must be an object.");
  }
  if (typeof source.title !== "string" || source.title.length === 0) {
    throw new Error("Source title must be a non-empty string.");
  }
  if (typeof source.url !== "string" || source.url.length === 0) {
    throw new Error("Source url must be a non-empty string.");
  }
  if (source.fetchedAt !== undefined && !isIsoDate(source.fetchedAt)) {
    throw new Error("Source fetchedAt must be an ISO timestamp when present.");
  }
}

function validateTraceSpan(span: TraceSpan): void {
  if (typeof span.id !== "string" || span.id.length === 0) {
    throw new Error("Trace span id must be a non-empty string.");
  }
  if (typeof span.name !== "string" || span.name.length === 0) {
    throw new Error("Trace span name must be a non-empty string.");
  }
  if (span.kind !== "model" && span.kind !== "tool" && span.kind !== "runtime") {
    throw new Error("Trace span kind is invalid.");
  }
  if (!Number.isInteger(span.step) || span.step < 1) {
    throw new Error("Trace span step must be a positive integer.");
  }
  if (!isIsoDate(span.startedAt) || !isIsoDate(span.endedAt)) {
    throw new Error("Trace span timestamps must be ISO timestamps.");
  }
  if (!Number.isFinite(span.durationMs) || span.durationMs < 0) {
    throw new Error("Trace span durationMs must be a non-negative number.");
  }
  if (span.status !== "ok" && span.status !== "error") {
    throw new Error("Trace span status must be ok or error.");
  }
}

function findUnobservedCitation(citations: Citation[], observations: Observation[]): Citation | undefined {
  const observedUrls = new Set(
    observations.flatMap((observation) => observation.sources?.map((source) => source.url) ?? []),
  );
  return citations.find((citation) => !observedUrls.has(citation.url));
}

function resolveInsideWorkspace(path: string): string {
  const cwd = resolve(".");
  const target = resolve(path);
  if (target !== cwd && !target.startsWith(`${cwd}\\`) && !target.startsWith(`${cwd}/`)) {
    throw new Error("Artifact path must stay inside the current workspace.");
  }
  return target;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}
