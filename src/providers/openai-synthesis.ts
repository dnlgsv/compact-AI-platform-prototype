import type { Citation } from "../index.ts";
import type {
  ResearchSynthesisInput,
  ResearchSynthesisResult,
} from "../research-workflow.ts";
import { defaultHttpFetch, type HttpFetch } from "./http.ts";

export type OpenAIResearchSynthesizerConfig = {
  apiKey: string;
  model: string;
  fetcher?: HttpFetch;
  currentDate?: string;
};

export function createOpenAIResearchSynthesizer(
  config: OpenAIResearchSynthesizerConfig,
): (input: ResearchSynthesisInput) => Promise<ResearchSynthesisResult> {
  const apiKey = required(config.apiKey, "OPENAI_API_KEY");
  const model = required(config.model, "OPENAI_MODEL");
  const fetcher = config.fetcher ?? defaultHttpFetch;
  const currentDate = config.currentDate ?? new Date().toISOString().slice(0, 10);

  return async (input) => {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: [
          "You are a careful research assistant.",
          "Use only the provided fetched sources.",
          `Today's date is ${currentDate}.`,
          "Return concise JSON with answer and citations.",
          "Every citation URL must come from the provided sources.",
        ].join(" "),
        input: buildResearchPrompt(input, currentDate),
        text: {
          format: {
            type: "json_schema",
            name: "research_answer",
            strict: true,
            schema: researchAnswerSchema,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI Responses API failed with HTTP ${response.status}: ${await response.text()}`);
    }

    return parseResearchAnswer(await response.json());
  };
}

const researchAnswerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations"],
  properties: {
    answer: {
      type: "string",
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title: {
            type: "string",
          },
          url: {
            type: "string",
          },
        },
      },
    },
  },
};

function buildResearchPrompt(input: ResearchSynthesisInput, currentDate: string): string {
  const sources = input.observations
    .filter((observation) => observation.toolName === "fetchUrl" && observation.result.ok)
    .map((observation, index) => {
      const data = observation.result.ok ? observation.result.data as { title?: string; url?: string; text?: string } : {};
      return [
        `SOURCE ${index + 1}`,
        `Title: ${data.title ?? "Untitled"}`,
        `URL: ${data.url ?? "unknown"}`,
        `Text: ${data.text ?? ""}`,
      ].join("\n");
    })
    .join("\n\n");

  const calculations = input.observations
    .filter((observation) => observation.toolName === "dateMath" && observation.result.ok)
    .map((observation, index) => {
      const data = observation.result.ok
        ? observation.result.data as {
            operation?: string;
            fromDate?: string;
            toDate?: string;
            years?: number;
          }
        : {};
      return [
        `CALCULATION ${index + 1}`,
        `Operation: ${data.operation ?? "unknown"}`,
        `From date: ${data.fromDate ?? "unknown"}`,
        `To date: ${data.toDate ?? "unknown"}`,
        `Full elapsed years: ${data.years ?? "unknown"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Task: ${input.task}`,
    `Current date: ${currentDate}`,
    "",
    "Fetched sources:",
    sources || "No sources were fetched.",
    "",
    "Deterministic calculations:",
    calculations || "No deterministic calculations were run.",
  ].join("\n");
}

function parseResearchAnswer(payload: unknown): ResearchSynthesisResult {
  const outputText = readOutputText(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`OpenAI response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return validateResearchAnswer(parsed);
}

function readOutputText(payload: unknown): string {
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") {
    return direct;
  }

  const output = (payload as { output?: unknown[] }).output;
  if (Array.isArray(output)) {
    const text = output
      .flatMap((item) => (item as { content?: unknown[] }).content ?? [])
      .map((content) => (content as { text?: unknown }).text)
      .filter((value): value is string => typeof value === "string")
      .join("");
    if (text) {
      return text;
    }
  }

  throw new Error("OpenAI response did not contain output text.");
}

function validateResearchAnswer(value: unknown): ResearchSynthesisResult {
  const candidate = value as { answer?: unknown; citations?: unknown };
  if (typeof candidate.answer !== "string" || !Array.isArray(candidate.citations)) {
    throw new Error("Research answer must include answer:string and citations:array.");
  }

  return {
    answer: candidate.answer,
    citations: candidate.citations.map(validateCitation),
  };
}

function validateCitation(value: unknown): Citation {
  const candidate = value as { title?: unknown; url?: unknown };
  if (typeof candidate.title !== "string" || typeof candidate.url !== "string") {
    throw new Error("Each citation must include title:string and url:string.");
  }
  return {
    title: candidate.title,
    url: candidate.url,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
