import type { AppConfig } from "./config.js";
import type { BoundsEmu, GraphSlide, SlideElementRecord } from "./repository.js";

export type CandidateElement = {
  targetRef: string;
  slideId: string;
  elementId: string;
  role: string;
  semanticLabel: string;
  text: string;
  shapeName: string;
  bounds: BoundsEmu;
  positionHint: "top" | "middle" | "bottom";
  visualWeight: "large" | "normal";
};

export type SlideSummary = {
  slideId: string;
  number: number;
  title: string;
  subtitle: string;
};

export type ResolveTargetContext = {
  task: "resolve_target";
  userRequest: string;
  scope: {
    currentSlideId: string;
    defaultRule: "edit_current_slide_only";
  };
  currentSlide: SlideSummary;
  candidateElements: CandidateElement[];
  selectedElementIds: string[];
  deckContext: {
    nearbySlides: SlideSummary[];
  };
  conversationContext: {
    lastTargetRef?: string;
  };
  rules: string[];
};

export type ResolvedTarget = {
  targetRef: string | null;
  confidence: number;
  reason: string;
  needsClarification: boolean;
  clarificationQuestion?: string | null;
};

export type TargetResolver = {
  resolveTarget(context: ResolveTargetContext): Promise<ResolvedTarget>;
};

export function candidateFromElement(
  element: SlideElementRecord,
  slide: GraphSlide,
): CandidateElement {
  const semanticLabel = semanticLabelForElement(element, slide);
  return {
    targetRef: `${element.slideId}.${element.elementId}`,
    slideId: element.slideId,
    elementId: element.elementId,
    role: element.role,
    semanticLabel,
    text: element.text,
    shapeName: element.xmlProvenance.shapeName,
    bounds: element.bounds,
    positionHint: positionHint(element.bounds, slide.heightEmu),
    visualWeight: element.role === "title" ? "large" : "normal",
  };
}

export class HeuristicTargetResolver implements TargetResolver {
  async resolveTarget(context: ResolveTargetContext): Promise<ResolvedTarget> {
    const candidates = context.candidateElements;
    if (!candidates.length) {
      return clarification("No editable text candidates were available.");
    }

    const exact = bestExactTextMatch(context.userRequest, candidates);
    if (exact) {
      return resolved(exact, 0.98, "Existing text in the prompt matched this element.");
    }

    const selected = selectedCandidate(context);
    if (selected) {
      return resolved(selected, 0.97, "The user selected this element in the current slide.");
    }

    const semantic = bestSemanticMatch(context.userRequest, candidates);
    if (semantic) {
      return resolved(semantic.candidate, semantic.confidence, semantic.reason);
    }

    const last = context.conversationContext.lastTargetRef
      ? candidates.find((candidate) => candidate.targetRef === context.conversationContext.lastTargetRef)
      : undefined;
    if (last) {
      return resolved(last, 0.76, "The prompt is a refinement, so the last edited element is the best target.");
    }

    if (candidates.length === 1) {
      return resolved(candidates[0]!, 0.76, "Only one editable text candidate is in scope.");
    }

    return clarification("The prompt did not identify a specific slide element.");
  }
}

export class OpenAITargetResolver implements TargetResolver {
  constructor(private readonly config: AppConfig) {}

  async resolveTarget(context: ResolveTargetContext): Promise<ResolvedTarget> {
    if (!this.config.openaiApiKey) {
      return new HeuristicTargetResolver().resolveTarget(context);
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
              "Resolve the exact PowerPoint text target. Choose only from candidate target_ref values. Return JSON only. Ask clarification when confidence is low.",
          },
          {
            role: "user",
            content: JSON.stringify(context),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "pptx_target_resolution",
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "target_ref",
                "confidence",
                "reason",
                "needs_clarification",
                "clarification_question",
              ],
              properties: {
                target_ref: { type: ["string", "null"] },
                confidence: { type: "number" },
                reason: { type: "string" },
                needs_clarification: { type: "boolean" },
                clarification_question: { type: ["string", "null"] },
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      return new HeuristicTargetResolver().resolveTarget(context);
    }

    const parsed = parseResponseJson(await response.json());
    const targetRef = typeof parsed.target_ref === "string" ? parsed.target_ref : null;
    const allowed = targetRef
      ? context.candidateElements.some((candidate) => candidate.targetRef === targetRef)
      : true;
    if (!allowed) {
      return clarification("The model selected a target outside the canonical candidates.");
    }

    return {
      targetRef,
      confidence:
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? clamp(parsed.confidence, 0, 1)
          : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "Model resolved target.",
      needsClarification: Boolean(parsed.needs_clarification) || !targetRef,
      clarificationQuestion:
        typeof parsed.clarification_question === "string"
          ? parsed.clarification_question
          : null,
    };
  }
}

