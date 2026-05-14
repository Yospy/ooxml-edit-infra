import type { AppConfig } from "./config.js";
import type { EditOperation, EditPlan } from "./types.js";
import type { GraphSlide, SlideElementRecord } from "./repository.js";
import { makeId } from "./ids.js";

export type PlannerInput = {
  deckId: string;
  versionId: string;
  message: string;
  selectedSlideId?: string;
  target: SlideElementRecord;
  slide: GraphSlide;
  targetResolution?: {
    confidence: number;
    reason: string;
  };
};

export type Planner = {
  createPlan(input: PlannerInput): Promise<Omit<EditPlan, "planId" | "deckId" | "createdFromVersionId" | "status">>;
};

export class HeuristicPlanner implements Planner {
  async createPlan(input: PlannerInput): Promise<Omit<EditPlan, "planId" | "deckId" | "createdFromVersionId" | "status">> {
    const after = heuristicRewrite(input.target.text, input.message);
    const replace: EditOperation = {
      operationId: makeId("op"),
      operationType: "replace_text",
      targetRef: `${input.target.slideId}.${input.target.elementId}`,
      humanLabel: `${input.slide.slideId} ${input.target.role}`,
      before: input.target.text,
      after,
      preserveStyle: true,
      preserveBounds: true,
    };
    const fit: EditOperation = {
      operationId: makeId("op"),
      operationType: "fit_text",
      targetRef: `${input.target.slideId}.${input.target.elementId}`,
      humanLabel: `Refit ${input.target.role} inside original bounds`,
      before: input.target.text,
      after,
      preserveStyle: true,
      preserveBounds: true,
    };
    return {
      planType: "edit",
      summary: `Replace ${input.target.role} text on ${input.slide.slideId} while preserving style and bounds.`,
      affectedSlides: [input.slide.slideId],
      operations: [replace, fit],
      risks: [],
      requiresApproval: true,
    };
  }
}

export class OpenAIPlanner implements Planner {
  constructor(private readonly config: AppConfig) {}

  async createPlan(input: PlannerInput): Promise<Omit<EditPlan, "planId" | "deckId" | "createdFromVersionId" | "status">> {
    if (!this.config.openaiApiKey) {
      throw plannerError("OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is required for real planning.");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.openaiModel,
        input: [
          {
            role: "system",
            content:
              "You create safe PowerPoint edit plans. Return compact JSON only. Do not claim files were mutated.",
          },
          {
            role: "user",
            content: JSON.stringify({
              user_request: input.message,
              active_version_id: input.versionId,
              selected_slide_id: input.selectedSlideId,
              target: {
                target_ref: `${input.target.slideId}.${input.target.elementId}`,
                role: input.target.role,
                text: input.target.text,
                bounds: input.target.bounds,
              },
              target_resolution: input.targetResolution,
              allowed_operations: ["replace_text", "fit_text"],
              output_shape: {
                summary: "string",
                replacement_text: "string",
                risks: ["string"],
              },
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "pptx_edit_plan",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "replacement_text", "risks"],
              properties: {
                summary: { type: "string" },
                replacement_text: { type: "string" },
                risks: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw plannerError("PLAN_FAILED", `OpenAI planning failed with ${response.status}.`);
    }

    const body = (await response.json()) as unknown;
    const parsed = parseResponseJson(body);
    const replacement = typeof parsed.replacement_text === "string"
      ? parsed.replacement_text.trim()
      : "";
    if (!replacement) {
      throw plannerError("PLAN_FAILED", "OpenAI returned an empty replacement text.");
    }

    const base = new HeuristicPlanner();
    const plan = await base.createPlan(input);
    return {
      ...plan,
      summary:
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : plan.summary,
      operations: plan.operations.map((op) => ({ ...op, after: replacement })),
      risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === "string") : [],
    };
  }
}

function heuristicRewrite(text: string, message: string): string {
  const quotes = [...message.matchAll(/["“](.+?)["”]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (quotes.length > 1) return quotes[quotes.length - 1]!;
  const explicitQuote = quotes[0];
  if (explicitQuote) return explicitQuote;

  const fromTo = /\bfrom\s+(.+?)\s+to\s+(.+)$/i.exec(message)?.[2]?.trim();
  if (fromTo) return cleanupReplacement(fromTo);

  const replaceWith = /\breplace\s+.+?\s+with\s+(.+)$/i.exec(message)?.[1]?.trim();
  if (replaceWith) return cleanupReplacement(replaceWith);

  const changeTo = /\b(?:change|replace|make|set|update)\b[\s\S]*?\b(?:to|with)\s+(.+)$/i.exec(message)?.[1]?.trim();
  if (changeTo) return cleanupReplacement(changeTo);

  const lower = message.toLowerCase();
  if (lower.includes("short")) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 2) return words.slice(0, 2).join(" ");
    if (words.length === 2) return words[1];
  }
  if (lower.includes("growth") && /revenue/i.test(text)) return text.replace(/revenue/i, "Growth");
  return text.length > 24 ? text.slice(0, 24).trim() : `${text} Updated`;
}

function cleanupReplacement(value: string): string {
  return value.replace(/[.?!]\s*$/, "").trim();
}

function parseResponseJson(body: unknown): Record<string, unknown> {
  const direct = body as { output_text?: unknown };
  if (typeof direct.output_text === "string") return JSON.parse(direct.output_text) as Record<string, unknown>;
  const maybeOutput = body as { output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = maybeOutput.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find((value): value is string => Boolean(value));
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function plannerError(code: string, message: string) {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = 500;
  error.code = code;
  return error;
}
