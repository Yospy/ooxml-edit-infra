# 2026-05-09 Real Backend Sprint

## Scope

Replace the mock in-memory backend with a local-first backend that stores real PPTX uploads, tracks metadata in SQLite, writes artifacts to the filesystem, parses slide XML into a canonical graph, generates backend-owned SVG previews, gates mutations behind user approval, applies deterministic text edits, validates versions, and exports PPTX files through the existing frontend API contract.

## Assumptions

- Single local user for MVP.
- SQLite lives at `backend/data/app.db` by default; no `DATABASE_URL`.
- Heavy artifacts live under `backend/data/projects/...`.
- `.env` already contains `OPENAI_API_KEY`; tests must not call OpenAI.
- Rendering v1 uses SVG previews generated from parsed slide data, not LibreOffice.
- The original PPTX is immutable.

## Architecture Decisions

- Keep the current Fastify route shape so the UI client remains stable.
- Use SQLite for durable metadata and filesystem paths for artifacts.
- Use a repository boundary so future Postgres migration stays localized.
- Use an artifact-store boundary so future object storage stays localized.
- Use a planner interface with a deterministic local fallback for tests and development.
- Apply only approved `replace_text` operations in this sprint; keep `fit_text` as a planned no-op validation hint.

## Tasks

1. Add sprint and storage safety docs.
2. Add config, SQLite schema/repository, and filesystem artifact store.
3. Add PPTX extraction/parsing and SVG render generation.
4. Replace mock workflow with persistent upload/status/job/edit/decision/export flows.
5. Serve artifact URLs from Fastify.
6. Update UI render cards to use backend render URLs.
7. Replace API tests with real multipart upload, persistence, artifact, edit, accept/reject/export, stale-plan, and invalid-upload coverage.
8. Run backend typecheck/tests and UI typecheck.

## Risks

- SVG preview is not full PowerPoint rendering fidelity.
- PPTX parser covers text boxes and simple shapes first.
- XML text replacement must preserve unknown OOXML and mutate only copied versions.
- Node's built-in SQLite API is experimental on this runtime, so keep usage behind a small wrapper.

## Verification Strategy

- Backend API tests cover the full API workflow with `sample.pptx`.
- Tests use temp data dirs and a fake planner, never OpenAI.
- Typecheck backend and UI.
- Review diff for invariant drift: original immutability, approval-before-mutation, version lineage, export gating.
