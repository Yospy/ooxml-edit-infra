import type { CanonicalGraph, SQLiteRepository } from "./repository.js";

export function validateVersion(input: {
  repo: SQLiteRepository;
  graph: CanonicalGraph;
  changedSlides?: string[];
}): void {
  const { repo, graph } = input;
  repo.clearValidation(graph.presentationId, graph.versionId);

  if (!graph.slides.length) {
    repo.addValidationIssue({
      presentationId: graph.presentationId,
      versionId: graph.versionId,
      slideId: null,
      issueType: "render_failure",
      severity: "blocking",
      message: "No slides were parsed from the PPTX package.",
      targetRef: null,
      details: {},
    });
    return;
  }

  for (const slide of graph.slides) {
    if (!slide.elements.length) {
      repo.addValidationIssue({
        presentationId: graph.presentationId,
        versionId: graph.versionId,
        slideId: slide.slideId,
        issueType: "missing_object",
        severity: "warning",
        message: `Slide ${slide.number} has no parsed text elements.`,
        targetRef: null,
        details: {},
      });
    }
    for (const element of slide.elements) {
      if (!element.text.trim()) {
        repo.addValidationIssue({
          presentationId: graph.presentationId,
          versionId: graph.versionId,
          slideId: slide.slideId,
          issueType: "text_overflow",
          severity: "blocking",
          message: `Empty text detected in ${slide.slideId}.${element.elementId}.`,
          targetRef: `${slide.slideId}.${element.elementId}`,
          details: {},
        });
      }
    }
  }
}
