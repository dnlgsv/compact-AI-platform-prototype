import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createAgent, type ModelAction } from "../src/index.ts";
import { createResearchWorkflow } from "../src/research-workflow.ts";
import { createDateMathTool } from "../src/research.ts";
import { createOpenAIResearchSynthesizer } from "../src/providers/openai-synthesis.ts";

type EvalCase = {
  name: string;
  run: () => Promise<void>;
};

type EvalCaseResult = {
  name: string;
  status: "passed" | "failed";
  error?: string;
};

type EvalCaseStatus = "passed" | "failed" | "missing";

type EvalReport = {
  status: "passed" | "failed";
  runStartedAt: string;
  modelVersion: string;
  promptVersion: string;
  passed: number;
  failed: number;
  total: number;
  cases: EvalCaseResult[];
};

type EvalComparisonReport = {
  status: "passed" | "failed";
  comparedAt: string;
  beforePath: string;
  afterPath: string;
  regressions: number;
  fixes: number;
  unchanged: number;
  cases: Array<{
    name: string;
    before: EvalCaseStatus;
    after: EvalCaseStatus;
    change: "unchanged" | "regression" | "fixed" | "added" | "removed";
  }>;
};

type EvalBaseline = {
  cases: Array<{
    name: string;
    status: "passed" | "failed";
  }>;
};

const evalCases: EvalCase[] = [
  {
    name: "observed citation is accepted",
    async run() {
      const result = await createResearchWorkflow({
        maxSources: 1,
        searchProvider() {
          return [
            {
              title: "Observed source",
              url: "https://example.com/observed",
            },
          ];
        },
        async fetcher() {
          return htmlResponse("<title>Observed source</title><p>Grounded evidence.</p>");
        },
        synthesize(input) {
          return {
            answer: "Grounded answer.",
            citations: [
              {
                title: input.sources[0].title,
                url: input.sources[0].url,
              },
            ],
          };
        },
      }).run("Use the observed source.");

      assertRun(result.status === "completed", "Expected run to complete.");
      assertRun(result.citations[0]?.url === "https://example.com/observed", "Expected observed citation.");
    },
  },
  {
    name: "unobserved citation is rejected",
    async run() {
      const result = await createResearchWorkflow({
        maxSources: 1,
        searchProvider() {
          return [
            {
              title: "Observed source",
              url: "https://example.com/observed",
            },
          ];
        },
        async fetcher() {
          return htmlResponse("<title>Observed source</title><p>Grounded evidence.</p>");
        },
        synthesize() {
          return {
            answer: "Unsupported answer.",
            citations: [
              {
                title: "Missing source",
                url: "https://example.com/missing",
              },
            ],
          };
        },
      }).run("Reject an unsupported citation.");

      assertRun(result.status === "failed", "Expected run to fail.");
      assertRun(result.stopReason === "citation_validation_failed", "Expected citation validation failure.");
    },
  },
  {
    name: "date math calculates full elapsed years",
    async run() {
      const actions: ModelAction[] = [
        {
          type: "tool_call",
          toolName: "dateMath",
          input: {
            operation: "elapsedYears",
            fromDate: "1703-05-27",
            toDate: "2026-06-03",
          },
        },
        {
          type: "final",
          answer: "done",
        },
      ];
      const result = await createAgent({
        tools: [createDateMathTool()],
        model: {
          complete() {
            const action = actions.shift();
            if (!action) {
              throw new Error("No model action left.");
            }
            return action;
          },
        },
      }).run("Calculate elapsed years.");

      const observation = result.observations[0];
      assertRun(observation?.result.ok === true, "Expected dateMath observation to succeed.");
      if (observation.result.ok) {
        assertRun(
          (observation.result.data as { years?: unknown }).years === 323,
          "Expected 323 full elapsed years.",
        );
      }
    },
  },
  {
    name: "invalid tool input is reported as a structured observation",
    async run() {
      const result = await createAgent({
        tools: [createDateMathTool()],
        policy: {
          maxSteps: 1,
        },
        model: {
          complete() {
            return {
              type: "tool_call",
              toolName: "dateMath",
              input: {
                operation: "elapsedYears",
                fromDate: "1703",
                toDate: "2026-06-03",
              },
            };
          },
        },
      }).run("Handle malformed tool input.");

      assertRun(result.status === "failed", "Expected run to fail.");
      assertRun(result.stopReason === "step_limit", "Expected step limit after malformed input observation.");
      assertRun(result.observations[0]?.result.ok === false, "Expected failed observation.");
      if (!result.observations[0].result.ok) {
        assertRun(
          result.observations[0].result.error.code === "invalid_tool_input",
          "Expected invalid_tool_input error code.",
        );
      }
    },
  },
  {
    name: "malformed provider structured output is rejected",
    async run() {
      const synthesize = createOpenAIResearchSynthesizer({
        apiKey: "test-key",
        model: "test-model",
        async fetcher() {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                output_text: JSON.stringify({
                  answer: 42,
                  citations: [],
                }),
              };
            },
            async text() {
              return "{}";
            },
          };
        },
      });

      try {
        await synthesize({
          task: "Handle malformed provider output.",
          sources: [],
          observations: [],
        });
      } catch (error) {
        assertRun(
          errorMessage(error) === "Research answer must include answer:string and citations:array.",
          "Expected structured output validation error.",
        );
        return;
      }

      throw new Error("Expected malformed provider output to be rejected.");
    },
  },
  {
    name: "fetch failure is reported without retrying the same source",
    async run() {
      let fetchCount = 0;
      const result = await createResearchWorkflow({
        maxSources: 1,
        searchProvider() {
          return [
            {
              title: "Unavailable source",
              url: "https://example.com/unavailable",
            },
          ];
        },
        async fetcher() {
          fetchCount += 1;
          return {
            status: 503,
            ok: false,
            headers: {
              get() {
                return "text/html";
              },
            },
            async text() {
              return "Service unavailable.";
            },
          };
        },
        synthesize(input) {
          assertRun(input.sources.length === 0, "Expected no fetched sources.");
          return {
            answer: "No reliable answer could be produced from fetched sources.",
            citations: [],
          };
        },
      }).run("Handle a fetch failure.");

      assertRun(fetchCount === 1, "Expected one fetch attempt for the unavailable source.");
      assertRun(result.status === "completed", "Expected workflow to complete with a graceful no-source answer.");
      assertRun(result.citations.length === 0, "Expected no citations.");
      const fetchObservation = result.observations.find((observation) => observation.toolName === "fetchUrl");
      assertRun(fetchObservation?.result.ok === false, "Expected structured failed fetch observation.");
      if (!fetchObservation.result.ok) {
        assertRun(fetchObservation.result.error.code === "tool_failed", "Expected tool_failed error code.");
      }
    },
  },
];

