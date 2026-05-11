# Final Edit Feedback Data Flywheel

## Scope

- Capture proprietary feedback only for final review decisions on real edited slide versions.
- Store each final accept/reject event as JSON under root `data/final-change-events/`.
- Add machine-readable decision metadata so clarification questions cannot be confused with final edit feedback.
- Update the existing frontend chip flow to display final edit review as `Accept Edit`, `Refine Further`, and `Reject`.

## Assumptions

- Backend remains the source of truth for whether a decision is capture-worthy.
- Internal edit plans remain execution contracts, but plan approval is not proprietary feedback.
- `Refine Further` is not a final judgment and must not write data.
- For v1, affected slide graph snapshots and render artifact paths are sufficient.

## Architectural Decisions

- Add `purpose`, `sourceVersionId`, and `subjectVersionId` metadata to `DecisionRequest`.
- Capture inside the backend final review decision response path only when the edited version was created by the referenced plan.
- Write append-only JSON files with generated IDs; do not add a database table for v1.
- Store root data separately from backend runtime artifacts.

## Tasks

1. Add shared decision metadata types to backend and frontend.
2. Add `ProprietaryDataStore` to write final change event JSON files under root `data/`.
3. Inject the store into `WorkflowService`.
4. Tag apply-plan decisions as non-capture and final review decisions as `final_edit_review`.
5. Capture accepted/rejected final review decisions and skip refine decisions.
6. Add frontend support for three-option final review chips.
7. Add backend tests for accepted, rejected, apply-plan, and refine/no-capture cases.
8. Run backend tests/typecheck and frontend typecheck/lint.

## Risks

- False positives if capture relies on labels instead of metadata.
- Partial data if the event is written before validating version lineage.
- Root `data/` path could drift if computed relative to backend source instead of repo root.

## Verification Strategy

- Tests assert JSON files are created only for `final_edit_review` accept/reject decisions.
- Tests assert JSON files are written under root `data/`, not `backend/data/`.
- Typechecks ensure metadata stays aligned across backend and frontend.
- Manual diff review confirms no chat history or plan approval events are captured.
