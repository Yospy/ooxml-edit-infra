import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { BoundsEmu, CanonicalGraph, GraphSlide, SlideElementRecord } from "./repository.js";
import { attr, decodeXml, numberAttr } from "./xml.js";

const DEFAULT_WIDTH_EMU = 9_144_000;
const DEFAULT_HEIGHT_EMU = 5_143_500;

export function assertPptx(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    const error = new Error("Invalid PPTX file. Expected an Office Open XML package.") as Error & {
      statusCode: number;
      code: string;
    };
    error.statusCode = 400;
    error.code = "INVALID_PPTX";
    throw error;
  }
}

export function parsePresentationGraph(input: {
  presentationId: string;
  versionId: string;
  extractedPath: string;
}): CanonicalGraph {
  const slideFiles = listSlideFiles(input.extractedPath);
  const slides = slideFiles.map((file, index) =>
    parseSlide(input.extractedPath, file, index + 1),
  );
  return {
    presentationId: input.presentationId,
    versionId: input.versionId,
    slides,
  };
}

function listSlideFiles(extractedPath: string): string[] {
  const slideDir = resolve(extractedPath, "ppt", "slides");
  if (!existsSync(slideDir)) return [];
  return readdirSync(slideDir)
    .filter((file) => /^slide\d+\.xml$/.test(file))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .map((file) => `ppt/slides/${file}`);
}

function slideNumber(file: string): number {
  return Number(/slide(\d+)\.xml/.exec(file)?.[1] ?? 0);
}

function parseSlide(extractedPath: string, part: string, number: number): GraphSlide {
  const xml = readFileSync(resolve(extractedPath, part), "utf8");
  const slideId = `slide_${number}`;
  const elements = parseShapes(xml, part, slideId);
  const title =
    elements.find((element) => element.role === "title")?.text ??
    elements[0]?.text ??
    `Slide ${number}`;
  const subtitle =
    elements.find((element) => element.role !== "title" && element.text)?.text ??
    "Backend parsed slide preview";
  return {
    slideId,
    number,
    title,
    subtitle,
    backgroundColor: extractBackgroundColor(xml),
    widthEmu: DEFAULT_WIDTH_EMU,
    heightEmu: DEFAULT_HEIGHT_EMU,
    elements,
  };
}

function extractBackgroundColor(xml: string): string | undefined {
  const bg = /<p:bg\b[\s\S]*?<\/p:bg>/.exec(xml)?.[0];
  const color = bg ? /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(bg)?.[1] : undefined;
  return color?.toUpperCase();
}

function parseShapes(xml: string, part: string, slideId: string): SlideElementRecord[] {
  const shapeBlocks = xml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
  const usedIds = new Set<string>();
  return shapeBlocks
    .map((block, index) => parseShape(block, part, slideId, index + 1, usedIds))
    .filter((shape): shape is SlideElementRecord => Boolean(shape));
}

function parseShape(
  block: string,
  part: string,
  slideId: string,
  fallbackIndex: number,
  usedIds: Set<string>,
): SlideElementRecord | undefined {
  const cNvPr = /<p:cNvPr\b[^>]*>/.exec(block)?.[0] ?? "";
  const shapeId = attr(cNvPr, "id") ?? String(fallbackIndex + 1);
  const shapeName = attr(cNvPr, "name") ?? `Shape ${shapeId}`;
  const text = extractText(block);
  if (!text.trim()) return undefined;

  const role = inferRole(block, shapeName, fallbackIndex);
  const elementId = uniqueElementId(roleToElementId(role, shapeId), usedIds);
  return {
    slideId,
    elementId,
    elementType: "text_box",
    role,
    text,
    bounds: extractBounds(block),
    style: extractStyle(block),
    xmlProvenance: {
      part,
      shapeId,
      shapeName,
    },
  };
}

function extractText(block: string): string {
  return [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXml(match[1] ?? ""))
    .join("");
}

function inferRole(block: string, name: string, index: number): string {
  const lower = name.toLowerCase();
  if (lower.includes("title") || /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(block)) {
    return "title";
  }
  if (lower.includes("body") || /<p:ph\b/.test(block)) return "body";
  return index === 1 ? "title" : "body";
}

function roleToElementId(role: string, shapeId: string): string {
  if (role === "title") return "shape_title";
  if (role === "body") return "shape_body";
  return `shape_${shapeId}`;
}

function uniqueElementId(base: string, usedIds: Set<string>): string {
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let index = 2;
  while (usedIds.has(`${base}_${index}`)) index += 1;
  const next = `${base}_${index}`;
  usedIds.add(next);
  return next;
}

function extractBounds(block: string): BoundsEmu {
  const off = /<a:off\b[^>]*>/.exec(block)?.[0] ?? "";
  const ext = /<a:ext\b[^>]*>/.exec(block)?.[0] ?? "";
  return {
    x: numberAttr(off, "x") ?? 685_800,
    y: numberAttr(off, "y") ?? 685_800,
    w: numberAttr(ext, "cx") ?? 7_772_400,
    h: numberAttr(ext, "cy") ?? 685_800,
  };
}

function extractStyle(block: string): Record<string, unknown> {
  const rPr = /<a:rPr\b[^>]*>/.exec(block)?.[0] ?? "";
  return {
    fontSize: numberAttr(rPr, "sz") ?? null,
    bold: attr(rPr, "b") === "1",
    source: basename(/ppt\/slides\/slide\d+\.xml/.exec(block)?.[0] ?? ""),
  };
}
