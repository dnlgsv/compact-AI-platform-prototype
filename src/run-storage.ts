import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentRunResult } from "./index.ts";
import {
  createRunArtifact,
  type RunArtifact,
  validateRunArtifact,
} from "./run-artifacts.ts";

export type RunStorage = {
  save(task: string, result: AgentRunResult): Promise<RunArtifact>;
  read(runId: string): Promise<RunArtifact>;
  list(): Promise<RunArtifactSummary[]>;
};

export type RunArtifactSummary = {
  runId: string;
  task: string;
  status: AgentRunResult["status"];
  stopReason: string;
  savedAt: string;
};

export function createFileRunStorage(root = "runs"): RunStorage {
  const rootPath = resolveInsideWorkspace(root);

  return {
    async save(task, result) {
      const artifact = createRunArtifact(task, result);
      await mkdir(rootPath, { recursive: true });
      await writeFile(pathForRun(rootPath, result.runId), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      return artifact;
    },

    async read(runId) {
      validateRunId(runId);
      const raw = await readFile(pathForRun(rootPath, runId), "utf8");
      return validateRunArtifact(JSON.parse(raw));
    },

    async list() {
      await mkdir(rootPath, { recursive: true });
      const names = await readdir(rootPath);
      const artifacts = await Promise.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => validateRunArtifact(JSON.parse(await readFile(join(rootPath, name), "utf8")))),
      );

      return artifacts
        .map((artifact) => ({
          runId: artifact.result.runId,
          task: artifact.task,
          status: artifact.result.status,
          stopReason: artifact.result.stopReason,
          savedAt: artifact.savedAt,
        }))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
  };
}

function pathForRun(rootPath: string, runId: string): string {
  validateRunId(runId);
  return join(rootPath, `${runId}.json`);
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("runId must contain only letters, numbers, underscores, or hyphens.");
  }
}

function resolveInsideWorkspace(path: string): string {
  const cwd = resolve(".");
  const target = resolve(path);
  if (target !== cwd && !target.startsWith(`${cwd}\\`) && !target.startsWith(`${cwd}/`)) {
    throw new Error("Storage path must stay inside the current workspace.");
  }
  return target;
}