const options = parseArgs(process.argv.slice(2));
if (options.compare) {
  const comparison = await compareEvalReports(options.compare.before, options.compare.after);
  if (options.json) {
    const json = JSON.stringify(comparison, null, 2);
    if (options.output) {
      await writeReport(options.output, json);
    } else {
      console.log(json);
    }
  } else {
    printComparisonReport(comparison);
  }
  if (comparison.status === "failed") {
    process.exitCode = 1;
  }
} else {
const report = await runEvalCases(evalCases, {
  runStartedAt: new Date().toISOString(),
  modelVersion: process.env.EVAL_MODEL_VERSION ?? "local",
  promptVersion: process.env.EVAL_PROMPT_VERSION ?? "local",
});

validateEvalReport(report);
if (options.updateBaseline) {
  await writeBaseline(options.baseline, report);
} else {
  await compareBaseline(options.baseline, report);
}

if (options.json) {
  const json = JSON.stringify(report, null, 2);
  if (options.output) {
    await writeReport(options.output, json);
  } else {
    console.log(json);
  }
} else {
  printTextReport(report);
}

if (options.save) {
  await writeReport(defaultEvalReportPath(report.runStartedAt), JSON.stringify(report, null, 2));
}

if (report.failed > 0) {
  process.exitCode = 1;
}
}

function htmlResponse(body: string) {
  return {
    status: 200,
    ok: true,
    headers: {
      get(name: string) {
        return name.toLowerCase() === "content-type" ? "text/html" : null;
      },
    },
    async text() {
      return body;
    },
  };
}

