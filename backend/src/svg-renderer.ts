import type { ArtifactRow, CanonicalGraph, GraphSlide, SQLiteRepository } from "./repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { escapeHtml } from "./xml.js";

const WIDTH = 960;
const HEIGHT = 540;
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
  const elements = slide.elements
    .map((element) => {
      const x = Math.max(24, element.bounds.x * scaleX);
      const y = Math.max(44, element.bounds.y * scaleY + 28);
      const fontSize = element.role === "title" ? 34 : 18;
      const weight = element.role === "title" ? 700 : 400;
      const maxWidth = Math.max(160, element.bounds.w * scaleX);
      const highlight = highlighted.has(element.elementId)
        ? `<rect x="${(x - 8).toFixed(1)}" y="${(y - fontSize - 8).toFixed(1)}" width="${(maxWidth + 16).toFixed(1)}" height="${(fontSize + 18).toFixed(1)}" rx="8" fill="#fef3c7" stroke="#f59e0b" stroke-width="2"/>`
        : "";
      return `${highlight}<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="#111827">${escapeHtml(truncate(element.text, maxWidth, fontSize))}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="none" stroke="#d1d5db"/>
  ${elements}
</svg>`;
}

function truncate(text: string, maxWidth: number, fontSize: number): string {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.55)));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
