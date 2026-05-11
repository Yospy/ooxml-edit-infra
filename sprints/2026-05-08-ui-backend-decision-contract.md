# UI Backend Decision Contract

## Scope

Create a detailed context document that maps the current UI surface to backend API inputs, workflow decisions, deterministic edit execution, review outputs, and dynamic user elicitation.

## Assumptions

- The UI reviewed in `UI/` is the current product contract for the first backend implementation.
- The frontend displays backend truth and collects user decisions.
- AI planning is non-deterministic; PPTX mutation, versioning, rendering, validation, and export are deterministic backend responsibilities.
- One reusable decision primitive should cover approvals, clarifications, risk confirmations, repair choices, and export confirmations.

## Architectural Decisions

- Treat the Agent Panel `ToolChip.input` model as the frontend rendering primitive for all blocking backend questions.
- Use a backend `DecisionRequest` object as the normalized server-side contract.
- Ingest optional UI context on every edit request so the planner can resolve intent without guessing.
- Keep request/edit planning separate from mutation: prompt creates plan or decision; approval applies deterministic operations.

## Tasks

1. Review existing UI backend context and frontend types.
2. Create `context/ui-backend-decision-and-edit-contract.md`.
3. Include API inputs, outputs, event mapping, decision request schema, and deterministic/non-deterministic boundaries.
4. Verify the new doc aligns with existing UI states and backend invariants.

## Risks

- Duplicating existing context instead of clarifying the missing contract.
- Overfitting backend design to mock UI names that may evolve.
- Blurring question-answer decisions with mutation approval.

## Verification Strategy

- Diff-review the added sprint and context document.
- Confirm the document references upload, prompt, planning, decision, apply, validation, review, accept/reject, and export.
- Confirm backend invariants remain intact: immutable original, approval before mutation, version per mutation, backend render truth.