function assertRun(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseArgs(args: string[]) {
  const outputIndex = args.indexOf("--output");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  if (outputIndex !== -1 && !output) {
    throw new Error("Expected a path after --output.");
  }
  if (output && !args.includes("--json")) {
    throw new Error("--output requires --json.");
  }

  const compareIndex = args.indexOf("--compare");
  let compare: { before: string; after: string } | undefined;
  if (compareIndex !== -1) {
    const before = args[compareIndex + 1];
    const after = args[compareIndex + 2];
    if (!before || before.startsWith("--") || !after || after.startsWith("--")) {
      throw new Error("Expected two report paths after --compare.");
    }
    compare = {
      before,
      after,
    };
  }

  return {
    json: args.includes("--json"),
    output,
    baseline: readOption(args, "--baseline") ?? "evals/baseline.json",
    updateBaseline: args.includes("--update-baseline"),
    save: args.includes("--save"),
    compare,
  };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a value after ${name}.`);
  }
  return value;
}

async function writeReport(outputPath: string, json: string) {
  const target = resolveInsideWorkspace(outputPath);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${json}\n`, "utf8");
}

function validateEvalReport(report: EvalReport) {
  assertRun(report.status === "passed" || report.status === "failed", "Eval report status is invalid.");
  assertRun(isIsoDate(report.runStartedAt), "Eval report runStartedAt must be an ISO timestamp.");
  assertRun(typeof report.modelVersion === "string" && report.modelVersion.length > 0, "Eval report modelVersion is required.");
  assertRun(typeof report.promptVersion === "string" && report.promptVersion.length > 0, "Eval report promptVersion is required.");
  assertRun(Number.isInteger(report.passed) && report.passed >= 0, "Eval report passed count is invalid.");
  assertRun(Number.isInteger(report.failed) && report.failed >= 0, "Eval report failed count is invalid.");
  assertRun(Number.isInteger(report.total) && report.total >= 0, "Eval report total count is invalid.");
  assertRun(report.total === report.passed + report.failed, "Eval report counts do not add up.");
  assertRun(report.cases.length === report.total, "Eval report case count does not match total.");

  for (const result of report.cases) {
    assertRun(typeof result.name === "string" && result.name.length > 0, "Eval case name is required.");
    assertRun(result.status === "passed" || result.status === "failed", `Eval case status is invalid for ${result.name}.`);
    if (result.status === "failed") {
      assertRun(typeof result.error === "string" && result.error.length > 0, `Failed eval case ${result.name} must include an error.`);
    }
  }
}

async function readEvalReport(path: string): Promise<EvalReport> {
  const report = JSON.parse(await readFile(resolveInsideWorkspace(path), "utf8")) as EvalReport;
  validateEvalReport(report);
  return report;
}

function validateBaseline(value: unknown): EvalBaseline {
  const candidate = value as { cases?: unknown };
  if (!Array.isArray(candidate.cases)) {
    throw new Error("Eval baseline must include cases:array.");
  }

  return {
    cases: candidate.cases.map((item) => {
      const result = item as { name?: unknown; status?: unknown };
      if (typeof result.name !== "string" || result.name.length === 0) {
        throw new Error("Every eval baseline case must include name:string.");
      }
      if (result.status !== "passed" && result.status !== "failed") {
        throw new Error(`Eval baseline case ${result.name} has invalid status.`);
      }
      return {
        name: result.name,
        status: result.status,
      };
    }),
  };
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && value.includes("T");
}

async function compareBaseline(baselinePath: string, report: EvalReport) {
  const baseline = validateBaseline(
    JSON.parse(await readFile(resolveInsideWorkspace(baselinePath), "utf8")),
  );
  const current = toBaseline(report);

  const expected = JSON.stringify(baseline.cases, null, 2);
  const actual = JSON.stringify(current.cases, null, 2);
  if (expected !== actual) {
    throw new Error(
      `Eval baseline mismatch. Run with --update-baseline if this change is intentional.\nExpected:\n${expected}\nActual:\n${actual}`,
    );
  }
}

