# Official PowerPoint And Google Slides Renderer Context

## Purpose

Replace the current backend SVG preview renderer with official-provider rendering while keeping the preview inside our web app.

Current local MVP:

```text
PPTX -> backend parser -> SVG preview -> UI
```

Target next renderer architecture:

```text
PPTX / Google Slides source
  -> official renderer provider
  -> backend-cached preview images / PDF artifacts
  -> existing UI renderUrl / thumbnailUrl
```

The frontend should not redirect users to PowerPoint, OneDrive, Google Drive, or Google Slides. Provider rendering happens behind the backend, and the UI continues to display backend artifact URLs.

## Current Backend State

The current backend already has the correct renderer seam:

- `DeckStatus.slides[].renderUrl`
- `DeckStatus.slides[].thumbnailUrl`
- `ReviewResult.slidePreviews[].before.renderUrl`
- `ReviewResult.slidePreviews[].after.renderUrl`
- `/api/artifacts/:artifactId`

So the UI does not need a major redesign. The next implementation should replace the backend render provider, not the frontend workflow.

## Provider Strategy

Use a renderer adapter interface:

```text
RendererProvider
  renderVersion(input) -> RenderedSlideArtifacts
```

Recommended providers:

```text
1. microsoft_graph_powerpoint
2. google_slides_thumbnail
3. svg_fallback
```

Default routing:

```text
.pptx / .ppt / .ppsx upload
  -> microsoft_graph_powerpoint

Google Slides file/import source
  -> google_slides_thumbnail

Provider unavailable or unsupported
  -> svg_fallback with explicit fidelity warning
```

PowerPoint should be the primary provider for uploaded PPTX because the product promise is PPTX preservation. Google Slides is useful for Google-native presentations or as a secondary option, but Google conversion may change layout/fonts/charts.

## Microsoft PowerPoint Rendering

Recommended first Microsoft path:

```text
PPTX
  -> upload temp copy to OneDrive/SharePoint render folder
  -> Microsoft Graph convert to PDF
  -> backend downloads rendered PDF
  -> backend splits/rasterizes PDF pages into per-slide images
  -> cache images as artifacts
  -> delete temp cloud copy when safe
```

Why PDF first:

- Microsoft Graph v1.0 supports downloading a Drive item in another format using `GET /drive/items/{item-id}/content?format={format}`.
- The Graph docs list `pdf` conversion support for `ppt` and `pptx`.
- PDF preserves multi-slide layout better than trying to infer slides from raw XML.

Frontend stays unchanged:

```text
renderUrl = /api/artifacts/<slide-render-id>
thumbnailUrl = /api/artifacts/<slide-thumb-id>
```

Important implementation details:

- Use a dedicated Microsoft render workspace/folder.
- Store provider item IDs and render metadata in DB/artifact metadata.
- Follow Graph redirect/download behavior and cache the final PDF/images locally.
- Clean up temporary OneDrive/SharePoint files.
- Preserve original PPTX locally as the source of truth.

Official docs:

- Microsoft Graph file conversion: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format?view=graph-rest-1.0
- Microsoft 365 for web / WOPI iframe integration: https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/

WOPI note:

WOPI can embed Microsoft 365 for the web in an iframe, but it is a heavier partner-style integration. It requires implementing WOPI host endpoints and is not the fastest path for cached slide previews. Use Graph conversion first; revisit WOPI later if interactive in-browser Office editing becomes a product requirement.

## Google Slides Rendering

Recommended Google path:

```text
PPTX or Google Slides source
  -> upload/convert through Google Drive when needed
  -> open as Google Slides presentation
  -> list pages
  -> call presentations.pages.getThumbnail for each page
  -> backend downloads thumbnail contentUrl
  -> cache images locally
  -> UI displays backend artifact URLs
```

Important implementation details:

