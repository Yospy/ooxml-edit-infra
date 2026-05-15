import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { makeId } from "./ids.js";
import type { CanonicalGraph, GraphSlide, SQLiteRepository, SlideElementRecord } from "./repository.js";
import type { EditOperation, EditPlan, OperationPreviewSummary } from "./types.js";
import { escapeXml } from "./xml.js";

export type OperationTargetType = "slide" | "text_box";

export type OperationMenuOperation = {
  operationType: EditOperation["operationType"];
  label: string;
  argsSchema: Record<string, string>;
  currentValue?: string;
};

export type OperationMenuTarget = {
  targetRef: string;
  targetType: OperationTargetType;
  slideId: string;
  elementId?: string;
  label: string;
  role?: string;
  text?: string;
  allowedOperations: OperationMenuOperation[];
};

export type OperationMenu = {
  currentSlideId: string;
  targets: OperationMenuTarget[];
};

export type OperationSelection = {
  targetRef: string | null;
  operationType: EditOperation["operationType"] | null;
  args: Record<string, string | number | boolean | null>;
  confidence: number;
  reason: string;
  needsClarification: boolean;
  clarificationQuestion?: string;
};

export type OperationSelector = {
  selectOperation(input: {
    message: string;
    menu: OperationMenu;
    selectedElementIds?: string[];
  }): Promise<OperationSelection>;
};

export class HeuristicOperationSelector implements OperationSelector {
  async selectOperation(input: {
    message: string;
    menu: OperationMenu;
    selectedElementIds?: string[];
  }): Promise<OperationSelection> {
    return selectOperationFromMenu(input);
  }
}

export class OpenAIOperationSelector implements OperationSelector {
  constructor(private readonly config: AppConfig) {}

