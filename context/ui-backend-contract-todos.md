# UI Backend Contract Todos

## Core UI Rule

The UI displays backend-generated truth.

The browser should not be the source of truth for PPTX rendering, validation, or mutation.

```text
backend creates versions, renders, diffs, and validation reports
ui displays them and collects user decisions
```

## Backend-Owned Artifacts For UI

For each deck version, backend should expose:

- original PPTX file reference
- current version PPTX file reference
- slide render images
- before/after diff images or diff metadata
- canonical presentation graph summary
- validation results
- edit operation history
- exportable PPTX path

## Main UI Flow

```text
1. Upload PPTX
2. Backend stores immutable original
3. Backend creates working version
4. Backend parses and renders slides
5. UI shows slide thumbnails and selected slide preview
6. User asks for edit or chooses task
7. Backend creates structured edit plan
8. UI shows planned changes before execution when useful
9. Backend applies edit to new version
10. Backend renders and validates new version
11. UI shows before/after preview and validation issues
12. User accepts, rejects, reverts, requests revision, or exports
```

## UI Layout Contract

```text
+----------------+------------------------------+----------------------+
| Slide Rail     | Slide Preview / Diff Canvas   | Agent / Task Panel   |
| thumbnails     | before, after, compare        | request, plan, QA    |
+----------------+------------------------------+----------------------+
| Version history / status / export controls                           |
+-----------------------------------------------------------------------+
```

## UI States

- `upload_empty`: no deck uploaded
- `uploading`: file transfer in progress
- `processing`: backend parsing/rendering original deck
- `ready`: deck previews available
- `planning`: LLM creating edit plan
- `awaiting_plan_approval`: optional review of planned ops
- `editing`: backend applying deterministic ops
- `validating`: backend rendering/checking edited version
- `review_ready`: before/after diff available
- `repairing`: backend repairing detected issues
- `accepted`: user accepted version
- `export_ready`: final PPTX available
- `failed`: backend error with recoverable message

## UI Actions

### Upload

Input:

- `.pptx`

Backend output:

- `deck_id`
- `original_version_id`
- `current_version_id`
- initial slide renders

### Request Edit

Input:

- `deck_id`
- `version_id`
- natural language request
- optional `slide_id`
- optional selected element IDs

Backend output:

- `plan_id`
- planned edit operations
- affected slides
- risk/confidence summary

### Apply Edit

Input:

- `plan_id`
- approved operations

Backend output:

- `new_version_id`
- updated slide renders
- validation results
- diff metadata

### Accept Version

Input:

- `deck_id`
- `version_id`

Backend output:

- version status becomes `accepted`

### Revert

Input:

- `deck_id`
- target `version_id`

Backend output:

- active version points back to selected version
- UI reloads renders for that version

### Export

Input:

- `deck_id`
- `version_id`

Backend output:

- exportable `.pptx` file path or download URL

## Backend Guidance For UI

Backend should make the UI simple by returning:

- `active_version_id`
- `available_versions`
- `slide_previews`
- `changed_slides`
- `validation_summary`
- `blocking_issues`
- `warnings`
- `can_export`

## Validation Display

UI should show validation as decisions, not raw logs.

Examples:

- `No blocking issues found`
- `Text overflow detected on slide 4`
- `Chart data changed on slide 7`
- `Logo moved from original position`
- `Style drift detected in title text`

## User Trust Requirements

The UI must always make these visible:

- original version exists
- current working version
- what changed
- which slides changed
- validation status
- restore/revert option
- export only after backend has rendered and validated

## Open Questions

- Should the first MVP require plan approval before execution, or only after diff review?
- Should repair run automatically after validation failure, or require user confirmation?
- Should UI expose element-level selection in v1, or only slide-level and deck-level requests?
- Should export be blocked on validation warnings, or only on blocking errors?

