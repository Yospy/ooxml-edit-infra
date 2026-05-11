# Backend Architecture Context

## Purpose

This document is the backend source of truth for the PPTX editing product.

The product is not a generic AI presentation generator. The backend exists to reliably edit existing PowerPoint files without breaking the user's original layout, styling, assets, charts, or exportability.

The competitive target is not the first draft. ChatGPT, Claude, and other tools can already generate or recreate a usable 80-90% presentation. The product target is the painful final 10%:

```text
existing real deck
  -> exact user-requested edit
  -> no unintended changes
  -> preserved design and exportability
```

The core backend promise:

```text
Existing PPTX
  -> preserve immutable original
  -> parse into deterministic structure
  -> let AI create an approved edit plan
  -> apply exact deterministic XML edits
  -> render and validate result
  -> export a safe PPTX version
```

## Product Wedge

The wedge is reliable editing of existing business decks.

Popular deck tools mostly optimize for:

```text
prompt/doc -> generated deck
existing deck -> imported/recreated/restyled deck
```

This product optimizes for:

```text
existing messy PPTX -> small safe edit -> preserved design -> validated export
```

That difference matters because real white-collar work often starts from an existing company deck, template, board deck, sales deck, or client proposal. The user usually does not want a new deck. They want the current deck changed without damage.

The strongest differentiation statement:

```text
AI plans the edit. The compiler edits the deck. The renderer proves it.
```

## Technical MVP

The first backend MVP should solve a narrow but hard problem:

```text
Reliably edit existing PPTX text and simple layout while preserving original design.
```

MVP edit categories:

- Replace text in a known text box.
- Shorten or rewrite a title/body/bullet.
- Fit text inside original bounds.
- Preserve font, size, color, alignment, and textbox geometry unless explicitly requested.
- Detect basic text overflow and layout drift after render.
- Version, reject, restore, accept, and export.

Explicitly defer:

- Complex chart editing.
- Complex table editing.
- SmartArt.
- Animations and transitions.
- Speaker notes/comments.
- Full deck generation.
- In-PowerPoint plugin integration.
- Real-time collaborative editing.
- Browser-side PPTX rendering as source of truth.

## Core Invariants

These rules should be enforced by code, tests, and API contracts.

```text
1. Original PPTX is immutable.
2. Request edit creates a plan only.
3. User approval is the first mutation point.
4. Every mutation creates a new version.
5. LLM never edits PPTX files directly.
6. Backend render output is the UI source of visual truth.
7. Export is allowed only after render and validation.
8. Any plan created from a stale version must be rejected.
```

## High-Level System

```text
+--------------------------+
|        Frontend UI        |
| upload, prompt, approval, |
| review, accept, export    |
+------------+-------------+
             |
             v
+--------------------------+
|          API Layer        |
| REST endpoints, schemas,  |
| auth later, error mapping |
+------------+-------------+
             |
             v
+--------------------------+
|      Deck Orchestrator    |
| state machine, versions,  |
| plans, jobs, decisions    |
+------+----------+--------+
       |          |
       v          v
+-------------+  +----------------+
| SQLite DB    |  | File Store     |
| metadata,    |  | pptx, xml,     |
| jobs, plans, |  | renders, diffs,|
| validation   |  | exports        |
+------+------+  +--------+-------+
       |                  |
       v                  v
+----------------------------------+
|          Worker Pipeline          |
| parse -> graph -> render -> plan  |
| apply -> render -> validate       |
+----------------------------------+
```

## Responsibility Split

```text
Frontend
  - Displays backend-generated slide images.
  - Collects prompt, selected slide/object, approval, reject, accept, export.
  - Polls jobs and switches UI states.
  - Does not render, mutate, validate, or diff PPTX as truth.

Backend API
  - Receives events.
  - Validates payloads.
  - Starts jobs.
  - Returns deck status, plans, questions, failures, render URLs, export URLs.

Deck Orchestrator
  - Owns state transitions.
  - Ensures original immutability.
  - Ensures approval-before-mutation.
  - Ensures version lineage.
  - Coordinates workers.

LLM Planner
  - Reads user intent plus canonical graph context.
  - Produces an edit plan or asks a question.
  - Never mutates files.

Deterministic Edit Engine
  - Validates plan operations.
  - Maps target refs to exact XML provenance.
  - Applies XML/package mutations.
  - Writes a new PPTX version.

Renderer
  - Converts PPTX versions into slide images.
  - Produces thumbnail and preview/render URLs.

Validator
  - Checks overflow, missing elements, style drift, unexpected movement, render failures.
  - Produces export gating decisions.
```

