import { createResearchWorkflow } from "./research-workflow.ts";
import { createBraveSearchProvider } from "./providers/brave-search.ts";
import { createDuckDuckGoSearchProvider } from "./providers/duckduckgo-search.ts";
import { createOpenAIResearchSynthesizer } from "./providers/openai-synthesis.ts";
import { createWorkflowRegistry } from "./workflows.ts";

export function createResearchWorkflowFromEnv(env: Record<string, string | undefined> = process.env) {
  const currentDate = new Date().toISOString().slice(0, 10);
  const modelName = readEnv(env, "OPENAI_MODEL");
  const workflowVersion = env.WORKFLOW_VERSION ?? "research:v1";
  return createResearchWorkflow({
    maxSources: readIntegerEnv(env, "MAX_SOURCES", 3),
    maxSearchQueries: readIntegerEnv(env, "MAX_SEARCH_QUERIES", 4),
    maxCharsPerSource: readIntegerEnv(env, "MAX_CHARS_PER_SOURCE", 8_000),
    modelName,
    promptVersion: env.PROMPT_VERSION ?? "research-v1",
    workflowVersion,
    tokenPricing: readTokenPricing(env),
    searchProvider: createSearchProvider(env),
    synthesize: createOpenAIResearchSynthesizer({
      apiKey: readEnv(env, "OPENAI_API_KEY"),
      model: modelName,
      currentDate,
    }),
  });
}

export function createWorkflowRegistryFromEnv(env: Record<string, string | undefined> = process.env) {
  const research = createResearchWorkflowFromEnv(env);
  const workflowVersion = env.WORKFLOW_VERSION ?? "research:v1";
  return createWorkflowRegistry([
    {
      name: "research",
      version: workflowVersion,
      evalSuite: "research-evals",
      run(task, options) {
        return research.run(task, options);
      },
    },
  ]);
}

function createSearchProvider(env: Record<string, string | undefined>) {
  const provider = env.SEARCH_PROVIDER ?? "duckduckgo";
  if (provider === "duckduckgo") {
    return createDuckDuckGoSearchProvider();
  }
  if (provider === "brave") {
    return createBraveSearchProvider({
      apiKey: readEnv(env, "BRAVE_SEARCH_API_KEY"),
      country: env.BRAVE_SEARCH_COUNTRY,
      searchLang: env.BRAVE_SEARCH_LANG,
    });
  }
  throw new Error(`Unsupported SEARCH_PROVIDER: ${provider}`);
}

function readEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  defaultValue: number,
): number {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readTokenPricing(env: Record<string, string | undefined>) {
  const promptUsdPer1MTokens = readOptionalNumberEnv(env, "PROMPT_USD_PER_1M_TOKENS");
  const completionUsdPer1MTokens = readOptionalNumberEnv(env, "COMPLETION_USD_PER_1M_TOKENS");
  if (promptUsdPer1MTokens === undefined && completionUsdPer1MTokens === undefined) {
    return undefined;
  }
  if (promptUsdPer1MTokens === undefined || completionUsdPer1MTokens === undefined) {
    throw new Error("PROMPT_USD_PER_1M_TOKENS and COMPLETION_USD_PER_1M_TOKENS must be set together.");
  }
  return {
    promptUsdPer1MTokens,
    completionUsdPer1MTokens,
  };
}

function readOptionalNumberEnv(env: Record<string, string | undefined>, name: string): number | undefined {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return parsed;
}