- The Google Slides thumbnail API returns a temporary `contentUrl`.
- Backend must download/cache that image immediately.
- Use `LARGE` thumbnail size for main slide previews and smaller cached versions for thumbnails.
- Do not let the frontend use Google `contentUrl` directly; serve cached backend artifacts.
- Mark renders as `provider=google_slides_thumbnail` so fidelity differences are traceable.

Official docs:

- Google Slides page thumbnails: https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations.pages/getThumbnail
- Google Drive uploads/conversion entrypoint: https://developers.google.com/workspace/drive/api/guides/manage-uploads

## Detection Rules

Add a `source_type` and `render_provider` decision step during upload/import.

Suggested source types:

```text
powerpoint_pptx
powerpoint_legacy
google_slides
unsupported
```

Detection inputs:

- File extension.
- MIME type.
- ZIP/package signature for `.pptx`.
- Google Drive MIME type when importing from Drive.
- Existing presentation provider metadata if the deck was created from a cloud source.

Routing:

```text
powerpoint_pptx
  -> microsoft_graph_powerpoint

powerpoint_legacy
  -> microsoft_graph_powerpoint if supported
  -> fallback/error if conversion fails

google_slides
  -> google_slides_thumbnail

unsupported
  -> reject upload or svg_fallback only if explicitly allowed
```

## Backend Changes Needed Next

Add provider abstractions:

```text
src/renderers/renderer-provider.ts
src/renderers/svg-renderer.ts
src/renderers/microsoft-graph-renderer.ts
src/renderers/google-slides-renderer.ts
```

Add render metadata:

```text
artifacts.provider
artifacts.provider_metadata_json
artifacts.render_fidelity
```

Suggested render fidelity values:

```text
official_powerpoint
google_converted
local_svg_fallback
failed
```

Add env placeholders:

```env
# Microsoft render provider
MICROSOFT_TENANT_ID=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_RENDER_DRIVE_ID=
MICROSOFT_RENDER_FOLDER_ID=

# Google render provider
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_RENDER_FOLDER_ID=
```

Keep API shape stable:

```text
POST /api/decks/upload
GET  /api/decks/:deckId/status
GET  /api/artifacts/:artifactId
```

Do not expose provider URLs to the frontend. Only expose cached backend artifact URLs.

## Frontend Impact

Minimal.

The frontend already reads:

```ts
slide.renderUrl
slide.thumbnailUrl
reviewResult.slidePreviews[].before.renderUrl
reviewResult.slidePreviews[].after.renderUrl
```

Possible UI additions:

- Render fidelity badge:
  - `PowerPoint render`
  - `Google render`
  - `SVG fallback`
- Render failure chip in Agent Panel.
- Warning in trust strip if fallback renderer was used.

No redirect is needed. No iframe is required for the first implementation.

## Testing Strategy

Backend API tests:

- Upload PPTX routes to `microsoft_graph_powerpoint` when provider config is present.
- Upload PPTX falls back to SVG only when provider is unavailable and fallback is enabled.
- Google Slides source routes to `google_slides_thumbnail`.
- Provider artifact URLs are cached locally and served through `/api/artifacts/:artifactId`.
- Google temporary thumbnail URLs are never returned directly to the UI.
- Failed provider render preserves deck/version state and surfaces recoverable error.

Integration tests should mock Microsoft/Google APIs. Do not call real provider APIs in normal test runs.

Manual provider smoke tests:

- Upload sample PPTX.
- Confirm Microsoft-rendered PDF/images are cached locally.
- Confirm UI shows PowerPoint-rendered preview inside the app.
- Apply edit to create `v2`.
- Confirm before/after renders use the same provider.
- Export still returns the edited PPTX, not the rendered PDF/image.

## Product Decision

Recommended next-thread implementation target:

```text
Implement Microsoft Graph PDF render provider first.
Keep current SVG renderer as explicit fallback.
Add Google Slides thumbnail provider after Microsoft path is stable.
```

Reason:

The core product is reliable editing of existing PPTX decks. Microsoft rendering is closer to the user's real PowerPoint output, while Google Slides introduces a conversion layer that can change layout.