## Local Storage Model

For local development, use filesystem for heavy artifacts and SQLite for metadata.

```text
data/
  app.db
  decks/
    deck_123/
      original/
        deck.pptx
        extracted/
          [unzipped OOXML package]
      versions/
        original/
          deck.pptx
          extracted/
          renders/
          graph.json
          validation.json
        v1/
          deck.pptx
          extracted/
          renders/
          graph.json
          validation.json
        v2/
          deck.pptx
          extracted/
          renders/
          diff/
          graph.json
          validation.json
      exports/
        v2-export.pptx
```

Filesystem stores:

- Original PPTX.
- Version PPTX files.
- Extracted OOXML package folders.
- Render images.
- Diff images or diff metadata.
- Export files.
- Optional graph snapshots for debugging.

SQLite stores:

- Deck metadata.
- Active version pointer.
- Version lineage.
- File paths.
- Slide metadata.
- Render artifact records.
- Edit plans.
- Edit operations.
- Jobs.
- Validation results.
- Export records.

## SQLite Tables

### decks

```text
id
file_name
original_version_id
active_version_id
status
created_at
updated_at
```

### deck_versions

```text
id
deck_id
parent_version_id
version_number
status
file_path
extracted_path
graph_path
created_by_plan_id
created_at
```

Version statuses:

```text
original
working
edited
repaired
accepted
rejected
failed
```

### slides

```text
id
deck_id
version_id
slide_index
slide_key
title
status
width_emu
height_emu
created_at
```

### slide_renders

```text
id
deck_id
version_id
slide_id
thumbnail_path
preview_path
width_px
height_px
render_status
render_hash
created_at
```

Render statuses:

```text
queued
rendering
ready
failed
```

### edit_plans

```text
id
deck_id
created_from_version_id
plan_type
status
user_prompt
summary
risks_json
created_at
approved_at
applied_at
```

Plan statuses:

```text
awaiting_approval
approved
applied
expired
rejected
failed
```

### edit_operations

```text
id
plan_id
deck_id
operation_type
target_ref
payload_json
before_json
after_json
preserve_style
status
created_at
```

### backend_questions

```text
id
deck_id
version_id
plan_id
question
choices_json
status
answer
created_at
answered_at
```

Question statuses:

```text
awaiting_answer
answered
expired
failed
```

### jobs

```text
id
deck_id
version_id
job_type
status
progress_json
result_json
error_message
created_at
started_at
finished_at
```

Job types:

```text
upload_process
parse
render
request_edit_plan
apply_plan
validate
request_repair_plan
export
```

Job statuses:

```text
queued
running
succeeded
failed
cancelled
```

### validation_results

```text
id
deck_id
version_id
slide_id
issue_type
severity
message
target_ref
details_json
created_at
```

Issue types:

```text
text_overflow
object_overlap
missing_object
unexpected_movement
style_drift
render_failure
chart_integrity
asset_missing
```

Severities:

```text
blocking
warning
info
```

### exports

```text
id
deck_id
version_id
file_path
status
created_at
```

## PPTX Truth Model

A `.pptx` file is a ZIP package of Office Open XML parts.

Important package areas:

```text
[Content_Types].xml
_rels/.rels
ppt/presentation.xml
ppt/_rels/presentation.xml.rels
ppt/slides/slideN.xml
ppt/slides/_rels/slideN.xml.rels
ppt/slideLayouts/
ppt/slideMasters/
ppt/theme/
ppt/charts/
ppt/embeddings/
ppt/media/
docProps/
```

The backend must preserve:

- XML structure.
- Relationship IDs.
- Media references.
- Chart references.
- Embedded workbook references.
- Layout/master/theme references.
- Shape IDs and names where possible.
- Unknown XML it does not understand.

The safest rule:

```text
Only patch the smallest XML subtree needed for an approved operation.
Copy everything else byte-for-byte where possible.
```

## Canonical Deck Graph

The canonical deck graph is the AI-readable and code-executable representation of the deck.

It is not a replacement for the PPTX package. It is a structured index with exact provenance back to XML.

Example:

```json
{
  "deck_id": "deck_123",
  "version_id": "v1",
  "slides": [
    {
      "slide_id": "slide_3",
      "slide_index": 3,
      "width_emu": 12192000,
      "height_emu": 6858000,
      "elements": [
        {
          "element_id": "shape_title",
          "type": "text_box",
          "role": "title",
          "name": "Title 1",
          "text": "Q3 Revenue",
          "bounds_emu": {
            "x": 914400,
            "y": 457200,
            "w": 5486400,
            "h": 685800
          },
          "style": {
            "font_family": "Aptos Display",
            "font_size": 3200,
            "bold": true,
            "color_ref": "theme:tx1",
            "alignment": "left"
          },
          "xml_provenance": {
            "part": "ppt/slides/slide3.xml",
            "xpath": "/p:sld/p:cSld/p:spTree/p:sp[2]",
            "shape_id": "7",
            "relationship_id": null
          }
        }
      ]
    }
  ]
}
```

Required properties:

- Stable IDs for slides and elements.
- Element type.
- Human role when inferable: title, subtitle, body, footer, logo, chart, table.
- Text and runs.
- Bounds in EMUs.
- Style summary.
- Relationship references.
- Exact XML provenance.
- Render metadata when available.

### How The Graph Is Created

Graph creation is a deterministic indexing pass over the PPTX package.

```text
deck.pptx
  -> unzip package
  -> read presentation, slide, layout, master, theme, relationship XML
  -> walk every slide object
  -> extract text, type, bounds, style, relationships
  -> assign stable slide/element IDs
  -> store exact XML provenance
  -> render slides and attach render metadata
  -> write graph.json snapshot for that version
```

The graph is not the source of truth. The PPTX package remains the source of truth. The graph is the backend's address book:

```text
what the user sees
  -> what the AI can reason about
  -> exact XML location the edit engine can patch
```

Without the graph, the model guesses. With the graph, the model can plan against clean objects and the backend can mutate exact XML nodes.

## Target Resolution

Target resolution must happen before operation planning.

The backend should not ask the LLM to directly guess which raw XML node to edit. It should produce ranked candidate targets from structured evidence:

- selected slide or element from the UI
- user prompt text
- element role: title, body, subtitle, footer, logo, chart, table
- element text and semantic match
- spatial position and size
- render/visual metadata
- validation warnings

Target resolution outputs one of:

```text
ResolvedTarget
AmbiguousTargetQuestion
NoSafeTarget
```

Example:

```json
{
  "kind": "resolved_target",
  "target_ref": "slide_3.shape_7",
  "confidence": 0.94,
  "reason": "Selected slide 3 has one title-like text box matching 'Q3 Revenue'."
}
```

If confidence is low, the backend asks the user a question before creating an edit plan. This is a core accuracy feature, not a UX fallback.

## LLM Input Strategy

The LLM should receive enough context to plan accurately, but not raw unbounded PPTX XML.

LLM input should include:

```text
1. User prompt.
2. Deck ID and active version ID.
3. Selected slide ID.
4. Selected element IDs, if any.
5. Resolved target candidates or ambiguity result.
6. Compact canonical graph for relevant slides.
7. Slide render image or image URL when visual reasoning is needed.
8. Validation warnings from current version.
9. Allowed operation schema.
10. Constraints: preserve style, preserve bounds, no mutation.
11. Expected response type: EditPlan | BackendQuestion | Failed.
```

Example planning prompt shape:

```text
You are planning a PowerPoint edit.

User request:
"Make the slide 3 title shorter."

Context:
- deck_id: deck_123
- active_version_id: v1
- selected_slide_id: slide_3
- selected_elements: []

Relevant graph:
[compact JSON for slide 3]

Allowed operations:
- replace_text
- fit_text
- apply_style_ref
- restore_element_from_original

Rules:
- Do not mutate files.
- Preserve layout and style unless explicitly requested.
- If target is ambiguous, ask a backend question.
- Return only structured JSON.
```

The LLM should output one of:

```text
EditPlan
BackendQuestion
Failed
```

## Edit Plan Contract

The edit plan is the contract between the AI, the user, and the deterministic engine.

```text
prompt = user intent
plan = executable contract
approval = permission
apply = mutation
```

Minimum edit plan:

