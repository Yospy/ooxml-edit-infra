# UI Frontend Flow Context

## Goal

Define the frontend workflow and backend coordination contract for the PPTX editor UI.

The UI is a professional, minimal, monochrome workspace built with Next.js and shadcn components. It displays backend-generated truth, collects user intent, lets the agent reason through an edit plan in the right panel, and requires explicit user approval before any backend mutation is executed.

## Core UI Principle

The frontend does not render, mutate, validate, or diff PPTX files as source of truth.

```text
backend owns: PPTX versions, slide renders, diffs, validation, export
frontend owns: display, selection, agent panel, plan approval, user decisions
```

## Product Surface

The app is a deck review workspace, not a marketing page and not a chat-first product. Chat is the primary input mode inside the right-side Agent Panel, but the product surface is controlled review, approval, validation, and version management.

```text
+----------------+------------------------------+------------------------+
| Slide Rail     | Slide Preview / Diff Canvas   | Agent Panel            |
| thumbnails     | backend render images         | prompt, plan, approval |
+----------------+------------------------------+------------------------+
| Version timeline / trust strip / status / export controls              |
+-------------------------------------------------------------------------+
```

Visual style:

- Font: Roboto or equivalent standard sans-serif.
- Colors: white, near-black, gray text, gray borders.
- Density: professional editor UI, compact and readable.
- No decorative gradients, large hero sections, or colorful marketing panels.

Agent Panel responsibilities:

- Task request prompt.
- AI reasoning/proposed edit plan.
- Approval controls.
- Backend clarification questions.
- QA results.
- Repair suggestions.
- Version actions.

## Primary User Flow

```text
1. User uploads PPTX.
2. Backend stores immutable original.
3. Backend creates first working version.
4. Backend parses PPTX and renders slides.
5. UI progressively displays slide thumbnails and selected slide preview.
6. User selects a slide and writes an edit request in the Agent Panel prompt.
7. User presses Enter.
8. The AI reasons through the request and presents a structured edit plan in the Agent Panel.
9. If a backend clarification question or risk is raised, the Agent Panel shows it as an approval/answer step.
10. User approves the proposed edit plan.
11. Only after approval does the frontend send the persisted plan to the backend mutation/apply path.
12. Backend applies deterministic edits to a new version.
13. Backend renders and validates the new version.
14. UI shows before/after diff and validation summary.
15. User accepts, rejects, requests revision, restores, repairs, or exports.
```

## Mandatory Approval Rule

Any proposed edit plan, backend editing question, flagged risk, repair suggestion, or required choice must pause the workflow for user approval.

The frontend must not call `Apply Edit` automatically after the user presses Enter in the prompt.

```text
Request Edit
  -> AI reasons and backend persists plan/question
  -> UI shows plan/question in Agent Panel
  -> user approves or answers
  -> frontend sends approved plan to backend
  -> Apply Edit runs
  -> backend creates new version
```

Default policy:

- Plans require explicit approval.
- Backend clarification questions require explicit user answer.
- Risky operations require explicit approval.
- Auto-repair should be proposed first unless backend marks it as non-destructive and reversible.
- Export is allowed only when the version is rendered, validation is completed, and there are no blocking issues.
- Validation warnings allow export if surfaced clearly in the trust strip and Agent Panel.

## Workspace Modes

### Plan Mode

Shown after the user submits a prompt and before backend mutation.

Required information:

- What will change.
- Which slides/elements are affected.
- Risks or confidence notes.
- Backend questions, if any.
- `Approve Edit` and `Revise` actions.

### Review Mode

Shown after backend applies an approved edit and returns rendered artifacts.

Required information:

- Before render.
- After render.
- Changed slides.
- Validation summary.
- `Accept`, `Reject`, `Repair`, and `Revise` actions.

## Version Timeline

The UI must expose version lineage because backend creates a new version for every applied edit.

```text
Original -> v1 working -> v2 edited -> v3 repaired -> accepted
```

The timeline can be compact, but the user must always know:

- Original version exists.
- Active version.
- Parent version.
- Accepted version, if any.
- Whether export is ready.

## Edit Plan Contract

The edit plan is a lightweight persisted contract between what the user approved and what the backend executes.

The backend should create and store the plan before the UI asks for approval.

```text
prompt = user intent
plan = executable contract
approval = permission
apply = mutation
```

Minimum plan fields:

- `plan_id`
- `deck_id`
- `created_from_version_id`
- `status`: `awaiting_approval`, `approved`, `applied`, `expired`, `rejected`
- `summary`
- `operations`
- `created_at`

Approval must apply exactly the persisted plan to exactly `created_from_version_id`.

If the active version has changed since the plan was created, backend should reject approval and ask the UI to replan from the new active version.

## ACI: Agent Communication Interface

The frontend and backend should communicate through stateful events, not hidden assumptions.

### Frontend Sends

