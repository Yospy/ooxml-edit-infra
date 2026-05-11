# Backend Context Alignment

## Scope

Update the backend architecture context so it reflects the sharpened product target: eliminate the manual final-edit burden for existing PPTX decks through deterministic accuracy.

## Assumptions

- The main competitor baseline is not blank deck generation; ChatGPT/Claude can already generate first drafts.
- The hard user pain is the final 10% of precise edits on real decks.
- The backend should remain local-first and narrow for MVP.

## Architectural Decisions

- Define the product as a finishing/editing system for existing decks, not a generation system.
- Add target resolution as an explicit backend step before AI planning.
- Explain canonical graph creation as a concrete unzip/parse/index/provenance flow.
- Keep mutation deterministic and render-validated.

## Tasks

1. Review current backend architecture context.
2. Identify gaps against the final-10%-accuracy wedge.
3. Patch `context/backend-architecture-context.md`.
4. Verify the updated context still aligns with existing invariants and implementation phases.

## Risks

- Making the context too broad before backend implementation starts.
- Overstating reliability before real deck testing.
- Blurring AI planning with deterministic mutation.

## Verification Strategy

- Diff-review the context changes.
- Confirm references to immutable original, graph, target resolution, deterministic edits, and render validation.