```json
{
  "plan_id": "plan_456",
  "plan_type": "edit",
  "deck_id": "deck_123",
  "created_from_version_id": "v1",
  "status": "awaiting_approval",
  "summary": "Replace the title on slide 3 while preserving style.",
  "affected_slides": ["slide_3"],
  "operations": [
    {
      "operation_id": "op_1",
      "operation_type": "replace_text",
      "target_ref": "slide_3.shape_title",
      "human_label": "Slide 3 title",
      "before": "Q3 Revenue",
      "after": "Q3 Growth",
      "preserve_style": true
    },
    {
      "operation_id": "op_2",
      "operation_type": "fit_text",
      "target_ref": "slide_3.shape_title",
      "human_label": "Slide 3 title box",
      "before": "Existing bounds",
      "after": "Fit inside original bounds",
      "preserve_style": true
    }
  ],
  "risks": [
    "Low risk: title text changes but style and bounds remain unchanged."
  ],
  "requires_approval": true
}
```

## Deterministic Edit DSL

The backend should start with a small operation set and expand only when reliable.

MVP operations:

```text
replace_text
fit_text
apply_style_ref
restore_element_from_original
```

Near-term operations:

```text
resize_text_box
move_element
align_elements
update_table_cell
update_chart_data
hide_element
```

Operation schema:

```json
{
  "operation_type": "replace_text",
  "target_ref": "slide_3.shape_title",
  "payload": {
    "text": "Q3 Growth",
    "preserve_runs": true,
    "preserve_style": true
  }
}
```

Execution rule:

```text
Operation -> resolve target_ref -> load XML provenance -> patch smallest XML subtree -> validate package -> write new PPTX
```

## Approval And Mutation Flow

```text
User prompt
   |
   v
request_edit
   |
   v
LLM planning job
   |
   +--> EditPlan persisted
   |        |
   |        v
   |   UI asks approval
   |
   +--> BackendQuestion persisted
   |        |
   |        v
   |   UI asks answer
   |
   +--> Failed

User approves plan
   |
   v
Backend checks:
  - plan exists
  - plan status awaiting_approval
  - active_version_id == created_from_version_id
  - operation IDs are valid
   |
   v
Apply deterministic operations
   |
   v
Create new version
   |
   v
Render + validate
   |
   v
Return ReviewResult / DeckStatus
```

Stale plan rejection:

```text
If current active version is v2
but plan was created from v1,
backend must reject approval and ask frontend to replan.
```

## Rendering

Rendering is mandatory because PPTX correctness is visual.

The frontend should consume render URLs from the backend:

```json
{
  "slide_id": "slide_3",
  "number": 3,
  "thumbnail_url": "/api/decks/deck_123/versions/v2/slides/slide_3/thumbnail.png",
  "render_url": "/api/decks/deck_123/versions/v2/slides/slide_3/render.png",
  "width": 1600,
  "height": 900,
  "render_status": "ready"
}
```

Renderer responsibilities:

- Render every slide after upload.
- Render changed slides after edit.
- Render before/after versions for review.
- Store dimensions and render hash.
- Mark failures as recoverable backend errors.

Possible local render options:

- LibreOffice headless export to PDF/images.
- PowerPoint automation later on supported desktop/server environments.
- Dedicated rendering service later for production.

The exact renderer can change. The backend contract should not.

## Validation

Validation should turn technical checks into user decisions.

Checks for MVP:

```text
text_overflow
render_failure
missing_object
unexpected_movement
style_drift
```

Validation summary returned to UI:

```json
{
  "blocking_count": 0,
  "warning_count": 1,
  "can_accept": true,
  "can_export": true,
  "warnings": [
    "Slide 4 has a non-blocking spacing warning."
  ]
}
```

Blocking issues should prevent export.

Warnings should allow export if clearly surfaced.

## API Contract

Initial REST shape:

```text
POST /api/decks/upload
GET  /api/decks/:deckId/status
POST /api/decks/:deckId/edit-plans
POST /api/decks/:deckId/edit-plans/:planId/approve
POST /api/decks/:deckId/questions/:questionId/answer
POST /api/decks/:deckId/repair-plans
POST /api/decks/:deckId/versions/:versionId/accept
POST /api/decks/:deckId/versions/:versionId/reject
POST /api/decks/:deckId/versions/:versionId/restore
POST /api/decks/:deckId/versions/:versionId/export
GET  /api/jobs/:jobId
```

### Upload

Request:

```text
multipart/form-data
file: .pptx
```

Response:

```json
{
  "deck_id": "deck_123",
  "job_id": "job_upload_1",
  "ui_state": "processing"
}
```

### Job Status

