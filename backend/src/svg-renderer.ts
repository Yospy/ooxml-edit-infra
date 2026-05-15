import type { ArtifactRow, CanonicalGraph, GraphSlide, SQLiteRepository } from "./repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { escapeHtml } from "./xml.js";

const WIDTH = 960;
const HEIGHT = 540;
const TEXT_WIDTH_FACTOR = 0.55;
const TEXT_HIGHLIGHT_WIDTH_FACTOR = 0.48;
const TEXT_GLYPH_TOP_FACTOR = 0.18;
const TEXT_GLYPH_HEIGHT_FACTOR = 1;

type SlideRenderOptions = {
  highlightElementIds?: string[];
};

export function renderGraphSlides(input: {
  graph: CanonicalGraph;
  repo: SQLiteRepository;
  store: ArtifactStore;
}): ArtifactRow[] {
  const artifacts: ArtifactRow[] = [];
  for (const slide of input.graph.slides) {
    const renderPath = input.store.renderPath(
      input.graph.presentationId,
      input.graph.versionId,
      slide.slideId,
    );
    const thumbPath = input.store.thumbnailPath(
      input.graph.presentationId,
      input.graph.versionId,
      slide.slideId,
    );
    input.store.writeText(renderPath, slideToSvg(slide, WIDTH, HEIGHT));
    input.store.writeText(thumbPath, slideToSvg(slide, 320, 180));
    artifacts.push(
      input.repo.saveArtifact({
        presentationId: input.graph.presentationId,
        versionId: input.graph.versionId,
        type: "slide_render",
        path: renderPath,
        contentType: "image/svg+xml; charset=utf-8",
        slideId: slide.slideId,
      }),
    );
    artifacts.push(
      input.repo.saveArtifact({
        presentationId: input.graph.presentationId,
        versionId: input.graph.versionId,
        type: "slide_thumbnail",
        path: thumbPath,
        contentType: "image/svg+xml; charset=utf-8",
        slideId: slide.slideId,
      }),
    );
  }
  return artifacts;
}

export function slideToSvg(
  slide: GraphSlide,
  width = WIDTH,
  height = HEIGHT,
  options: SlideRenderOptions = {},
): string {
  const scaleX = width / slide.widthEmu;
  const scaleY = height / slide.heightEmu;
  const highlighted = new Set(options.highlightElementIds ?? []);
  const background = normalizeHexColor(slide.backgroundColor) ?? "#ffffff";
  const elements = slide.elements
    .map((element) => {
      const fontSize = element.role === "title" ? 34 : 18;
      const x = element.bounds.x * scaleX;
      const y = element.bounds.y * scaleY + fontSize;
      const weight = element.role === "title" ? 700 : 400;
      const maxWidth = Math.max(160, element.bounds.w * scaleX);
      const text = truncate(element.text, maxWidth, fontSize);
      const highlightWidth = estimateTextWidth(text, fontSize, maxWidth);
      const highlightY = element.bounds.y * scaleY + fontSize * TEXT_GLYPH_TOP_FACTOR;
      const highlightHeight = fontSize * TEXT_GLYPH_HEIGHT_FACTOR;
      const highlight = highlighted.has(element.elementId)
        ? `<rect x="${x.toFixed(1)}" y="${highlightY.toFixed(1)}" width="${highlightWidth.toFixed(1)}" height="${highlightHeight.toFixed(1)}" rx="4" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>`
        : "";
      return `${highlight}<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="#111827">${escapeHtml(text)}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <rect width="${width}" height="${height}" fill="${background}"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="none" stroke="#d1d5db"/>
  ${elements}
</svg>`;
}

function normalizeHexColor(value: string | undefined): string | undefined {
  if (!value || !/^[0-9A-Fa-f]{6}$/.test(value)) return undefined;
  return `#${value.toUpperCase()}`;
}

function truncate(text: string, maxWidth: number, fontSize: number): string {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * TEXT_WIDTH_FACTOR)));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function estimateTextWidth(text: string, fontSize: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(fontSize, text.length * fontSize * TEXT_HIGHLIGHT_WIDTH_FACTOR));
}
