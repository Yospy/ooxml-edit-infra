# UI Backend Decision And Edit Contract

## Purpose

This document maps the current frontend workspace to the backend contract.

The backend must support the UI as a controlled editing system:

```text
frontend context + user prompt
  -> backend graph + AI planner
  -> plan or decision request
  -> user approval/answer
  -> deterministic PPTX mutation
  -> render + validation
  -> review, accept, export
```

The important product rule:

```text
AI proposes. User decides. Backend executes deterministically.
```

## Current UI Surface

The reviewed UI has these functional areas:

- Upload screen.
- Processing progress: upload, parse, render, validate.
- Slide rail with slide status.
- Center render canvas for backend-rendered slide preview and before/after review.
- Agent Panel for prompt, tool chips, planning, approvals, questions, validation, and accept/reject.
- Top export action.
- Bottom trust strip with original, active version, parent version, changed slides, warnings, and export status.

The frontend already models blocking user input through:

```ts
ToolChip.input:
  | { mode: "yes_no"; primary; secondary }
  | { mode: "single_choice"; options }
  | { mode: "free_text"; placeholder }
```

Backend should map every question, approval, risk confirmation, repair choice, and export confirmation into that primitive.

## Responsibility Split

### Frontend Owns

- Display layout.
- Slide and element selection.
- User prompt collection.
- Rendering backend events/chips.
- Showing decision controls.
- Submitting normalized user responses.
- Showing backend render URLs, validation summaries, version lineage, and export state.

### Backend Owns

- Immutable original PPTX storage.
- PPTX parsing and canonical graph creation.
- Version lineage and active version pointer.
- Target resolution.
- AI plan creation.
- Decision request creation.
- Deterministic PPTX mutation.
- Rendering.
- Validation.
- Accept/reject/restore/export state transitions.

The frontend must not be the source of truth for PPTX mutation, render fidelity, validation, or export readiness.

## Core Backend Objects

```text
Deck
Version
Slide
SlideElement
SlideRender
CanonicalGraph
EditRequest
TargetResolution
EditPlan
EditOperation
DecisionRequest
DecisionResponse
Job
ValidationResult
ReviewResult
ExportArtifact
```

## Edit Request Input

When the user submits a prompt, the frontend should send both the prompt and all available UI context.

```json
{
  "deckId": "deck_123",
  "versionId": "v1",
  "message": "Make this title shorter and preserve the same style.",
  "selectedSlideId": "slide_3",
  "selectedElementIds": ["shape_title"],
  "visibleSlideIds": ["slide_2", "slide_3", "slide_4"],
  "uiMode": "ready",
  "clientContext": {
    "activePanel": "agent",
    "selectedTool": null,
    "selectionBounds": {
      "x": 914400,
      "y": 457200,
      "w": 5486400,
      "h": 685800,
      "unit": "emu"
    },
    "intentHint": "text_edit",
    "preferredOutput": "preserve_layout"
  }
}
```

Optional fields are useful but not required. Backend behavior should degrade safely:

- If `selectedElementIds` exist, target resolution starts there.
- If only `selectedSlideId` exists, target resolution ranks elements on that slide.
- If no selection exists, target resolution searches the deck graph.
- If confidence is low, backend returns a `DecisionRequest` instead of guessing.

## Planning Output

An edit request must not mutate PPTX.

It returns one of:

```text
1. EditPlan awaiting approval
2. DecisionRequest requiring user input
3. Failure with recovery options
```

Example plan:

```json
{
  "planId": "plan_456",
  "deckId": "deck_123",
  "createdFromVersionId": "v1",
  "status": "awaiting_approval",
  "summary": "Shorten the slide 3 title while preserving existing style and bounds.",
  "targetResolution": {
    "targetRef": "slide_3.shape_title",
    "confidence": 0.94,
    "reason": "Selected slide and title role match the prompt."
  },
  "affectedSlides": ["slide_3"],
  "operations": [
    {
      "operationId": "op_1",
      "operationType": "replace_text",
      "targetRef": "slide_3.shape_title",
      "humanLabel": "Slide 3 title",
      "before": "Q3 Revenue",
      "after": "Q3 Growth",
      "preserveStyle": true,
      "preserveBounds": true
    },
    {
      "operationId": "op_2",
      "operationType": "fit_text",
      "targetRef": "slide_3.shape_title",
      "humanLabel": "Refit title inside original bounds",
      "preserveStyle": true,
      "preserveBounds": true
    }
  ],
  "risks": [],
  "requiresApproval": true
}
```

