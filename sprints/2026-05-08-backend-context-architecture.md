# Backend Context Architecture

## Scope

Create a detailed backend context document for the PPTX editing system. The document should define storage, API shape, job flow, LLM planning boundaries, deterministic edit execution, rendering, validation, and MVP sequencing.

## Assumptions

- Backend is local-first for now.
- Filesystem stores PPTX packages, extracted parts, renders, diffs, and exports.
- SQLite stores metadata, state, plans, jobs, operations, and validation.
- The LLM plans edits but never mutates files directly.
- All mutations require user approval and create a new version.

## Architectural Decisions

- Treat uploaded PPTX as immutable original truth.
- Build around a canonical deck graph with XML provenance.
- Use job-based async processing for upload, parse, render, apply, validate, and export.
- The frontend displays backend-generated render images only.
- Start with text and layout-preserving edits before charts, tables, SmartArt, animations, and complex masters.

## Tasks

1. Review existing frontend and storage context docs.
2. Create a backend architecture/context doc under `context/`.
3. Include ASCII diagrams and concrete schemas/contracts.
4. Define MVP accuracy focus and non-goals.
5. Verify the doc exists and aligns with existing context files.

## Risks

- Over-scoping into every PPTX capability before the narrow edit engine works.
- Blurring the LLM boundary and allowing non-deterministic file mutation.
- Under-specifying render/validation outputs needed by the frontend.

## Verification Strategy

- Read the created document.
- Check it references the agreed frontend contract.
- Check it preserves the original-version invariant.
- Check it clearly separates LLM planning from deterministic execution.
