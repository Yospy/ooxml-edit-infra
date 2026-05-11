# Separate Backend UI Integration

## Scope

Implement a separate Node/TypeScript backend in `backend/` and integrate the existing `UI/` Next app with it through real HTTP APIs.

This sprint covers the contract-real first slice: real server, real routes, real request/response validation, real frontend integration, mocked PPTX internals.

## Assumptions

- Backend uses Fastify on `localhost:4000`.
- UI remains a separate Next app on `localhost:3000`.
- REST + polling is enough for the first slice.
- In-memory repository is acceptable for this slice if hidden behind service/repository boundaries.
- Real PPTX parsing, rendering, deterministic XML editing, SQLite, and artifact storage come in later sprints.

## Architectural Decisions

- Keep `backend/` independent from `UI/` with its own package manifest and TypeScript config.
- Use backend-compatible contract types that mirror the UI model.
- Preserve the invariant that prompt submission creates a plan/decision only and never mutates a deck.
- Route all blocking user input through the generic decision response endpoint.
- Simulate job progress on the backend so the UI is no longer the source of backend workflow timing.

## Tasks

1. Create backend project scaffolding under `backend/`.
2. Implement contract models, repository, workflow service, and Fastify routes.
3. Add backend tests for upload, status, edit request, decisions, accept/reject/export, and stale decisions.
4. Replace UI scripted mock backend client with HTTP client methods.
5. Update the UI page to call backend APIs, poll jobs, and render backend events.
6. Run backend tests/typecheck and UI typecheck.
7. Start backend and UI locally and manually validate the edit flow.

## Risks

- UI mock script timing may be tightly coupled to local helper functions.
- Contract shape drift between backend JSON and UI camelCase TypeScript types.
- Fastify multipart dependency may require installing new packages.
- Existing untracked UI/context files should not be reverted or reformatted unnecessarily.

## Verification Strategy

- `npm test` in `backend/`.
- `npm run typecheck` in `backend/`.
- `npm run typecheck` in `UI/`.
- Manual browser check: upload mock deck, prompt edit, approve, review, accept, export.
- Diff review for minimal scope and invariants.