## Decision Gate Contract

Use one backend object for all blocking user input.

```json
{
  "decisionId": "decision_789",
  "deckId": "deck_123",
  "versionId": "v1",
  "planId": "plan_456",
  "kind": "approval",
  "title": "Apply edit plan to v1",
  "question": "Apply this 2-operation edit plan?",
  "context": "Slide 3 title: Q3 Revenue -> Q3 Growth. Preserve style and bounds.",
  "inputMode": "yes_no",
  "options": [
    {
      "id": "apply",
      "label": "Apply edit",
      "description": "Create a new version and run validation."
    },
    {
      "id": "reject",
      "label": "Reject",
      "description": "Return to the prompt without changing the deck."
    }
  ],
  "defaultOptionId": "apply",
  "required": true,
  "blocksWorkflow": true
}
```

Supported kinds:

```text
clarification
approval
risk_confirmation
repair_approval
export_confirmation
```

Supported input modes:

```text
yes_no
single_choice
free_text
```

Frontend rendering mapping:

```text
DecisionRequest.inputMode=yes_no
  -> ToolChip.input.mode=yes_no

DecisionRequest.inputMode=single_choice
  -> ToolChip.input.mode=single_choice

DecisionRequest.inputMode=free_text
  -> ToolChip.input.mode=free_text
```

## Decision Response Input

Frontend should answer decisions through one normalized endpoint.

```json
{
  "decisionId": "decision_789",
  "deckId": "deck_123",
  "versionId": "v1",
  "selectedOptionId": "apply",
  "answerText": null
}
```

Backend response depends on decision kind:

- Approval accepted: starts deterministic apply job.
- Approval rejected: marks plan rejected and returns ready state.
- Clarification answered: resumes planning and returns plan or another decision.
- Risk confirmed: proceeds only if selected option permits it.
- Repair approved: starts deterministic repair apply job.
- Export confirmed: creates export artifact if validation allows it.

## Endpoint Mapping

```text
POST /api/decks/upload
  input: pptx file
  output: deckId, jobId

GET /api/jobs/:jobId
  output: job status, progress, result

GET /api/decks/:deckId/status
  output: DeckStatus for slide rail, canvas, trust strip, export state

POST /api/decks/:deckId/edit-requests
  input: message + versionId + optional UI context
  output: EditPlan or DecisionRequest or failure

POST /api/decks/:deckId/decisions/:decisionId/respond
  input: selectedOptionId or answerText
  output: next state, jobId, EditPlan, DecisionRequest, or ReviewResult

POST /api/decks/:deckId/versions/:versionId/accept
  output: updated DeckStatus

POST /api/decks/:deckId/versions/:versionId/reject
  input: restoreVersionId
  output: updated DeckStatus

POST /api/decks/:deckId/versions/:versionId/restore
  output: updated DeckStatus

POST /api/decks/:deckId/versions/:versionId/export
  output: ExportArtifact or DecisionRequest if confirmation is needed
```

## UI State Mapping

```text
upload_empty
  -> no backend deck yet

uploading
  -> POST /api/decks/upload running

processing
  -> parse/render/validate job running

ready
  -> DeckStatus has rendered slides and no blocking chip

planning
  -> edit request job running

awaiting_plan_approval
  -> backend returned DecisionRequest or plan requiring approval

editing
  -> approved plan is being applied deterministically

validating
  -> edited version is being rendered and checked

review_ready
  -> ReviewResult available with before/after renders and validation

accepted
  -> reviewed version accepted as active/accepted
```

## End-To-End Flow

### Upload

```text
UI: user uploads .pptx
Backend: store immutable original
Backend: create working version v1
Backend: parse PPTX into canonical graph
Backend: render slide thumbnails/previews
Backend: validate baseline
UI: show workspace
```

### Prompt To Plan

