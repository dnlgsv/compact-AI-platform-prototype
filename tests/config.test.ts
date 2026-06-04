import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { loadDotEnv } from "../src/config.ts";

const tmpDir = "tests/.tmp";
const envPath = `${tmpDir}/config.env`;

test("loadDotEnv loads simple values without overriding existing env", () => {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    envPath,
    [
      "# comment",
      "OPENAI_API_KEY=from-file",
      "OPENAI_MODEL=gpt-test # inline comment",
      "export BRAVE_SEARCH_API_KEY='brave-key'",
      'MULTILINE="hello\\nworld"',
    ].join("\n"),
  );

  const target: Record<string, string | undefined> = {
    OPENAI_API_KEY: "already-set",
  };

  const loaded = loadDotEnv({
    path: envPath,
    target,
  });

  assert.deepEqual(loaded, ["OPENAI_MODEL", "BRAVE_SEARCH_API_KEY", "MULTILINE"]);
  assert.equal(target.OPENAI_API_KEY, "already-set");
  assert.equal(target.OPENAI_MODEL, "gpt-test");
  assert.equal(target.BRAVE_SEARCH_API_KEY, "brave-key");
  assert.equal(target.MULTILINE, "hello\nworld");

  rmSync(tmpDir, { recursive: true, force: true });
});

test("loadDotEnv can override existing env when requested", () => {
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(envPath, "OPENAI_API_KEY=from-file");

  const target: Record<string, string | undefined> = {
    OPENAI_API_KEY: "already-set",
  };

  const loaded = loadDotEnv({
    path: envPath,
    target,
    override: true,
  });

  assert.deepEqual(loaded, ["OPENAI_API_KEY"]);
  assert.equal(target.OPENAI_API_KEY, "from-file");

  rmSync(tmpDir, { recursive: true, force: true });
});
