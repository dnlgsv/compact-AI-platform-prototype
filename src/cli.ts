import { loadDotEnv } from "./config.ts";
import { formatRunResult, parseCliArgs } from "./cli-format.ts";
import {
  createRunArtifact,
  readRunArtifact,
  replayRunArtifact,
  writeRunArtifact,
} from "./run-artifacts.ts";
import { createResearchWorkflowFromEnv } from "./research-app.ts";

loadDotEnv();

const args = parseCliArgs(process.argv.slice(2));

if (args.replay) {
  try {
    const artifact = await readRunArtifact(args.replay);
    const result = replayRunArtifact(artifact);
    console.log(formatRunResult(result, { json: args.json }));
    process.exit(result.status === "completed" ? 0 : 1);
  } catch (error) {
    console.error(`Replay failed: ${errorMessage(error)}`);
    process.exit(1);
  }
}

if (!args.task) {
  console.error("Usage: npm.cmd run research -- [--json] [--output runs/latest.json] \"your research question\"");
  console.error("       npm.cmd run research -- [--json] --replay runs/latest.json");
  process.exit(1);
}

try {
  const workflow = createResearchWorkflowFromEnv();
  const result = await workflow.run(args.task);
  if (args.output) {
    await writeRunArtifact(args.output, createRunArtifact(args.task, result));
  }
  console.log(formatRunResult(result, { json: args.json }));
  process.exit(result.status === "completed" ? 0 : 1);
} catch (error) {
  console.error(`Run failed: ${errorMessage(error)}`);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