```text
UI sends prompt + selected slide/element context
Backend loads graph for active version
Backend resolves likely target
AI planner creates plan or asks clarification
Backend persists plan/decision
UI shows chip with plan/question
```

### Decision To Mutation

```text
UI submits DecisionResponse
Backend validates decision is current
Backend rejects stale version/plan
Backend marks plan approved
Backend applies deterministic operations to new version
Backend renders affected slides
Backend validates changed and impacted slides
Backend returns ReviewResult
```

### Review To Accept/Reject

```text
UI shows before/after and validation
User accepts:
  backend marks version accepted
User rejects:
  backend marks output rejected and restores prior version
User repairs:
  backend creates repair plan and uses same decision gate
```

### Export

```text
UI requests export for version
Backend checks render + validation status
Backend blocks export on blocking issues
Backend may allow warnings if surfaced
Backend creates export artifact
UI shows export prepared/download state
```

## Deterministic vs Non-Deterministic Boundaries

### Non-Deterministic

- Understanding natural language prompts.
- Ranking target candidates.
- Rewriting text.
- Proposing edit plans.
- Deciding whether more clarification is needed.

### Deterministic

- PPTX storage.
- OOXML parsing.
- Canonical graph indexing.
- Target ref validation.
- Plan/version staleness checks.
- Applying approved operations.
- Text fitting rules.
- Version creation.
- Rendering.
- Validation.
- Accept/reject/restore/export.

Rule:

```text
No non-deterministic component writes PPTX files.
```

## Nuanced Editing Model

The product should not edit every slide for every request.

The backend should edit the smallest approved scope:

- Selected element when available.
- Selected slide when implied.
- Multiple slides only when the prompt asks for a deck-wide/theme/layout change.
- Related slides only when validation or shared layout/master impact requires it.

Validation scope can be wider than edit scope:

- Deep validation for changed slides.
- Impact validation for related slides.
- Export validation for the full deck.

This is how the system solves the final 10% problem:

```text
AI gets close through intent.
Graph locates exact slide objects.
Decision gate prevents risky guesses.
Deterministic edit engine preserves PPTX nuance.
Renderer and validator prove the output.
```

## Backend Event To Agent Panel Mapping

```text
user prompt accepted
  -> AgentEvent.user_message

target resolution started
  -> ToolChip verb=resolve_target status=running

target resolved
  -> ToolChip body.kind=target_resolution

plan created
  -> ToolChip verb=create_plan status=done

approval required
  -> ToolChip verb=apply_plan status=awaiting_input input=yes_no

plan applied
  -> ToolChip verb=apply_plan status=done

render started/completed
  -> ToolChip verb=render

validation started/completed
  -> ToolChip verb=validate body.kind=validation

accept required
  -> ToolChip verb=accept_version status=awaiting_input input=yes_no

failure recoverable
  -> ToolChip status=failed failure.recovery options
```

## Failure And Recovery

Backend failures should be actionable and UI-renderable.

```json
{
  "code": "LOW_TARGET_CONFIDENCE",
  "message": "I found multiple title-like elements on this slide.",
  "recovery": [
    {
      "id": "choose_title",
      "label": "Choose title",
      "description": "Ask the user which element to edit."
    },
    {
      "id": "cancel",
      "label": "Cancel"
    }
  ]
}
```

Recoverable failures should usually become `DecisionRequest` objects. Hard failures should preserve the active version and return a stable error.

## Implementation Order

1. Implement `DeckStatus`, jobs, and static file artifact serving.
2. Replace frontend mocks with real upload/status/job polling.
3. Implement edit request endpoint that returns mocked `EditPlan` and `DecisionRequest`.
4. Wire frontend `ToolChip.input` to `/decisions/:decisionId/respond`.
5. Implement canonical graph extraction for text boxes.
6. Implement deterministic `replace_text` and `fit_text`.
7. Add render, validation, review, accept/reject, restore, export.

## Invariants

- Original PPTX is immutable.
- Prompt submission never mutates PPTX.
- Approval is the first mutation point.
- Every mutation creates a new version.
- Plans are bound to the version they were created from.
- Stale plan approvals are rejected.
- UI displays backend renders as visual truth.
- Export requires backend render and validation.
- Decision requests block the workflow until answered or cancelled.
