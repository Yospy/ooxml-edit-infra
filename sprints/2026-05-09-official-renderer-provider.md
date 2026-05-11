# 2026-05-09 Official Renderer Provider Sprint

## Scope

Replace the current backend-owned SVG preview renderer with provider-backed PowerPoint/Google Slides rendering while preserving the existing web app preview contract: `renderUrl`, `thumbnailUrl`, review before/after URLs, and `/api/artifacts/:artifactId`.

## Assumptions

- Uploaded `.ppt`, `.pptx`, and `.ppsx` decks should prefer Microsoft PowerPoint rendering.
- Google Slides rendering is for Google-native imports or an explicit secondary path, not the default for PPTX uploads.
- The frontend must never receive Microsoft/Google temporary URLs.
- Provider rendering is a backend concern; UI changes should be limited to fidelity/status badges and failure messages.
- Real provider calls are excluded from normal automated tests.

## Architectural Decisions

- Add a `RendererProvider` boundary and route by source type plus provider availability.
- Implement Microsoft first as `PPTX -> Graph upload -> Graph PDF conversion -> local PDF -> page images -> artifact URLs`.
- Keep SVG as an explicit fallback with metadata and a user-visible fidelity warning.
- Add Google later as `Google Slides presentation -> pages.getThumbnail(LARGE) -> immediate backend cache`.
- Store provider metadata on artifacts so render provenance, source file IDs, retries, and cleanup state are auditable.
- Use a bounded async render job with retries/backoff instead of blocking request handling once provider calls are real.

## Tasks

1. Extend artifact/schema metadata for provider, fidelity, provider item IDs, render dimensions, and failure reason.
2. Add source detection for PowerPoint, Google Slides, and unsupported inputs.
3. Define `RendererProvider` with Microsoft, Google, and SVG implementations.
4. Implement Microsoft Graph upload, PDF conversion, local download, PDF rasterization, artifact save, and cloud cleanup.
5. Add render job state, retries, timeout handling, and user-visible failure/fallback states.
6. Add tests with mocked Microsoft/Google clients proving routing, caching, fallback, and URL isolation.
7. Run backend tests/typecheck and manually smoke-test one real Microsoft render in a controlled tenant.

## Risks

- Microsoft Graph conversion depends on tenant/app permissions and can be throttled.
- Temporary Microsoft/Google URLs are short-lived and must be downloaded immediately.
- PDF rasterization adds a native runtime dependency such as Poppler or MuPDF.
- Google conversion can alter PPTX layout, so it should not silently replace PowerPoint fidelity.
- Uploaded decks may contain confidential data; temp cloud storage needs retention, deletion, and access controls.

## Verification Strategy

- Unit tests mock provider APIs and assert no provider URLs leak to API responses.
- Integration tests assert each slide has cached backend image artifacts and matching slide counts.
- Failure tests cover provider unavailable, timeout, throttling, conversion mismatch, and cleanup failure.
- Manual smoke test verifies uploaded PPTX renders through Microsoft, before/after renders stay provider-consistent, and export still returns PPTX.
- Diff review checks minimal API drift and no frontend contract breakage.