function semanticLabelForElement(element: SlideElementRecord, slide: GraphSlide): string {
  const name = element.xmlProvenance.shapeName.toLowerCase();
  if (element.role === "title" || name.includes("title")) return "heading/title";
  const pos = positionHint(element.bounds, slide.heightEmu);
  if (name.includes("footer") || name.includes("source") || pos === "bottom") return "footer/source";
  if (name.includes("subtitle")) return "subtitle";
  return "description/body";
}

function positionHint(bounds: BoundsEmu, slideHeight: number): CandidateElement["positionHint"] {
  const center = bounds.y + bounds.h / 2;
  if (center < slideHeight * 0.33) return "top";
  if (center > slideHeight * 0.72) return "bottom";
  return "middle";
}

function selectedCandidate(context: ResolveTargetContext): CandidateElement | undefined {
  const selected = new Set(context.selectedElementIds);
  return context.candidateElements.find((candidate) => selected.has(candidate.elementId));
}

function bestExactTextMatch(
  request: string,
  candidates: CandidateElement[],
): CandidateElement | undefined {
  const phrases = existingTextPhrases(request);
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeText(phrase);
    if (!normalizedPhrase) continue;
    const matches = candidates.filter((candidate) =>
      normalizeText(candidate.text).includes(normalizedPhrase),
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function existingTextPhrases(request: string): string[] {
  const phrases = [...request.matchAll(/["“](.+?)["”]/g)].map((match) => match[1] ?? "");
  const from = /\bfrom\s+(.+?)\s+(?:to|with)\s+(.+)$/i.exec(request)?.[1];
  if (from) phrases.push(cleanLoosePhrase(from));
  const replaceWith = /\breplace\s+(.+?)\s+with\s+(.+)$/i.exec(request)?.[1];
  if (replaceWith) phrases.push(cleanLoosePhrase(replaceWith));
  return phrases.map((phrase) => phrase.trim()).filter(Boolean);
}

function bestSemanticMatch(
  request: string,
  candidates: CandidateElement[],
): { candidate: CandidateElement; confidence: number; reason: string } | undefined {
  const lower = request.toLowerCase();
  const wantsTitle = /\b(title|heading|headline|header)\b/.test(lower);
  const wantsBody = /\b(description|body|copy|paragraph|subtitle|text)\b/.test(lower);
  const wantsFooter = /\b(footer|source|citation)\b/.test(lower);

  if (wantsTitle) {
    const candidate = candidates.find((item) => item.semanticLabel.includes("title"));
    if (candidate) {
      return { candidate, confidence: 0.9, reason: "The prompt refers to a title-like element." };
    }
  }
  if (wantsFooter) {
    const candidate = candidates.find((item) => item.semanticLabel.includes("footer"));
    if (candidate) {
      return { candidate, confidence: 0.86, reason: "The prompt refers to footer/source text." };
    }
  }
  if (wantsBody) {
    const bodyCandidates = candidates.filter(
      (item) => item.semanticLabel.includes("body") || item.semanticLabel.includes("subtitle"),
    );
    if (bodyCandidates.length === 1) {
      return {
        candidate: bodyCandidates[0]!,
        confidence: 0.88,
        reason: "The prompt refers to body/description text.",
      };
    }
  }
  return undefined;
}

function cleanLoosePhrase(value: string): string {
  return value
    .replace(/\b(the|this|current|selected|slide|heading|title|description|body|text)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function resolved(candidate: CandidateElement, confidence: number, reason: string): ResolvedTarget {
  return {
    targetRef: candidate.targetRef,
    confidence,
    reason,
    needsClarification: false,
    clarificationQuestion: null,
  };
}

function clarification(reason: string): ResolvedTarget {
  return {
    targetRef: null,
    confidence: 0,
    reason,
    needsClarification: true,
    clarificationQuestion: "Which text box should I edit on this slide?",
  };
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