```json
{
  "job_id": "job_upload_1",
  "status": "running",
  "job_type": "upload_process",
  "progress": {
    "upload": 100,
    "parse": 60,
    "render": 20,
    "validate": 0
  },
  "deck_id": "deck_123",
  "version_id": "v1"
}
```

When succeeded:

```json
{
  "job_id": "job_upload_1",
  "status": "succeeded",
  "deck_id": "deck_123",
  "version_id": "v1",
  "result": {
    "next": "fetch_deck_status"
  }
}
```

### Deck Status

```json
{
  "deck_id": "deck_123",
  "file_name": "board-update-v1.pptx",
  "active_version_id": "v1",
  "parent_version_id": "original",
  "original_version_id": "original",
  "ui_state": "ready",
  "changed_slides": [],
  "slide_statuses": {
    "slide_1": "ready"
  },
  "validation_summary": {
    "blocking_count": 0,
    "warning_count": 0,
    "can_accept": false,
    "can_export": false,
    "warnings": []
  },
  "slides": [
    {
      "slide_id": "slide_1",
      "number": 1,
      "title": "Company Snapshot",
      "thumbnail_url": "/api/files/deck_123/v1/slide_1_thumb.png",
      "render_url": "/api/files/deck_123/v1/slide_1.png",
      "width": 1600,
      "height": 900,
      "render_status": "ready"
    }
  ],
  "versions": [
    {
      "id": "original",
      "label": "Original",
      "parent_id": null,
      "status": "original"
    },
    {
      "id": "v1",
      "label": "v1 working",
      "parent_id": "original",
      "status": "working"
    }
  ]
}
```

### Request Edit Plan

Request:

```json
{
  "deck_id": "deck_123",
  "version_id": "v1",
  "message": "Make slide 3 title shorter",
  "slide_id": "slide_3",
  "selected_element_ids": []
}
```

Response:

```json
{
  "job_id": "job_plan_1",
  "ui_state": "planning"
}
```

Final job result should be one of:

```text
EditPlan
BackendQuestion
Failed
```

### Backend Question

```json
{
  "kind": "backend_question",
  "question_id": "question_789",
  "deck_id": "deck_123",
  "version_id": "v1",
  "message": "Which title should be shortened?",
  "choices": [
    {
      "id": "choice_1",
      "label": "Main title"
    },
    {
      "id": "choice_2",
      "label": "Subtitle"
    }
  ]
}
```

### Approve Plan

Request:

```json
{
  "deck_id": "deck_123",
  "version_id": "v1",
  "plan_id": "plan_456",
  "created_from_version_id": "v1",
  "approved_operation_ids": ["op_1", "op_2"]
}
```

Response:

```json
{
  "job_id": "job_apply_1",
  "ui_state": "editing"
}
```

Final job creates a new version and returns updated deck status.

### Review Result

```json
{
  "input_version_id": "v1",
  "output_version_id": "v2",
  "active_version_id": "v2",
  "parent_version_id": "v1",
  "original_version_id": "original",
  "changed_slides": ["slide_3"],
  "slide_statuses": {
    "slide_3": "changed"
  },
  "before_renders": {
    "slide_3": "/api/files/deck_123/v1/slide_3.png"
  },
  "after_renders": {
    "slide_3": "/api/files/deck_123/v2/slide_3.png"
  },
  "validation_summary": {
    "blocking_count": 0,
    "warning_count": 0,
    "can_accept": true,
    "can_export": true,
    "warnings": []
  }
}
```

## Async Job Model

Long-running operations should return a `job_id`.

```text
upload/process
parse
render
request edit plan
apply plan
validate
repair plan
export
```

Frontend flow:

```text
POST action endpoint
   |
   v
receive job_id
   |
   v
poll GET /api/jobs/:jobId
   |
   v
on succeeded fetch deck status or consume result
```

Local implementation can use an in-process queue first. Production can move to a real queue.

## End-To-End Upload Flow

```text
POST /api/decks/upload
   |
   v
create deck row
   |
   v
store original/original.pptx
   |
   v
create original version
   |
   v
create v1 working copy
   |
   v
enqueue upload_process job
   |
   v
extract PPTX package
   |
   v
parse canonical graph
   |
   v
render all slides
   |
   v
validate initial version
   |
   v
mark deck ready
```

## End-To-End Edit Flow