#### Upload

```json
{
  "type": "upload_pptx",
  "file": "<pptx>"
}
```

#### Request Edit

This event starts planning/reasoning only. It must not mutate PPTX files.

```json
{
  "type": "request_edit",
  "deck_id": "deck_123",
  "version_id": "version_1",
  "message": "Make slide 3 title shorter",
  "slide_id": "slide_3",
  "selected_element_ids": []
}
```

Backend response must be one of:

- `Edit Plan`
- `Backend Question`
- `Failed`

#### Approve Plan

This event is the first point where an edit can be sent to the backend apply path.

```json
{
  "type": "approve_plan",
  "deck_id": "deck_123",
  "version_id": "version_1",
  "plan_id": "plan_456",
  "created_from_version_id": "version_1",
  "approved_operation_ids": ["op_1"]
}
```

#### Answer Backend Question

```json
{
  "type": "answer_backend_question",
  "deck_id": "deck_123",
  "version_id": "version_1",
  "question_id": "question_789",
  "answer": "Use the shorter title but preserve original styling."
}
```

Backend response must be one of:

- revised `Edit Plan`
- another `Backend Question`
- `Failed`

Answering a question must not mutate PPTX files.

#### Accept Version

```json
{
  "type": "accept_version",
  "deck_id": "deck_123",
  "version_id": "version_2"
}
```

#### Reject Version

Reject marks the reviewed output version as rejected and switches active version back to the selected restore version. It does not create a new PPTX version.

```json
{
  "type": "reject_version",
  "deck_id": "deck_123",
  "version_id": "version_2",
  "restore_version_id": "version_1"
}
```

#### Restore Version

Restore switches the active version to an existing version without creating a new PPTX version.

```json
{
  "type": "restore_version",
  "deck_id": "deck_123",
  "restore_version_id": "version_1"
}
```

#### Request Repair

Repair follows the same approval rule as edits. This event asks backend to create a repair plan from validation results. It must not mutate PPTX files.

```json
{
  "type": "request_repair",
  "deck_id": "deck_123",
  "version_id": "version_2",
  "validation_issue_ids": ["issue_1"]
}
```

Backend response must be one of:

- `Edit Plan` with `plan_type: "repair"`
- `Backend Question`
- `Failed`

#### Export

```json
{
  "type": "export_version",
  "deck_id": "deck_123",
  "version_id": "version_2"
}
```

### Backend Returns

#### Deck Status

```json
{
  "deck_id": "deck_123",
  "active_version_id": "version_1",
  "parent_version_id": null,
  "original_version_id": "original",
  "ui_state": "processing",
  "changed_slides": [],
  "slide_statuses": {},
  "validation_summary": {
    "blocking_count": 0,
    "warning_count": 0,
    "can_export": false
  },
  "slides": [
    {
      "slide_id": "slide_1",
      "render_status": "ready",
      "thumbnail_url": "/renders/slide_1_thumb.png",
      "preview_url": "/renders/slide_1.png"
    }
  ]
}
```

#### Edit Plan

```json
{
  "ui_state": "awaiting_plan_approval",
  "plan_id": "plan_456",
  "plan_type": "edit",
  "deck_id": "deck_123",
  "created_from_version_id": "version_1",
  "status": "awaiting_approval",
  "summary": "Replace the title on slide 3 while preserving style.",
  "affected_slides": ["slide_3"],
  "operations": [
    {
      "operation_id": "op_1",
      "operation_type": "replace_text",
      "target_ref": "slide_3.shape_12",
      "human_label": "Slide 3 title",
      "before": "Q3 Revenue",
      "after": "Q3 Growth",
      "preserve_style": true
    }
  ],
  "risks": [],
  "requires_approval": true
}
```

#### Backend Question

```json
{
  "ui_state": "awaiting_plan_approval",
  "question_id": "question_789",
  "question": "Should the title be shortened aggressively or only enough to avoid overflow?",
  "options": [
    "Shorten aggressively",
    "Only avoid overflow"
  ],
  "requires_approval": true
}
```

#### Review Result

```json
{
  "ui_state": "review_ready",
  "input_version_id": "version_1",
  "output_version_id": "version_2",
  "active_version_id": "version_2",
  "parent_version_id": "version_1",
  "original_version_id": "original",
  "changed_slides": ["slide_3"],
  "slide_statuses": {
    "slide_3": "changed"
  },
  "diffs": [
    {
      "slide_id": "slide_3",
      "before_url": "/versions/version_1/renders/slide_3.png",
      "after_url": "/versions/version_2/renders/slide_3.png",
      "diff_url": "/versions/version_2/diffs/slide_3.png"
    }
  ],
  "validation_summary": {
    "blocking_count": 0,
    "warning_count": 0,
    "blocking_issues": [],
    "warnings": [],
    "can_accept": true,
    "can_export": true
  }
}
```

## UI States

