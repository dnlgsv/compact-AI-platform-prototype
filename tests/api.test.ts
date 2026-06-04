import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import { createApiServer, type ResearchRunner } from "../src/api.ts";
import type { AgentRunResult } from "../src/index.ts";
import { createInMemoryRunQueue } from "../src/run-queue.ts";
import { createFileRunStorage } from "../src/run-storage.ts";
import { createWorkflowRegistry } from "../src/workflows.ts";
import { testRunMetadata } from "./fixtures.ts";

test("GET /health returns ok", async () => {
  await withServer(mockRunner(completedRun), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      status: "ok",
    });
  });
});

test("POST /runs/research returns completed run from injected workflow", async () => {
  const tasks: string[] = [];
  await withServer({
    async run(task) {
      tasks.push(task);
      return completedRun;
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/runs/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "  Research task  ",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(tasks, ["Research task"]);
    assert.equal(body.status, "completed");
    assert.equal(body.answer, "Grounded answer.");
  });
});

test("POST /runs enqueues an async workflow run for polling", async () => {
  const storage = createFileRunStorage("runs/test-api-async-runs");
  const workflows = createWorkflowRegistry([
    {
      name: "research",
      version: "research:v1",
      evalSuite: "research-evals",
      async run(_task, options) {
        return {
          ...completedRun,
          runId: options?.runId ?? "missing_run_id",
        };
      },
    },
  ]);
  const queue = createInMemoryRunQueue({ workflows, storage });

  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: "Research task",
          workflow: "research",
        }),
      });
      const created = await response.json();

      assert.equal(response.status, 202);
      assert.equal(created.status, "queued");
      assert.equal(created.workflow.name, "research");
      assert.equal(created.workflow.version, "research:v1");

      const polled = await pollAsyncRun(baseUrl, created.runId);
      assert.equal(polled.status, "completed");
      assert.equal(polled.result.runId, created.runId);
      assert.equal(polled.artifact.url, `/runs/${created.runId}/artifact`);

      const artifactResponse = await fetch(`${baseUrl}/runs/${created.runId}/artifact`);
      const artifact = await artifactResponse.json();
      assert.equal(artifactResponse.status, 200);
      assert.equal(artifact.result.runId, created.runId);
    },
    { storage, workflows, queue },
  );
});

test("POST /runs/research saves runs when storage is configured", async () => {
  const storage = createFileRunStorage("runs/test-api-storage");
  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs/research`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          task: "Research task",
        }),
      });
      assert.equal(response.status, 200);

      const artifactResponse = await fetch(`${baseUrl}/runs/run_completed`);
      const artifact = await artifactResponse.json();

      assert.equal(artifactResponse.status, 200);
      assert.equal(artifact.task, "Research task");
      assert.equal(artifact.result.runId, "run_completed");
    },
    { storage },
  );
});

test("GET /runs lists saved run summaries", async () => {
  const storage = createFileRunStorage("runs/test-api-list");
  await storage.save("Research task", completedRun);

  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.runs.length, 1);
      assert.equal(body.runs[0].runId, "run_completed");
      assert.equal(body.runs[0].task, "Research task");
    },
    { storage },
  );
});

test("GET / renders dashboard run list", async () => {
  const storage = createFileRunStorage("runs/test-api-dashboard-list");
  await storage.save("Research task", completedRun);
  await storage.save("Broken task", failedRun);

  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(baseUrl);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(html, /Runs/);
      assert.match(html, /Operational dashboard/);
      assert.match(html, /New Research Run/);
      assert.match(html, /<form method="post" action="\/runs\/research">/);
      assert.match(html, /Saved runs/);
      assert.match(html, /run_completed/);
      assert.match(html, /run_failed/);
      assert.match(html, /Research task/);
      assert.match(html, /final_answer/);
    },
    { storage },
  );
});

test("GET / filters dashboard run list by status", async () => {
  const storage = createFileRunStorage("runs/test-api-dashboard-filter");
  await storage.save("Research task", completedRun);
  await storage.save("Broken task", failedRun);

  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/?status=failed`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /run_failed/);
      assert.doesNotMatch(html, /run_completed/);
      assert.match(html, /class="active" href="\/\?status=failed"/);
    },
    { storage },
  );
});