  async selectOperation(input: {
    message: string;
    menu: OperationMenu;
    selectedElementIds?: string[];
  }): Promise<OperationSelection> {
    if (!this.config.openaiApiKey) {
      return selectOperationFromMenu(input);
    }
    const allowedOperationTypes = [
      ...new Set(input.menu.targets.flatMap((target) => target.allowedOperations.map((operation) => operation.operationType))),
    ];
    const selectedTargets = selectedMenuTargets(input.menu, input.selectedElementIds ?? []);
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
              "Select exactly one PowerPoint edit from the provided operation menu. Return JSON only. Do not invent targets, operations, or args.",
          },
          {
            role: "user",
            content: JSON.stringify({
              user_request: input.message,
              selected_element_ids: input.selectedElementIds ?? [],
              selected_targets: selectedTargets,
              operation_menu: input.menu,
              rules: [
                "Choose only a targetRef from operation_menu.targets.",
                "Choose only an operationType listed under that target's allowedOperations.",
                "Return needs_clarification when the target or operation is ambiguous.",
              ],
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "pptx_operation_selection",
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "target_ref",
                "operation_type",
                "args",
                "confidence",
                "reason",
                "needs_clarification",
                "clarification_question",
              ],
              properties: {
                target_ref: { type: ["string", "null"] },
                operation_type: { type: ["string", "null"], enum: [...allowedOperationTypes, null] },
                args: {
                  type: "object",
                  additionalProperties: { type: ["string", "number", "boolean", "null"] },
                },
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
      return selectOperationFromMenu(input);
    }
    const parsed = parseResponseJson(await response.json());
    const selection: OperationSelection = {
      targetRef: typeof parsed.target_ref === "string" ? parsed.target_ref : null,
      operationType: isOperationType(parsed.operation_type) ? parsed.operation_type : null,
      args: parseArgs(parsed.args),
      confidence:
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? clamp(parsed.confidence, 0, 1)
          : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "Model selected an operation.",
      needsClarification: Boolean(parsed.needs_clarification),
      clarificationQuestion:
        typeof parsed.clarification_question === "string" ? parsed.clarification_question : undefined,
    };
    try {
      validateOperationSelection(selection, input.menu);
      return selection;
    } catch (error) {
      return {
        targetRef: null,
        operationType: null,
        args: {},
        confidence: 0,
        reason: error instanceof Error ? error.message : "Model selected an invalid operation.",
        needsClarification: true,
        clarificationQuestion: "Which slide object should I edit?",
      };
    }
  }
}

export function buildOperationMenu(graph: CanonicalGraph, currentSlideId: string): OperationMenu {
  const slide = graph.slides.find((candidate) => candidate.slideId === currentSlideId) ?? graph.slides[0];
  if (!slide) {
    return { currentSlideId, targets: [] };
  }
  const slideTarget: OperationMenuTarget = {
    targetRef: `${slide.slideId}.background`,
    targetType: "slide",
    slideId: slide.slideId,
    label: `Slide ${slide.number} background`,
    allowedOperations: [
      {
        operationType: "set_slide_background",
        label: "Set slide background color",
        argsSchema: { color: "six-digit hex RGB color" },
        currentValue: slide.backgroundColor ?? "FFFFFF",
      },
    ],
  };
  const textTargets = slide.elements.map((element) => textTargetFromElement(element, slide));
  return {
    currentSlideId: slide.slideId,
    targets: [slideTarget, ...textTargets],
  };
}

export function selectOperationFromMenu(input: {
  message: string;
  menu: OperationMenu;
  selectedElementIds?: string[];
}): OperationSelection {
  const backgroundColor = resolveBackgroundColorRequest(input.message);
  if (backgroundColor) {
    const slideTarget = input.menu.targets.find(
      (target) =>
        target.targetType === "slide" &&
        target.allowedOperations.some((operation) => operation.operationType === "set_slide_background"),
    );
    if (slideTarget) {
      return {
        targetRef: slideTarget.targetRef,
        operationType: "set_slide_background",
        args: { color: backgroundColor },
        confidence: 0.96,
        reason: "The prompt requests a slide background color change.",
        needsClarification: false,
      };
    }
  }

  const textTargets = input.menu.targets.filter((target) => target.targetType === "text_box");
  if (!textTargets.length) {
    return clarification("No editable text targets were available.");
  }

  const exact = bestExactTextMatch(input.message, textTargets);
  if (exact) return textSelection(input.message, exact, 0.98, "Existing text in the prompt matched this element.");

  const selected = selectedTextTarget(input.menu, input.selectedElementIds ?? []);
  if (selected) return textSelection(input.message, selected, 0.97, "The user selected this element in the current slide.");

  const semantic = bestSemanticTextMatch(input.message, textTargets);
  if (semantic) return textSelection(input.message, semantic.target, semantic.confidence, semantic.reason);

  if (textTargets.length === 1) {
    return textSelection(input.message, textTargets[0]!, 0.76, "Only one editable text target is in scope.");
  }

  return clarification("The prompt did not identify a specific editable target.");
}

export function validateOperationSelection(selection: OperationSelection, menu: OperationMenu): void {
  if (selection.needsClarification || !selection.targetRef || !selection.operationType) {
    throw operationError("OPERATION_NEEDS_CLARIFICATION", selection.reason);
  }
  const target = menu.targets.find((candidate) => candidate.targetRef === selection.targetRef);
  if (!target) {
    throw operationError("OPERATION_TARGET_NOT_ALLOWED", `Target is not in the operation menu: ${selection.targetRef}`);
  }
  const operation = target.allowedOperations.find((candidate) => candidate.operationType === selection.operationType);
  if (!operation) {
    throw operationError(
      "OPERATION_NOT_ALLOWED_FOR_TARGET",
      `${selection.operationType} is not allowed for ${selection.targetRef}.`,
    );
  }
  if (selection.operationType === "replace_text") {
    const text = selection.args.text;
    if (typeof text !== "string" || !text.trim()) {
      throw operationError("OPERATION_ARGS_INVALID", "replace_text requires a non-empty text argument.");
    }
  }
  if (selection.operationType === "set_slide_background") {
    const color = selection.args.color;
    if (typeof color !== "string" || !isHexColor(color)) {
      throw operationError("OPERATION_ARGS_INVALID", "set_slide_background requires a six-digit hex color.");
    }
  }
}

export function planFromSelection(input: {
  deckId: string;
  versionId: string;
  selection: OperationSelection;
  menu: OperationMenu;
  graph: CanonicalGraph;
}): EditPlan {
  validateOperationSelection(input.selection, input.menu);
  const target = input.menu.targets.find((candidate) => candidate.targetRef === input.selection.targetRef)!;
  const operation = operationFromSelection(input.selection, target);
  const operations = [operation];
  return {
    planId: makeId("plan"),
    planType: "edit",
    deckId: input.deckId,
    createdFromVersionId: input.versionId,
    status: "awaiting_approval",
    summary: summaryForOperation(operation, input.graph),
    affectedSlides: [...new Set(operations.map((op) => targetSlideFromRef(op.targetRef)).filter(Boolean))] as string[],
    operations,
    risks: [],
    requiresApproval: true,
  };
}

export function validatePlanAgainstRegistry(plan: EditPlan, graph: CanonicalGraph): void {
  const currentSlideId = plan.affectedSlides[0] ?? graph.slides[0]?.slideId;
  if (!currentSlideId) throw operationError("OPERATION_TARGET_NOT_FOUND", "No slide is available.");
  const menu = buildOperationMenu(graph, currentSlideId);
  for (const operation of plan.operations) {
    const target = menu.targets.find((candidate) => candidate.targetRef === operation.targetRef);
    if (!target) {
      throw operationError("OPERATION_TARGET_NOT_ALLOWED", `Target is not in the operation menu: ${operation.targetRef}`);
    }
    if (!target.allowedOperations.some((candidate) => candidate.operationType === operation.operationType)) {
      throw operationError(
        "OPERATION_NOT_ALLOWED_FOR_TARGET",
        `${operation.operationType} is not allowed for ${operation.targetRef}.`,
      );
    }
    if (operation.operationType === "replace_text" && operation.before !== target.text) {
      throw operationError(
        "PLAN_BEFORE_MISMATCH",
        `The edit plan before text does not match the current target text for ${operation.targetRef}.`,
      );
    }
    if (operation.operationType === "set_slide_background" && !isHexColor(operation.after)) {
      throw operationError("OPERATION_ARGS_INVALID", "Slide background color must be six-digit hex.");
    }
  }
}

export function previewPlanOnGraph(plan: EditPlan, graph: CanonicalGraph): { graph: CanonicalGraph; highlightElementIds: string[] } {
  const previewGraph = cloneGraph(graph);
  const highlightElementIds: string[] = [];
  for (const operation of plan.operations) {
    if (operation.operationType === "set_slide_background") {
      const slide = findSlideByTargetRef(previewGraph, operation.targetRef);
      if (slide) slide.backgroundColor = operation.after;
      continue;
    }
    if (operation.operationType === "replace_text") {
      const target = findTextElementByTargetRef(previewGraph, operation.targetRef);
      if (target) {
        target.element.text = operation.after;
        highlightElementIds.push(target.element.elementId);
      }
    }
  }
  return { graph: previewGraph, highlightElementIds };
}

export function applyRegistryOperations(input: {
  repo: SQLiteRepository;
  presentationId: string;
  sourceVersionId: string;
  extractedPath: string;
  plan: EditPlan;
}): string[] {
  const changedSlides = new Set<string>();
  for (const operation of input.plan.operations) {
    if (operation.operationType === "set_slide_background") {
      const slideId = targetSlideFromRef(operation.targetRef);
      if (!slideId || !isHexColor(operation.after)) {
        throw operationError("OPERATION_ARGS_INVALID", `Invalid slide background operation: ${operation.targetRef}`);
      }
      const partPath = resolve(input.extractedPath, "ppt", "slides", `${slideId.replace("slide_", "slide")}.xml`);
      const xml = readFileSync(partPath, "utf8");
      writeFileSync(partPath, setSlideBackground(xml, operation.after.toUpperCase()));
      changedSlides.add(slideId);
      continue;
    }
    if (operation.operationType === "replace_text") {
      const target = input.repo.getElementByTargetRef(
        input.presentationId,
        input.sourceVersionId,
        operation.targetRef,
      );
      if (!target) throw operationError("TARGET_NOT_FOUND", `Target not found: ${operation.targetRef}`);
      const partPath = resolve(input.extractedPath, target.xmlProvenance.part);
      const xml = readFileSync(partPath, "utf8");
      const next = replaceTextInShape(xml, target.xmlProvenance.shapeId, operation.before, operation.after);
      if (next === xml) {
        throw operationError("TARGET_NOT_FOUND", `Could not find scoped text for ${operation.targetRef}.`);
      }
      writeFileSync(partPath, next);
      changedSlides.add(target.slideId);
      continue;
    }
    throw operationError("OPERATION_NOT_ALLOWED", `Unsupported operation: ${operation.operationType}`);
  }
  return [...changedSlides];
}

export function menuTargetsForClarification(menu: OperationMenu): Array<{ id: string; label: string; description: string }> {
  return menu.targets
    .filter((target) => target.targetType === "text_box")
    .map((target) => ({
      id: target.targetRef,
      label: target.label,
      description: target.targetRef,
    }));
}

function textTargetFromElement(element: SlideElementRecord, slide: GraphSlide): OperationMenuTarget {
  return {
    targetRef: `${element.slideId}.${element.elementId}`,
    targetType: "text_box",
    slideId: element.slideId,
    elementId: element.elementId,
    label: `${semanticLabelForElement(element, slide)}: ${truncateText(element.text, 48)}`,
    role: element.role,
    text: element.text,
    allowedOperations: [
      {
        operationType: "replace_text",
        label: "Replace text",
        argsSchema: { text: "replacement text" },
        currentValue: element.text,
      },
    ],
  };
}

function operationFromSelection(selection: OperationSelection, target: OperationMenuTarget): EditOperation {
  if (selection.operationType === "set_slide_background") {
    const color = String(selection.args.color).toUpperCase();
    return {
      operationId: makeId("op"),
      operationType: "set_slide_background",
      targetRef: target.targetRef,
      humanLabel: target.label,
      before: target.allowedOperations[0]?.currentValue ?? "FFFFFF",
      after: color,
      preserveStyle: false,
      preserveBounds: true,
      args: { color },
      preview: {
        operationType: "set_slide_background",
        targetRef: target.targetRef,
        label: target.label,
        kind: "property",
        property: "background color",
        before: target.allowedOperations[0]?.currentValue ?? "FFFFFF",
        after: color,
      },
    };
  }
  const replacement = String(selection.args.text ?? "");
  return {
    operationId: makeId("op"),
    operationType: "replace_text",
    targetRef: target.targetRef,
    humanLabel: target.label,
    before: target.text ?? "",
    after: replacement,
    preserveStyle: true,
    preserveBounds: true,
    args: { text: replacement },
    preview: {
      operationType: "replace_text",
      targetRef: target.targetRef,
      label: target.label,
      kind: "text",
      before: target.text ?? "",
      after: replacement,
    },
  };
}

function textSelection(message: string, target: OperationMenuTarget, confidence: number, reason: string): OperationSelection {
  return {
    targetRef: target.targetRef,
    operationType: "replace_text",
    args: { text: heuristicRewrite(target.text ?? "", message) },
    confidence,
    reason,
    needsClarification: false,
  };
}

function clarification(reason: string): OperationSelection {
  return {
    targetRef: null,
    operationType: null,
    args: {},
    confidence: 0,
    reason,
    needsClarification: true,
    clarificationQuestion: "Which slide object should I edit?",
  };
}

function selectedTextTarget(menu: OperationMenu, selectedElementIds: string[]): OperationMenuTarget | undefined {
  const selected = new Set(selectedElementIds);
  return menu.targets.find((target) => target.elementId && selected.has(target.elementId));
}

function selectedMenuTargets(menu: OperationMenu, selectedElementIds: string[]): OperationMenuTarget[] {
  const selected = new Set(selectedElementIds);
  return menu.targets.filter((target) => target.elementId && selected.has(target.elementId));
}

function bestExactTextMatch(message: string, targets: OperationMenuTarget[]): OperationMenuTarget | undefined {
  const phrases = existingTextPhrases(message);
  for (const phrase of phrases) {
    const normalizedPhrase = normalizeText(phrase);
    const matches = targets.filter((target) => normalizeText(target.text ?? "").includes(normalizedPhrase));
    if (normalizedPhrase && matches.length === 1) return matches[0];
  }
  return undefined;
}

function bestSemanticTextMatch(
  message: string,
  targets: OperationMenuTarget[],
): { target: OperationMenuTarget; confidence: number; reason: string } | undefined {
  const lower = message.toLowerCase();
  const wantsTitle = /\b(title|heading|headline|header)\b/.test(lower);
  const wantsBody = /\b(description|body|copy|paragraph|subtitle|text)\b/.test(lower);
  const wantsFooter = /\b(footer|source|citation)\b/.test(lower);
  if (wantsTitle) {
    const target = targets.find((item) => item.label.toLowerCase().includes("title"));
    if (target) return { target, confidence: 0.9, reason: "The prompt refers to a title-like element." };
  }
  if (wantsFooter) {
    const target = targets.find((item) => item.label.toLowerCase().includes("footer"));
    if (target) return { target, confidence: 0.86, reason: "The prompt refers to footer/source text." };
  }
  if (wantsBody) {
    const nonTitle = targets.filter((item) => !(item.role ?? "").includes("title"));
    if (nonTitle.length === 1) return { target: nonTitle[0]!, confidence: 0.82, reason: "The prompt refers to body-like text." };
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

function heuristicRewrite(text: string, message: string): string {
  const quotes = [...message.matchAll(/["“](.+?)["”]/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (quotes.length > 1) return quotes[quotes.length - 1]!;
  if (quotes[0]) return quotes[0];
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
    if (words.length === 2) return words[1]!;
  }
  if (lower.includes("growth") && /revenue/i.test(text)) return text.replace(/revenue/i, "Growth");
  return text.length > 24 ? text.slice(0, 24).trim() : `${text} Updated`;
}

function resolveBackgroundColorRequest(message: string): string | undefined {
  const lower = message.toLowerCase();
  if (!/\b(background|canvas|slide)\b/.test(lower) || !/\b(colou?r|bg)\b/.test(lower)) return undefined;
  const hex = /#?([0-9a-f]{6})\b/i.exec(message)?.[1];
  if (hex) return hex.toUpperCase();
  const named: Record<string, string> = {
    blue: "0000FF",
    red: "FF0000",
    green: "008000",
    yellow: "FFFF00",
    black: "000000",
    white: "FFFFFF",
    gray: "808080",
    grey: "808080",
    orange: "FFA500",
    purple: "800080",
    pink: "FFC0CB",
  };
  const colorName = Object.keys(named).find((name) => new RegExp(`\\b${name}\\b`, "i").test(message));
  return colorName ? named[colorName] : undefined;
}

function semanticLabelForElement(element: SlideElementRecord, slide: GraphSlide): string {
  const name = element.xmlProvenance.shapeName.toLowerCase();
  if (element.role === "title" || name.includes("title")) return "heading/title";
  const pos = positionHint(element.bounds, slide.heightEmu);
  if (name.includes("footer") || name.includes("source") || pos === "bottom") return "footer/source";
  if (name.includes("subtitle")) return "subtitle";
  return "description/body";
}

function positionHint(bounds: SlideElementRecord["bounds"], slideHeight: number): "top" | "middle" | "bottom" {
  const center = bounds.y + bounds.h / 2;
  if (center < slideHeight * 0.33) return "top";
  if (center > slideHeight * 0.72) return "bottom";
  return "middle";
}

function findSlideByTargetRef(graph: CanonicalGraph, targetRef: string): GraphSlide | undefined {
  const slideId = targetSlideFromRef(targetRef);
  return graph.slides.find((slide) => slide.slideId === slideId);
}

function findTextElementByTargetRef(
  graph: CanonicalGraph,
  targetRef: string,
): { slide: GraphSlide; element: SlideElementRecord } | undefined {
  const [slideId, elementId] = targetRef.split(".");
  const slide = graph.slides.find((candidate) => candidate.slideId === slideId);
  const element = slide?.elements.find((candidate) => candidate.elementId === elementId);
  return slide && element ? { slide, element } : undefined;
}

function replaceTextInShape(xml: string, shapeId: string, before: string, after: string): string {
  const shapeIdPattern = new RegExp(`<p:cNvPr\\b[^>]*\\bid="${escapeRegExp(shapeId)}"`);
  const block = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g)?.find((candidate) => shapeIdPattern.test(candidate));
  if (!block) return xml;
  const nextBlock = replaceText(block, before, after);
  return nextBlock === block ? xml : xml.replace(block, nextBlock);
}

function replaceText(xml: string, before: string, after: string): string {
  const escapedBefore = escapeXml(before);
  const escapedAfter = escapeXml(after);
  if (xml.includes(`<a:t>${escapedBefore}</a:t>`)) {
    return xml.replace(`<a:t>${escapedBefore}</a:t>`, `<a:t>${escapedAfter}</a:t>`);
  }
  return xml.replace(escapedBefore, escapedAfter);
}

function setSlideBackground(xml: string, hexColor: string): string {
  const background = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hexColor}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
  if (/<p:bg\b[\s\S]*?<\/p:bg>/.test(xml)) return xml.replace(/<p:bg\b[\s\S]*?<\/p:bg>/, background);
  return xml.replace(/(<p:cSld\b[^>]*>)/, `$1\n    ${background}`);
}

function summaryForOperation(operation: EditOperation, graph: CanonicalGraph): string {
  if (operation.operationType === "set_slide_background") {
    const slide = findSlideByTargetRef(graph, operation.targetRef);
    return `Change slide ${slide?.number ?? operation.targetRef} background color to #${operation.after}.`;
  }
  return `Replace text for ${operation.humanLabel} while preserving style and bounds.`;
}

function targetSlideFromRef(targetRef: string): string | undefined {
  return targetRef.split(".")[0] || undefined;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();
}

function cleanLoosePhrase(value: string): string {
  return value.replace(/[.?!]\s*$/, "").trim();
}

function cleanupReplacement(value: string): string {
  return value.replace(/[.?!]\s*$/, "").trim();
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isHexColor(value: string): boolean {
  return /^[0-9A-Fa-f]{6}$/.test(value);
}

function isOperationType(value: unknown): value is EditOperation["operationType"] {
  return value === "replace_text" || value === "fit_text" || value === "set_slide_background";
}

function parseArgs(value: unknown): OperationSelection["args"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
    const item = entry[1];
    return item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  });
  return Object.fromEntries(entries);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function cloneGraph(graph: CanonicalGraph): CanonicalGraph {
  return JSON.parse(JSON.stringify(graph)) as CanonicalGraph;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function operationError(code: string, message: string) {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = 409;
  error.code = code;
  return error;
}
