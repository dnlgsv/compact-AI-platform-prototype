import type { AgentRunOptions, AgentRunResult } from "./index.ts";
import type { RunArtifact } from "./run-artifacts.ts";
import type { RunStorage } from "./run-storage.ts";
import type { WorkflowRegistry } from "./workflows.ts";

export type AsyncRunStatus = "queued" | "running" | "completed" | "failed";

export type AsyncRunRecord = {
  runId: string;
  workflowName: string;
  workflowVersion: string;
  task: string;
  status: AsyncRunStatus;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: AgentRunResult;
  artifact?: RunArtifact;
  error?: {
    code: string;
    message: string;
  };
};

export type RunQueue = {
  enqueue(input: { workflowName: string; workflowVersion?: string; task: string }): AsyncRunRecord;
  read(runId: string): AsyncRunRecord | undefined;
  list(): AsyncRunRecord[];
};

export function createInMemoryRunQueue(deps: {
  workflows: WorkflowRegistry;
  storage?: RunStorage;
}): RunQueue {
  const records = new Map<string, AsyncRunRecord>();

  return {
    enqueue(input) {
      const workflow = deps.workflows.getWorkflow(input.workflowName, input.workflowVersion);
      const record: AsyncRunRecord = {
        runId: createRunId(),
        workflowName: workflow.name,
        workflowVersion: workflow.version,
        task: input.task,
        status: "queued",
        queuedAt: new Date().toISOString(),
      };
      records.set(record.runId, record);

      queueMicrotask(() => {
        void executeRun(record, workflow.run, deps.storage);
      });

      return { ...record };
    },

    read(runId) {
      const record = records.get(runId);
      return record ? cloneRecord(record) : undefined;
    },

    list() {
      return [...records.values()]
        .map(cloneRecord)
        .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    },
  };

  async function executeRun(
    record: AsyncRunRecord,
    run: (task: string, options?: AgentRunOptions) => Promise<AgentRunResult>,
    storage: RunStorage | undefined,
  ) {
    record.status = "running";
    record.startedAt = new Date().toISOString();

    try {
      const result = await run(record.task, { runId: record.runId });
      record.result = result;
      if (storage) {
        record.artifact = await storage.save(record.task, result);
      }
      record.status = result.status;
      record.endedAt = new Date().toISOString();
    } catch (error) {
      record.status = "failed";
      record.endedAt = new Date().toISOString();
      record.error = {
        code: "workflow_failed",
        message: errorMessage(error),
      };
    }
  }
}

function cloneRecord(record: AsyncRunRecord): AsyncRunRecord {
  return {
    ...record,
    result: record.result ? structuredClone(record.result) : undefined,
    artifact: record.artifact ? structuredClone(record.artifact) : undefined,
    error: record.error ? { ...record.error } : undefined,
  };
}

function createRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