test("POST /runs/research accepts dashboard form submissions and redirects to detail", async () => {
  const storage = createFileRunStorage("runs/test-api-dashboard-form-submit");
  const tasks: string[] = [];

  await withServer(
    {
      async run(task) {
        tasks.push(task);
        return completedRun;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs/research`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          task: "  Research from UI  ",
        }),
        redirect: "manual",
      });

      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "/runs/run_completed/view");
      assert.deepEqual(tasks, ["Research from UI"]);

      const artifact = await storage.read("run_completed");
      assert.equal(artifact.task, "Research from UI");
    },
    { storage },
  );
});

test("POST /runs/research renders dashboard validation errors for empty form submissions", async () => {
  const storage = createFileRunStorage("runs/test-api-dashboard-form-validation");
  let called = false;

  await withServer(
    {
      async run() {
        called = true;
        return completedRun;
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs/research`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          task: "",
        }),
      });
      const html = await response.text();

      assert.equal(response.status, 400);
      assert.equal(called, false);
      assert.match(html, /Research task is required/);
      assert.match(html, /New Research Run/);
    },
    { storage },
  );
});

test("GET /runs/:id/view renders dashboard run detail", async () => {
  const storage = createFileRunStorage("runs/test-api-dashboard-detail");
  await storage.save("Research task", completedRun);

  await withServer(
    mockRunner(completedRun),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/runs/run_completed/view`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /Run run_completed/);
      assert.match(html, /Grounded answer/);
      assert.match(html, /Observed/);
      assert.match(html, /Observed Sources/);
      assert.match(html, /Trace Timeline/);
      assert.match(html, /Open JSON artifact/);
      assert.match(html, /model.complete/);
    },
    { storage },
  );
});

test("POST /runs/research returns 422 for failed runs", async () => {
  await withServer(mockRunner(failedRun), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/runs/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "Research task",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.status, "failed");
    assert.equal(body.stopReason, "citation_validation_failed");
  });
});

test("POST /runs/research validates request body", async () => {
  await withServer(mockRunner(completedRun), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/runs/research`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task: "",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: {
        code: "invalid_request",
        message: "Expected body.task to be a non-empty string.",
      },
    });
  });
});

test("unknown routes return 404", async () => {
  await withServer(mockRunner(completedRun), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/missing`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "not_found");
  });
});

async function withServer(
  runner: ResearchRunner,
  fn: (baseUrl: string) => Promise<void>,
  options: {
    storage?: ReturnType<typeof createFileRunStorage>;
    workflows?: ReturnType<typeof createWorkflowRegistry>;
    queue?: ReturnType<typeof createInMemoryRunQueue>;
  } = {},
): Promise<void> {
  const server = createApiServer({
    research: runner,
    storage: options.storage,
    workflows: options.workflows,
    queue: options.queue,
  });

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function pollAsyncRun(baseUrl: string, runId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/runs/${runId}`);
    const body = await response.json();
    if (body.status === "completed" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not finish.`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function mockRunner(result: AgentRunResult): ResearchRunner {
  return {
    async run() {
      return result;
    },
  };
}

const completedRun: AgentRunResult = {
  runId: "run_completed",
  status: "completed",
  answer: "Grounded answer.",
  citations: [
    {
      title: "Observed",
      url: "https://example.com/observed",
    },
  ],
  observations: [
    {
      step: 1,
      toolName: "fetchUrl",
      input: {
        url: "https://example.com/observed",
      },
      result: {
        ok: true,
        data: {
          title: "Observed",
        },
      },
      sources: [
        {
          title: "Observed",
          url: "https://example.com/observed",
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
  ],
  metadata: testRunMetadata(),
  stopReason: "final_answer",
};

const failedRun: AgentRunResult = {
  runId: "run_failed",
  status: "failed",
  citations: [],
  observations: [],
  trace: [],
  metadata: testRunMetadata({
    modelLatencyMs: 0,
    tokens: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      source: "estimated",
    },
  }),
  stopReason: "citation_validation_failed",
};
