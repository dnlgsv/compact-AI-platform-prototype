import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import type { AgentRunResult } from "./index.ts";
import { loadDotEnv } from "./config.ts";
import { createResearchWorkflowFromEnv } from "./research-app.ts";
import { createFileRunStorage, type RunArtifactSummary, type RunStorage } from "./run-storage.ts";
import type { RunArtifact } from "./run-artifacts.ts";

export type ResearchRunner = {
  run(task: string): Promise<AgentRunResult>;
};

export function createApiServer(deps: { research: ResearchRunner; storage?: RunStorage }) {
  return createServer(async (request, response) => {
    try {
      await handleRequest(request, response, deps);
    } catch (error) {
      writeJson(response, 500, {
        error: {
          code: "internal_error",
          message: errorMessage(error),
        },
      });
    }
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: { research: ResearchRunner; storage?: RunStorage },
) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") {
    if (!deps.storage) {
      writeHtml(response, 200, renderDashboardShell("No run storage configured.", "<p>Run storage is not configured.</p>"));
      return;
    }
    const runs = await deps.storage.list();
    writeHtml(response, 200, renderRunsList(runs, url.searchParams.get("status")));
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      status: "ok",
    });
    return;
  }

  if (method === "POST" && url.pathname === "/runs/research") {
    const taskRequest = await readTaskRequest(request);
    const task = taskRequest.task;
    if (typeof task !== "string" || task.trim() === "") {
      if (taskRequest.responseMode === "html" && deps.storage) {
        writeHtml(response, 400, renderRunsList(await deps.storage.list(), null, "Research task is required."));
      } else {
        writeJson(response, 400, {
          error: {
            code: "invalid_request",
            message: "Expected body.task to be a non-empty string.",
          },
        });
      }
      return;
    }

    const result = await deps.research.run(task.trim());
    let artifact: RunArtifact | undefined;
    if (deps.storage) {
      artifact = await deps.storage.save(task.trim(), result);
    }

    if (taskRequest.responseMode === "html") {
      if (artifact) {
        redirect(response, `/runs/${encodeURIComponent(artifact.result.runId)}/view`);
      } else {
        writeHtml(response, result.status === "completed" ? 200 : 422, renderRunDetail({
          schemaVersion: 1,
          task: task.trim(),
          savedAt: new Date().toISOString(),
          result,
        }));
      }
      return;
    }

    writeJson(response, result.status === "completed" ? 200 : 422, result);
    return;
  }

  if (method === "GET" && url.pathname === "/runs") {
    if (!deps.storage) {
      writeJson(response, 404, {
        error: {
          code: "not_found",
          message: "Run storage is not configured.",
        },
      });
      return;
    }
    writeJson(response, 200, {
      runs: await deps.storage.list(),
    });
    return;
  }

  const runViewMatch = url.pathname.match(/^\/runs\/([^/]+)\/view$/);
  if (method === "GET" && runViewMatch) {
    if (!deps.storage) {
      writeHtml(response, 404, renderDashboardShell("Run not found", "<p>Run storage is not configured.</p>"));
      return;
    }
    try {
      writeHtml(response, 200, renderRunDetail(await deps.storage.read(decodeURIComponent(runViewMatch[1]))));
    } catch (error) {
      writeHtml(response, 404, renderDashboardShell("Run not found", `<p>${escapeHtml(errorMessage(error))}</p>`));
    }
    return;
  }

  const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    if (!deps.storage) {
      writeJson(response, 404, {
        error: {
          code: "not_found",
          message: "Run storage is not configured.",
        },
      });
      return;
    }

    try {
      writeJson(response, 200, await deps.storage.read(decodeURIComponent(runMatch[1])));
    } catch (error) {
      writeJson(response, 404, {
        error: {
          code: "not_found",
          message: errorMessage(error),
        },
      });
    }
    return;
  }

  writeJson(response, 404, {
    error: {
      code: "not_found",
      message: "Route not found.",
    },
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function readTaskRequest(request: IncomingMessage): Promise<{ responseMode: "json" | "html"; task: unknown }> {
  const contentType = request.headers["content-type"] ?? "";
  const contentTypes = Array.isArray(contentType) ? contentType : [contentType];
  const isForm = contentTypes.some((value) => value.includes("application/x-www-form-urlencoded"));
  if (isForm) {
    const params = new URLSearchParams(await readRequestBody(request));
    return {
      responseMode: "html",
      task: params.get("task"),
    };
  }

  const body = await readJsonBody(request);
  return {
    responseMode: "json",
    task: (body as { task?: unknown }).task,
  };
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeHtml(response: ServerResponse, statusCode: number, html: string) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(303, {
    Location: location,
  });
  response.end();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const port = readPort(process.env.PORT);
  const server = createApiServer({
    research: createResearchWorkflowFromEnv(),
    storage: createFileRunStorage(),
  });
  server.listen(port, () => {
    console.log(`API listening on http://127.0.0.1:${port}`);
  });
}

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return 3000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function renderRunsList(runs: RunArtifactSummary[], statusFilter: string | null, formError?: string): string {
  const selectedStatus = statusFilter === "completed" || statusFilter === "failed" ? statusFilter : "all";
  const visibleRuns = selectedStatus === "all" ? runs : runs.filter((run) => run.status === selectedStatus);
  const completedCount = runs.filter((run) => run.status === "completed").length;
  const failedCount = runs.filter((run) => run.status === "failed").length;
  const rows = visibleRuns.length === 0
    ? '<tr><td colspan="5">No saved runs yet.</td></tr>'
    : visibleRuns.map((run) => [
        "<tr>",
        `<td><a href="/runs/${encodeURIComponent(run.runId)}/view">${escapeHtml(run.runId)}</a></td>`,
        `<td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>`,
        `<td>${escapeHtml(run.stopReason)}</td>`,
        `<td>${escapeHtml(run.task)}</td>`,
        `<td>${escapeHtml(run.savedAt)}</td>`,
        "</tr>",
      ].join("")).join("");

  return renderDashboardShell(
    "Runs",
    [
      '<section class="hero">',
      "<div>",
      "<p class=\"eyebrow\">Operational dashboard</p>",
      "<p>Inspect saved research runs, replay artifacts, observed sources, and runtime traces.</p>",
      "</div>",
      '<div class="actions"><a class="button" href="/runs">JSON</a><a class="button" href="/health">Health</a></div>',
      "</section>",
      '<section class="metrics" aria-label="Run summary">',
      metricCard("Saved runs", runs.length),
      metricCard("Completed", completedCount),
      metricCard("Failed", failedCount),
      "</section>",
      renderNewRunForm(formError),
      '<nav class="filters" aria-label="Run filters">',
      filterLink("All", "/", selectedStatus === "all"),
      filterLink("Completed", "/?status=completed", selectedStatus === "completed"),
      filterLink("Failed", "/?status=failed", selectedStatus === "failed"),
      "</nav>",
      "<table>",
      "<thead><tr><th>Run</th><th>Status</th><th>Stop reason</th><th>Task</th><th>Saved</th></tr></thead>",
      `<tbody>${rows}</tbody>`,
      "</table>",
    ].join(""),
  );
}

function renderNewRunForm(error?: string): string {
  return [
    '<section class="card run-form">',
    "<h2>New Research Run</h2>",
    error ? `<p class="error-text">${escapeHtml(error)}</p>` : "",
    '<form method="post" action="/runs/research">',
    '<label for="task">Research task</label>',
    '<textarea id="task" name="task" rows="4" required></textarea>',
    '<div class="actions"><button type="submit">Run research</button></div>',
    "</form>",
    "</section>",
  ].join("");
}

function renderRunDetail(artifact: RunArtifact): string {
  const result = artifact.result;
  const citations = result.citations.length === 0
    ? "<li>No citations.</li>"
    : result.citations.map((citation) =>
        `<li><a href="${escapeHtml(citation.url)}">${escapeHtml(citation.title)}</a></li>`
      ).join("");
  const observations = result.observations.length === 0
    ? '<p class="muted">No observations.</p>'
    : result.observations.map((observation) => {
        const summary = observation.result.ok
          ? summarizeValue(observation.result.data)
          : `${observation.result.error.code}: ${observation.result.error.message}`;
        const sources = observation.sources?.length
          ? `<ul class="compact-list">${observation.sources.map((source) =>
              `<li><a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a></li>`
            ).join("")}</ul>`
          : '<p class="muted">No source metadata.</p>';
        return [
          '<details class="panel">',
          `<summary><span>Step ${observation.step}</span><strong>${escapeHtml(observation.toolName)}</strong><span class="status ${observation.result.ok ? "completed" : "failed"}">${observation.result.ok ? "ok" : "error"}</span></summary>`,
          '<div class="detail-grid">',
          `<div><h3>Input</h3><pre>${escapeHtml(JSON.stringify(observation.input, null, 2))}</pre></div>`,
          `<div><h3>Result</h3><pre>${escapeHtml(summary)}</pre></div>`,
          "</div>",
          "<h3>Sources</h3>",
          sources,
          "</details>",
        ].join("");
      }).join("");
  const trace = result.trace.length === 0
    ? '<p class="muted">No trace spans.</p>'
    : result.trace.map((span) => [
        '<li class="trace-item">',
        '<div class="trace-dot"></div>',
        '<div>',
        `<div><strong>${escapeHtml(span.name)}</strong> <span class="status ${span.status === "ok" ? "completed" : "failed"}">${escapeHtml(span.status)}</span></div>`,
        `<p>step ${span.step} - ${escapeHtml(span.kind)} - ${span.durationMs} ms</p>`,
        span.error ? `<p class="error-text">${escapeHtml(`${span.error.code}: ${span.error.message}`)}</p>` : "",
        span.attributes ? `<pre>${escapeHtml(JSON.stringify(span.attributes, null, 2))}</pre>` : "",
        "</div>",
        "</li>",
      ].join("")).join("");
  const sourcePanel = result.observations
    .flatMap((observation) => observation.sources ?? [])
    .filter((source, index, sources) => sources.findIndex((candidate) => candidate.url === source.url) === index);

  return renderDashboardShell(
    `Run ${result.runId}`,
    [
      '<p class="back-link"><a href="/">Back to runs</a></p>',
      '<section class="hero">',
      "<div>",
      `<p class="eyebrow">Saved ${escapeHtml(artifact.savedAt)}</p>`,
      `<p>${escapeHtml(artifact.task)}</p>`,
      "</div>",
      `<span class="status ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span>`,
      "</section>",
      '<section class="metrics" aria-label="Run summary">',
      metricCard("Stop reason", result.stopReason),
      metricCard("Observations", result.observations.length),
      metricCard("Trace spans", result.trace.length),
      "</section>",
      '<section class="layout">',
      '<article class="main-column">',
      '<section class="card">',
      "<h2>Answer</h2>",
      result.answer ? `<p>${escapeHtml(result.answer)}</p>` : '<p class="muted">No final answer.</p>',
      "</section>",
      '<section class="card">',
      "<h2>Observations</h2>",
      observations,
      "</section>",
      '<section class="card">',
      "<h2>Trace Timeline</h2>",
      `<ol class="trace-list">${trace}</ol>`,
      "</section>",
      "</article>",
      '<aside class="side-column">',
      '<section class="card">',
      "<h2>Citations</h2>",
      `<ul class="compact-list">${citations}</ul>`,
      "</section>",
      '<section class="card">',
      "<h2>Observed Sources</h2>",
      sourcePanel.length === 0
        ? '<p class="muted">No observed sources.</p>'
        : `<ul class="compact-list">${sourcePanel.map((source) =>
            `<li><a href="${escapeHtml(source.url)}">${escapeHtml(source.title)}</a><small>${escapeHtml(source.fetchedAt)}</small></li>`
          ).join("")}</ul>`,
      "</section>",
      '<section class="card">',
      "<h2>Artifacts</h2>",
      `<p><a href="/runs/${encodeURIComponent(result.runId)}">Open JSON artifact</a></p>`,
      "</section>",
      "</aside>",
      "</section>",
    ].join(""),
  );
}

function renderDashboardShell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} - AI Engine Lab</title>`,
    "<style>",
    ":root{color-scheme:light;--bg:#f5f6f8;--panel:#ffffff;--ink:#17202a;--muted:#667085;--line:#d9dee7;--accent:#2563eb;--ok-bg:#dcfce7;--ok:#166534;--bad-bg:#fee2e2;--bad:#991b1b}",
    "*{box-sizing:border-box}",
    "body{font-family:Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink)}",
    "main{max-width:1180px;margin:0 auto;padding:28px 20px 40px}",
    "h1{font-size:28px;line-height:1.2;margin:0 0 18px}",
    "h2{font-size:18px;line-height:1.3;margin:0 0 14px}",
    "h3{font-size:13px;line-height:1.3;margin:12px 0 8px;color:var(--muted);text-transform:uppercase}",
    "p{line-height:1.55}",
    "table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}",
    "th,td{text-align:left;border-bottom:1px solid var(--line);padding:12px;vertical-align:top}",
    "th{background:#eef2f7;font-size:12px;color:var(--muted);text-transform:uppercase}",
    "td{font-size:14px;word-break:break-word}",
    "tr:last-child td{border-bottom:0}",
    "a{color:var(--accent);text-decoration:none}",
    "a:hover{text-decoration:underline}",
    "pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e5edf7;border-radius:6px;padding:12px;font-size:12px;line-height:1.45;overflow:auto}",
    ".hero{display:flex;justify-content:space-between;gap:20px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;margin-bottom:16px}",
    ".hero p{margin:0;color:var(--muted)}",
    ".eyebrow{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent)!important;margin-bottom:6px!important}",
    ".actions{display:flex;gap:10px;flex-wrap:wrap}",
    ".button,.filters a,button{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:8px 10px;font-size:14px;font-weight:700;color:var(--ink)}",
    "button{cursor:pointer;background:#dbeafe;border-color:#93c5fd;color:#1d4ed8}",
    ".button:hover,.filters a:hover,button:hover{text-decoration:none;border-color:var(--accent)}",
    ".filters{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}",
    ".filters .active{background:#dbeafe;border-color:#93c5fd;color:#1d4ed8}",
    ".metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}",
    ".metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}",
    ".metric strong{display:block;font-size:22px;margin-top:4px}",
    ".metric span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;font-weight:700}",
    ".layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:16px;align-items:start}",
    ".main-column,.side-column{display:grid;gap:16px}",
    ".card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}",
    ".run-form{margin-bottom:16px}",
    ".run-form form{display:grid;gap:10px}",
    "label{font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase}",
    "textarea{width:100%;resize:vertical;min-height:96px;border:1px solid var(--line);border-radius:6px;padding:10px;font:inherit;line-height:1.45;color:var(--ink);background:#fff}",
    "textarea:focus{outline:2px solid #bfdbfe;border-color:#60a5fa}",
    ".panel{margin:10px 0;padding:0;overflow:hidden}",
    ".panel summary{display:flex;gap:10px;align-items:center;cursor:pointer;padding:12px 14px}",
    ".panel summary strong{margin-right:auto}",
    ".panel[open] summary{border-bottom:1px solid var(--line)}",
    ".detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:0 14px 12px}",
    ".panel h3,.panel .compact-list{margin-left:14px;margin-right:14px}",
    ".status{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}",
    ".completed{background:var(--ok-bg);color:var(--ok)}",
    ".failed{background:var(--bad-bg);color:var(--bad)}",
    ".muted{color:var(--muted)}",
    ".error-text{color:var(--bad);font-weight:700}",
    ".compact-list{list-style:none;padding:0;margin:0;display:grid;gap:10px}",
    ".compact-list li{border-top:1px solid var(--line);padding-top:10px}",
    ".compact-list li:first-child{border-top:0;padding-top:0}",
    ".compact-list small{display:block;color:var(--muted);margin-top:4px}",
    ".trace-list{list-style:none;margin:0;padding:0;display:grid;gap:0}",
    ".trace-item{display:grid;grid-template-columns:18px 1fr;gap:10px;padding:0 0 14px;position:relative}",
    ".trace-item:not(:last-child)::before{content:\"\";position:absolute;left:5px;top:14px;bottom:0;width:2px;background:var(--line)}",
    ".trace-dot{width:12px;height:12px;border-radius:999px;background:var(--accent);margin-top:5px;position:relative;z-index:1}",
    ".trace-item p{margin:4px 0;color:var(--muted);font-size:13px}",
    ".back-link{margin:0 0 14px}",
    "@media (max-width:780px){main{padding:20px 14px}.hero{align-items:flex-start;flex-direction:column}.metrics,.layout,.detail-grid{grid-template-columns:1fr}table{display:block;overflow-x:auto;white-space:nowrap}}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function metricCard(label: string, value: string | number): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function filterLink(label: string, href: string, active: boolean): string {
  return `<a class="${active ? "active" : ""}" href="${href}">${escapeHtml(label)}</a>`;
}

function summarizeValue(value: unknown): string {
  const raw = JSON.stringify(value, null, 2) ?? String(value);
  if (raw.length <= 1200) {
    return raw;
  }
  return `${raw.slice(0, 1200)}\n... truncated`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
