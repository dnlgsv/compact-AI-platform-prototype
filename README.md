# AI Engine Lab

Production-minded TypeScript/Node.js AI engine prototype for source-grounded research workflows.

The research assistant is one use case built on a small reusable runtime with typed tools, permission policy, traceable observations, citation validation, replayable run artifacts, deterministic evals, CI checks, a minimal API, file-backed persistence, and an operational dashboard.


## Quickstart

Requires Node.js 22+.

```powershell
npm.cmd test
npm.cmd run eval
npm.cmd run smoke
npm.cmd run research -- --replay runs/demo_research_run.json
npm.cmd run api
```

Open:

```txt
http://127.0.0.1:3000/
```

The smoke demo is offline and deterministic. It creates `runs/demo_research_run.json`, then you can replay it or inspect it in the dashboard without calling search or OpenAI.

## Architecture

```txt
src/
  index.ts                    agent runtime, tool loop, tracing, validation
  research.ts                 read-only research tools and dateMath primitive
  research-workflow.ts        search -> fetch -> synthesize workflow
  research-app.ts             env-based workflow construction
  cli.ts                      research CLI, artifact output, replay
  api.ts                      HTTP API and server-rendered dashboard
  run-artifacts.ts            run artifact schema, validation, replay
  run-storage.ts              file-backed run storage
  providers/                  DuckDuckGo, Brave, OpenAI adapters

evals/
  run.ts                      deterministic eval runner
  baseline.json               stable eval case baseline

tests/
  *.test.ts                   mocked unit/integration coverage
```

Core flow:

```txt
task
-> research workflow
-> search query planning
-> merged/ranked source candidates
-> agent runtime
-> typed tools
-> observations + trace
-> citation validation
-> AgentRunResult
-> artifact / API / dashboard / evals
```

## Setup For Live Research

Create `.env` in the project root:

```txt
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-nano
SEARCH_PROVIDER=duckduckgo
```

Optional:

```txt
MAX_SOURCES=3
MAX_SEARCH_QUERIES=4
MAX_CHARS_PER_SOURCE=8000
```

`MAX_SEARCH_QUERIES` controls how many retrieval queries the workflow may run before fetching sources. Compound company/role questions are expanded into queries such as company identity, careers/jobs, and company profile searches, then candidates are deduplicated and ranked before fetch.

Optional paid search provider:

```txt
SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=...
BRAVE_SEARCH_COUNTRY=us
BRAVE_SEARCH_LANG=en
```

Run live research:

```powershell
npm.cmd run research -- "Compare solar battery subsidies in Germany and France"
```

Full JSON:

```powershell
npm.cmd run research -- --json "Compare solar battery subsidies in Germany and France"
```

Save a run artifact:

```powershell
npm.cmd run research -- --output runs/latest.json "Compare solar battery subsidies in Germany and France"
```

Replay a saved run offline:

```powershell
npm.cmd run research -- --replay runs/latest.json
npm.cmd run research -- --json --replay runs/latest.json
```

Replay validates artifact shape and re-checks that citations were observed in saved observations. It does not prove the original source content is still live or unchanged.

## API And Dashboard

Start the API:

```powershell
npm.cmd run api
```

Routes:

```txt
GET /                    operational dashboard
GET /health              health check
GET /runs                saved run summaries
POST /runs/research      start a research run
GET /runs/:id            saved run artifact JSON
GET /runs/:id/view       run detail dashboard page
```

Example request:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/runs/research `
  -ContentType "application/json" `
  -Body '{"task":"Compare solar battery subsidies in Germany and France"}'
```

Completed agent runs return HTTP 200. Failed agent runs return HTTP 422 with the same `AgentRunResult` shape.

Dashboard UI:

- new research run form;
- run summary cards;
- status filters for completed and failed runs;
- saved run list with stop reasons and tasks;
- run detail page with answer, citations, observed sources, tool observations, trace timeline, and JSON artifact link;
- server-rendered HTML/CSS only, with no frontend build pipeline.

## Runtime Failure Modes

The runtime returns structured failed runs for expected operational failures:

- `model_action_validation_failed`: model returned an invalid action shape.
- `model_failed`: model adapter threw an error.
- `citation_validation_failed`: final answer cited a URL missing from observed sources.
- `run_timeout`: run exceeded `maxRunMs`.
- `step_limit`: run used all allowed steps without a final answer.

Every completed or failed run ends with a `run.stop` trace span containing the `stopReason`. Tool failures are recorded as failed observations so saved run artifacts remain inspectable and replay-validatable.

## Local Storage

Run artifacts are stored as JSON files:

```txt
runs/<runId>.json
```

The file-backed storage layer validates artifacts before writing and reading. Generated `runs/` files are ignored by git. Postgres is intentionally deferred until there is a concrete query need.

## Evals

Run deterministic evals:

```powershell
npm.cmd run eval
```

Machine-readable report:

```powershell
npm.cmd run eval -- --json
```

Write report artifact:

```powershell
npm.cmd run eval -- --json --output eval-results/latest.json
```

Eval coverage:

- observed citation acceptance;
- unobserved citation rejection;
- deterministic date math correctness;
- structured invalid tool input handling;
- malformed provider output rejection;
- graceful fetch failure handling.

Eval reports include `runStartedAt`, `modelVersion`, and `promptVersion`.

```powershell
$env:EVAL_MODEL_VERSION = "openai:gpt-5.4-nano"
$env:EVAL_PROMPT_VERSION = "research-v1"
npm.cmd run eval -- --json
```

Evals self-check required report fields and compare stable case names/statuses against `evals/baseline.json`.

Intentional baseline update:

```powershell
npm.cmd run eval -- --update-baseline
```

Do not update the baseline to hide a failure. Update it only when eval coverage intentionally changed.

## CI

GitHub Actions runs:

```txt
npm test
npm run eval -- --json --output eval-results/latest.json
```

The eval JSON report is uploaded as a workflow artifact named `eval-results`.

## Demo Script

Offline demo:

```powershell
npm.cmd run smoke
npm.cmd run research -- --replay runs/demo_research_run.json
npm.cmd run api
```

Then open:

```txt
http://127.0.0.1:3000/
```

This demonstrates artifact creation, replay, file-backed persistence, API startup, and dashboard inspection without live search or LLM calls.

## Current Limitations

- No authentication or rate limiting.
- No Postgres or distributed persistence.
- No background queue.
- No streaming API yet.
- No LLM-as-judge evals.
- No visual workflow editor.
- Dashboard is intentionally small and server-rendered.
- Live research requires valid provider credentials and network access.
