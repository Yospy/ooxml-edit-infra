import type { ArtifactRow, CanonicalGraph, GraphSlide, SQLiteRepository } from "./repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { escapeHtml } from "./xml.js";

const WIDTH = 960;
const HEIGHT = 540;

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

function slideToSvg(slide: GraphSlide, width: number, height: number): string {
  const scaleX = width / slide.widthEmu;
  const scaleY = height / slide.heightEmu;
  const elements = slide.elements
    .map((element) => {
      const x = Math.max(24, element.bounds.x * scaleX);
      const y = Math.max(44, element.bounds.y * scaleY + 28);
      const fontSize = element.role === "title" ? 34 : 18;
      const weight = element.role === "title" ? 700 : 400;
      const maxWidth = Math.max(160, element.bounds.w * scaleX);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="#111827">${escapeHtml(truncate(element.text, maxWidth, fontSize))}</text>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="none" stroke="#d1d5db"/>
  ${elements}
  <line x1="48" y1="${height - 84}" x2="${width - 48}" y2="${height - 84}" stroke="#e5e7eb" stroke-width="2"/>
  <text x="48" y="${height - 48}" font-family="Arial, sans-serif" font-size="13" fill="#6b7280">Backend SVG render · ${escapeHtml(slide.slideId)}</text>
</svg>`;
}

function truncate(text: string, maxWidth: number, fontSize: number): string {
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.55)));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