- `upload_empty`: no deck uploaded.
- `uploading`: file upload in progress.
- `processing`: backend parsing/rendering initial version.
- `ready`: slide previews available.
- `planning`: backend building edit plan.
- `awaiting_plan_approval`: backend returned plan, question, or risk requiring user approval.
- `editing`: backend applying approved deterministic operations.
- `validating`: backend rendering/checking edited version.
- `review_ready`: before/after diff and validation are available.
- `repairing`: backend repairing detected issue after user approval.
- `accepted`: user accepted the version.
- `export_ready`: active version can be exported.
- `failed`: backend error with recoverable message.

## Slide Rail Status

The slide rail should show per-slide backend state without raw logs.

Examples:

```text
Slide 1
Slide 2  changed
Slide 3  warning
Slide 4  failed
```

Backend should return `slide_statuses` keyed by `slide_id`.

Allowed first-pass statuses:

- `ready`
- `changed`
- `warning`
- `failed`
- `rendering`

## Validation Display

Validation should be visible but compact.

```text
Blocking: 0
Warnings: 1
Changed slides: 3
Can export: yes
```

Detailed validation reports can exist behind a secondary view. The main UI should show decisions, not validator logs.

## Trust Strip

The bottom strip is always visible after upload.

```text
Original preserved | Active: v2 | Parent: v1 | 3 slides changed | Export ready
```

This reinforces the core promise: original PPTX is immutable and recoverable.

## Page Diagrams

### Upload

```text
+----------------------------------------------------------------------+
| PPTX Editor                                               [Settings] |
+----------------------------------------------------------------------+
|                                                                      |
|                    +----------------------------+                    |
|                    |        Upload PPTX         |                    |
|                    |  Drag file here or Browse  |                    |
|                    |          .pptx only        |                    |
|                    +----------------------------+                    |
|                                                                      |
+----------------------------------------------------------------------+
```

### Processing

```text
+----------------------------------------------------------------------+
| PPTX Editor                                      deck-name.pptx      |
+----------------------------------------------------------------------+
| Processing deck                                                     |
| Upload complete        100%                                         |
| Parsing structure       72%                                         |
| Rendering slides        41%                                         |
| Running validation       0%                                         |
|                                                                     |
| Slides appear as backend renders are ready.                         |
+----------------------------------------------------------------------+
```

### Workspace

```text
+---------------+------------------------------------------+------------------+
| Slides        | Rendered Slide                           | Agent Panel      |
|               |                                          |                  |
| Slide 1       |                                          | Task request     |
| Slide 2       |                                          | +--------------+ |
| Slide 3  *    |                                          | | Type prompt  | |
| Slide 4       |                                          | +--------------+ |
|               |                                          | Press Enter      |
|               |                                          |                  |
| Timeline      |                                          | Validation       |
| Original      |                                          | Blocking: 0      |
| v1 working    |                                          | Warnings: 0      |
+---------------+------------------------------------------+------------------+
| Original preserved | Active: v1 | Parent: original | 0 changed | Export no |
+-----------------------------------------------------------------------------+
```

### Approval Required

```text
+---------------+------------------------------------------+------------------+
| Slides        | Current Slide                            | Agent Panel      |
|               |                                          |                  |
| Slide 3  *    |                                          | Plan mode        |
|               |                                          | Replace title    |
|               |                                          | Preserve style   |
|               |                                          | Target: title    |
|               |                                          | Risk: low        |
|               |                                          |                  |
|               |                                          | [Approve Edit]   |
|               |                                          | [Revise]         |
+---------------+------------------------------------------+------------------+
| No backend mutation happens until approval.                             |
+-----------------------------------------------------------------------------+
```

### Review

```text
+---------------+----------------------+----------------------+--------------+
| Slides        | Before               | After                | Agent Panel  |
|               |                      |                      |              |
| Slide 3 changed| Render v1           | Render v2            | Review mode  |
| Slide 4 warning|                     |                      | Blocking: 0  |
|               |                      |                      | Warnings: 1  |
|               |                      |                      | [Accept]     |
|               |                      |                      | [Reject]     |
|               |                      |                      | [Repair]     |
+---------------+----------------------+----------------------+--------------+
| Original preserved | Active: v2 | Parent: v1 | 1 changed | Export warning |
+----------------------------------------------------------------------------+
```

## MVP Scope

Build first:

- Upload empty state.
- Processing state with progressive slide render placeholders.
- Main workspace with slide rail, slide preview, and right-side Agent Panel.
- Prompt input where user writes a request and presses Enter.
- AI plan mode with mandatory approval before backend mutation.
- Before/after review state.
- Version timeline and trust strip.
- Changed-slide indicators.
- Compact validation summary.

Defer:

- Element-level direct manipulation.
- Rich visual diff controls beyond before/after.
- Multi-user collaboration.
- Browser-native PPTX rendering.