## Research Addendum 2026-05-09

Verified against current official docs:

- Microsoft Graph v1.0 supports `GET /drive/items/{item-id}/content?format=pdf`; `ppt`, `pptx`, and `ppsx` are listed PDF conversion sources. The response can be a `302` to a short-lived preauthenticated download URL, so the backend must follow and cache it immediately.
- Microsoft small file upload supports a single `PUT .../content` up to 250 MB. Larger decks need a Graph upload session.
- Microsoft Graph throttling returns `429` and commonly `Retry-After`; renderer calls must use bounded retries and respect the header.
- Google Slides `presentations.pages.getThumbnail` returns a temporary `contentUrl`, defaults to PNG, and supports `LARGE` width around 1600 px, `MEDIUM` 800 px, and `SMALL` 200 px.
- Google counts `getThumbnail` as an expensive read request. Current documented quota is 300 expensive reads/min/project and 60 expensive reads/min/user/project, so large decks need concurrency limits.
- Google Drive can upload and convert Microsoft PowerPoint/OpenDocument Presentation into Google Slides, but this is a conversion path and can change fidelity.
- WOPI/Microsoft 365 for the web is not the first implementation path. It is a partner-style iframe integration requiring WOPI host endpoints and Cloud Storage Partner Program eligibility.

Primary references:

- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/throttling
- https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations.pages/getThumbnail
- https://developers.google.com/workspace/slides/api/limits
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/guides/ref-export-formats
- https://learn.microsoft.com/en-us/microsoft-365/cloud-storage-partner-program/online/

Recommended production architecture:

```text
Upload/import
  -> detect source type
  -> persist immutable source PPTX / cloud source metadata
  -> parse deck for slide identity and editable graph
  -> render job selects provider
  -> provider creates canonical render artifact set
  -> artifact store serves only backend URLs
```

Provider output should include:

```ts
type RenderedSlideArtifacts = {
  provider: "microsoft_graph_powerpoint" | "google_slides_thumbnail" | "svg_fallback";
  fidelity: "official_powerpoint" | "google_converted" | "local_svg_fallback" | "failed";
  sourceVersionId: string;
  slides: Array<{
    slideId: string;
    pageIndex: number;
    renderArtifactId: string;
    thumbnailArtifactId: string;
    width: number;
    height: number;
  }>;
  providerMetadata: Record<string, unknown>;
};
```

Implementation sequence:

1. Add artifact metadata columns first: `provider`, `render_fidelity`, `provider_metadata_json`, `width_px`, `height_px`.
2. Replace direct `renderGraphSlides(...)` calls with `renderer.renderVersion(...)`; keep SVG as the local implementation of that interface.
3. Add Microsoft provider behind config flags. Upload temp file to a dedicated render folder, convert to PDF, download PDF, rasterize pages, save `slide_render` and `slide_thumbnail` artifacts, then delete the cloud temp item.
4. Add PDF rasterization via a checked runtime dependency (`pdftoppm`/Poppler or `mutool`) and fail fast at startup when Microsoft rendering is enabled but the binary is missing.
5. Add routing and fallback policy:
   - PPTX with Microsoft configured: Microsoft.
   - Google-native import with Google configured: Google thumbnails.
   - Provider failure: fallback only if `RENDER_SVG_FALLBACK_ENABLED=true`; otherwise mark render failed.
6. Add Google provider after Microsoft stabilizes. Download each `contentUrl` immediately and never expose it to the browser.

Reliability rules:

- Bound provider concurrency per deck and globally.
- Retry only idempotent steps; use provider item IDs and version IDs for idempotency.
- Respect Microsoft `Retry-After`; use truncated exponential backoff for Google 429s.
- Treat slide-count mismatch between parsed PPTX and rendered PDF/pages as a render failure.
- Store cleanup state and run a cleanup sweeper for orphaned Microsoft/Google temp files.
- Never let render artifacts replace the editable PPTX source of truth.
