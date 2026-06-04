import type { AgentRunResult } from "./index.ts";

export type CliArgs = {
  task: string;
  json: boolean;
  output?: string;
  replay?: string;
};

export function parseCliArgs(args: string[]): CliArgs {
  let json = false;
  let output: string | undefined;
  let replay: string | undefined;
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--output") {
      output = readOptionValue(args, index, "--output");
      index += 1;
    } else if (arg === "--replay") {
      replay = readOptionValue(args, index, "--replay");
      index += 1;
    } else {
      taskParts.push(arg);
    }
  }

  return {
    task: taskParts.join(" ").trim(),
    json,
    output,
    replay,
  };
}

export function formatRunResult(result: AgentRunResult, options: { json: boolean }): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  const lines = [
    `Status: ${result.status}`,
    `Stop reason: ${result.stopReason}`,
  ];

  if (result.answer) {
    lines.push("", "Answer:", result.answer);
  }

  if (result.citations.length > 0) {
    lines.push("", "Citations:");
    for (const citation of result.citations) {
      lines.push(`- ${citation.title}: ${citation.url}`);
    }
  }

  if (result.status === "failed" && result.observations.length > 0) {
    const lastObservation = result.observations.at(-1);
    if (lastObservation?.result.ok === false) {
      lines.push("", "Last error:", `${lastObservation.result.error.code}: ${lastObservation.result.error.message}`);
    }
  }

  return lines.join("\n");
}

function readOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected a path after ${name}.`);
  }
  return value;
}