```text
User enters prompt in Agent Panel
   |
   v
POST /api/decks/:deckId/edit-plans
   |
   v
Backend collects:
  - prompt
  - active version
  - selected slide/object
  - graph slice
  - render image URL
  - allowed operations
   |
   v
LLM returns plan/question/failure
   |
   v
persist plan/question
   |
   v
Frontend shows approval/question
   |
   v
User approves
   |
   v
POST /api/decks/:deckId/edit-plans/:planId/approve
   |
   v
Backend validates plan/version
   |
   v
copy source PPTX to new version workspace
   |
   v
apply deterministic XML operations
   |
   v
package v2.pptx
   |
   v
render changed/all slides
   |
   v
validate
   |
   v
return review result
```

## Error Model

All recoverable failures should be explicit.

```json
{
  "kind": "failed",
  "code": "STALE_PLAN",
  "message": "The deck changed after this plan was created. Please replan from the active version.",
  "recoverable": true,
  "details": {
    "active_version_id": "v2",
    "plan_created_from_version_id": "v1"
  }
}
```

Important error codes:

```text
INVALID_PPTX
UNSUPPORTED_PPTX_FEATURE
PARSE_FAILED
RENDER_FAILED
PLAN_FAILED
STALE_PLAN
TARGET_NOT_FOUND
OPERATION_NOT_ALLOWED
VALIDATION_BLOCKED
EXPORT_FAILED
```

## Accuracy Focus

The place to hone accuracy is not broad generation. It is this loop:

```text
target identification
  -> target resolution confidence
  -> operation planning
  -> XML provenance mapping
  -> deterministic patch
  -> rendered validation
```

Accuracy metrics for MVP:

- Correct target selected.
- Ambiguous requests ask a question instead of guessing.
- Text changed exactly as requested.
- No unintended text changes.
- Font/style preserved unless requested.
- Bounds preserved unless requested.
- No text overflow.
- Rendered slide visually matches expected diff.
- Export opens successfully in PowerPoint.
- Reject/restore returns to the previous version.

The MVP should be judged against the final-edit pain:

```text
Can a user trust this system to make the precise last-mile edit they would otherwise do manually?
```

## Suggested Implementation Order

### Phase 1: Backend Skeleton

- Create local filesystem layout.
- Create SQLite schema.
- Implement typed API stubs.
- Implement job table and polling.
- Return mocked deck status matching frontend contract.

### Phase 2: Upload And Render

- Accept real `.pptx` upload.
- Store immutable original.
- Create v1 working copy.
- Extract package.
- Render slides.
- Return real thumbnail/render URLs.

### Phase 3: Parse To Canonical Graph

- Parse slides and text boxes.
- Extract bounds, text, style summaries.
- Store graph snapshots.
- Preserve XML provenance.

### Phase 3.5: Target Resolution

- Rank likely targets from prompt, selection, graph, and render metadata.
- Return `ResolvedTarget | AmbiguousTargetQuestion | NoSafeTarget`.
- Require questions when target confidence is low.

### Phase 4: Plan Only

- Connect LLM to graph slices.
- Include resolved target candidates in planner context.
- Return persisted `EditPlan | BackendQuestion | Failed`.
- No mutation from planning.

### Phase 5: Deterministic Text Edits

- Implement `replace_text`.
- Implement `fit_text`.
- Create new PPTX version.
- Render and validate changed result.

### Phase 6: Review Actions

- Accept version.
- Reject version.
- Restore version.
- Export accepted version.

### Phase 7: Expand Operation Coverage

- Add table cell updates.
- Add simple chart data updates.
- Add movement/alignment operations.
- Add richer visual diffing.

## Production Later

Local first:

```text
SQLite + filesystem + in-process worker
```

Production later:

```text
Postgres + object storage + queue workers + tenant auth + audit logs
```

Migration path:

- SQLite tables should mirror future Postgres tables.
- File paths should be abstracted behind artifact storage.
- Jobs should be abstracted behind a queue interface.
- API contracts should remain stable.

## Final Mental Model

```text
LLM = planner
DB = state and lineage
File store = actual artifacts
Canonical graph = AI-readable/indexed structure
Edit DSL = safe operation language
Deterministic engine = mutation authority
Renderer = visual truth
Validator = trust gate
Frontend = decision surface
```

The hardest backend problem:

```text
PPTX XML
  -> canonical graph with exact provenance
  -> approved deterministic edit operation
  -> precise XML mutation
  -> rendered proof that nothing else broke
```