async function compareEvalReports(beforePath: string, afterPath: string): Promise<EvalComparisonReport> {
  const before = await readEvalReport(beforePath);
  const after = await readEvalReport(afterPath);
  const beforeCases = new Map<string, EvalCaseStatus>(before.cases.map((result) => [result.name, result.status]));
  const afterCases = new Map<string, EvalCaseStatus>(after.cases.map((result) => [result.name, result.status]));
  const names = [...new Set([...beforeCases.keys(), ...afterCases.keys()])].sort();
  const cases = names.map((name) => {
    const beforeStatus = beforeCases.get(name) ?? "missing";
    const afterStatus = afterCases.get(name) ?? "missing";
    return {
      name,
      before: beforeStatus,
      after: afterStatus,
      change: classifyCaseChange(beforeStatus, afterStatus),
    };
  });
  const regressions = cases.filter((result) => result.change === "regression" || result.change === "removed").length;
  const fixes = cases.filter((result) => result.change === "fixed").length;
  const unchanged = cases.filter((result) => result.change === "unchanged").length;

  return {
    status: regressions === 0 ? "passed" : "failed",
    comparedAt: new Date().toISOString(),
    beforePath,
    afterPath,
    regressions,
    fixes,
    unchanged,
    cases,
  };
}

function classifyCaseChange(
  before: EvalCaseStatus,
  after: EvalCaseStatus,
): EvalComparisonReport["cases"][number]["change"] {
  if (before === after) {
    return "unchanged";
  }
  if (before === "passed" && after === "failed") {
    return "regression";
  }
  if (before === "failed" && after === "passed") {
    return "fixed";
  }
  if (before === "missing") {
    return "added";
  }
  if (after === "missing") {
    return "removed";
  }
  return "unchanged";
}

async function writeBaseline(baselinePath: string, report: EvalReport) {
  if (report.status !== "passed") {
    throw new Error("Refusing to update eval baseline from a failing report.");
  }

  const target = resolveInsideWorkspace(baselinePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(toBaseline(report), null, 2)}\n`, "utf8");
}

function toBaseline(report: EvalReport): EvalBaseline {
  return {
    cases: report.cases.map((result) => ({
      name: result.name,
      status: result.status,
    })),
  };
}

function resolveInsideWorkspace(path: string): string {
  const cwd = resolve(".");
  const target = resolve(path);
  if (target !== cwd && !target.startsWith(`${cwd}\\`) && !target.startsWith(`${cwd}/`)) {
    throw new Error("Path must stay inside the current workspace.");
  }
  return target;
}

async function runEvalCases(
  cases: EvalCase[],
  metadata: Pick<EvalReport, "runStartedAt" | "modelVersion" | "promptVersion">,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    try {
      await evalCase.run();
      results.push({
        name: evalCase.name,
        status: "passed",
      });
    } catch (error) {
      results.push({
        name: evalCase.name,
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const passed = results.length - failed;

  return {
    status: failed === 0 ? "passed" : "failed",
    ...metadata,
    passed,
    failed,
    total: results.length,
    cases: results,
  };
}

function printTextReport(report: EvalReport) {
  console.log(`runStartedAt: ${report.runStartedAt}`);
  console.log(`modelVersion: ${report.modelVersion}`);
  console.log(`promptVersion: ${report.promptVersion}`);
  console.log("");

  for (const result of report.cases) {
    if (result.status === "passed") {
      console.log(`ok - ${result.name}`);
    } else {
      console.error(`not ok - ${result.name}`);
      console.error(`  ${result.error ?? "Unknown error."}`);
    }
  }

  console.log("");
  console.log(`evals: ${report.passed} passed, ${report.failed} failed, ${report.total} total`);
}

function printComparisonReport(report: EvalComparisonReport) {
  console.log(`comparedAt: ${report.comparedAt}`);
  console.log(`before: ${report.beforePath}`);
  console.log(`after: ${report.afterPath}`);
  console.log("");

  for (const result of report.cases) {
    console.log(`${result.change} - ${result.name} (${result.before} -> ${result.after})`);
  }

  console.log("");
  console.log(`comparison: ${report.regressions} regressions, ${report.fixes} fixes, ${report.unchanged} unchanged`);
}

function defaultEvalReportPath(runStartedAt: string): string {
  const stamp = runStartedAt.replace(/[:.]/g, "-");
  return `eval-results/eval-${stamp}.json`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
