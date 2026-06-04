import { existsSync, readFileSync } from "node:fs";

export type DotEnvLoadOptions = {
  path?: string;
  override?: boolean;
  target?: Record<string, string | undefined>;
};

export function loadDotEnv(options: DotEnvLoadOptions = {}): string[] {
  const path = options.path ?? ".env";
  const target = options.target ?? process.env;
  const override = options.override ?? false;

  if (!existsSync(path)) {
    return [];
  }

  const loaded: string[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) {
      continue;
    }
    if (!override && target[parsed.key] !== undefined) {
      continue;
    }
    target[parsed.key] = parsed.value;
    loaded.push(parsed.key);
  }

  return loaded;
}

function parseDotEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const separator = withoutExport.indexOf("=");
  if (separator === -1) {
    return undefined;
  }

  const key = withoutExport.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  return {
    key,
    value: parseDotEnvValue(withoutExport.slice(separator + 1).trim()),
  };
}

function parseDotEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }

  return stripInlineComment(value).trim();
}

function stripInlineComment(value: string): string {
  const index = value.search(/\s#/);
  return index === -1 ? value : value.slice(0, index);
}
