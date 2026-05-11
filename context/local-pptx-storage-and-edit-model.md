# Local PPTX Storage And Edit Model

## Goal

Build a local-first backend model for reliable PPTX editing.

The system must preserve the original deck, create editable versions, track every deterministic edit, render the result, validate it, and allow restore/export at any point.

## Core Principle

The uploaded PPTX is immutable.

All edits happen on copied versions. The original remains the ground truth for layout, styling, numbers, assets, and recovery.

```text
original.pptx
-> working_copy_v1.pptx
-> working_copy_v2.pptx
-> working_copy_v3.pptx
```

## Local Storage Model

Use local filesystem for actual files.

Use SQLite for metadata, version history, edit operations, validation results, and paths to artifacts.

```text
data/
  decks/
    <deck_id>/
      original/
        deck.pptx
        extracted/
      versions/
        <version_id>/
          deck.pptx
          extracted/
          renders/
          validation.json
          diff.json
```

SQLite stores references to these files, not the full exploded PPTX as primary storage.

## Database Tables

### decks

Stores one uploaded deck.

- `id`
- `name`
- `original_file_path`
- `created_at`

### deck_versions

Stores every editable or generated version.

- `id`
- `deck_id`
- `parent_version_id`
- `file_path`
- `status`: `uploaded`, `parsed`, `edited`, `validated`, `failed`, `accepted`
- `created_at`

### deck_artifacts

Stores generated artifacts.

- `id`
- `deck_id`
- `version_id`
- `type`: `extracted_package`, `slide_render`, `diff`, `validation_report`
- `path`
- `created_at`

### edit_operations

Stores deterministic edit commands.

- `id`
- `deck_id`
- `input_version_id`
- `output_version_id`
- `operation_type`
- `target_ref`
- `payload_json`
- `status`
- `created_at`

### validation_results

Stores render and QA results.

- `id`
- `deck_id`
- `version_id`
- `slide_id`
- `check_type`: `overflow`, `overlap`, `missing_object`, `style_drift`, `chart_integrity`
- `severity`
- `result_json`
- `created_at`

## PPTX Truth Model

A PPTX is a ZIP package of Office Open XML parts.

The lossless source of truth is:

- XML parts
- relationships
- media
- charts
- embedded workbook data
- slide masters
- layouts
- themes
- notes/comments if needed

Do not let the LLM directly mutate these files.

## Canonical Presentation Graph

After upload, parse PPTX into a deterministic graph.

Each object must map back to exact PPTX XML provenance.

```json
{
  "slide_id": "slide_1",
  "element_id": "shape_12",
  "type": "text_box",
  "role": "title",
  "text": "Q3 Revenue",
  "bbox_emu": {
    "x": 914400,
    "y": 457200,
    "w": 5486400,
    "h": 685800
  },
  "style_ref": "style_7",
  "source_xml": "ppt/slides/slide1.xml#/p:sld/p:cSld/p:spTree/p:sp[3]"
}
```

This graph is the AI-readable map.

The original PPTX package is still the source of truth.

## Edit Model

The LLM should produce structured edit plans only.

The backend executes a small deterministic edit DSL.

Example:

```json
{
  "op": "replace_text",
  "target_ref": "slide_1.shape_12",
  "value": "Q3 Revenue Growth",
  "preserve_style": true
}
```

Initial edit operations:

- `replace_text`
- `resize_text_box`
- `fit_text`
- `move_element`
- `align_elements`
- `update_table_cell`
- `update_chart_data`
- `apply_style_ref`
- `hide_element`
- `restore_element_from_original`

## Edit Execution Flow

```text
1. User uploads PPTX
2. Store immutable original
3. Create working copy version
4. Parse working copy into canonical graph
5. Render slides to images
6. User requests edit
7. LLM creates structured edit plan
8. Engine validates edit plan against allowed DSL
9. Engine applies edit to a new version
10. Render new version
11. Validate overflow, overlap, style drift, missing objects, chart integrity
12. Auto-repair if possible
13. User reviews visual diff
14. User accepts, rejects, restores, or exports
```

## Restore Model

Restore should work at two levels.

Version restore:

```text
set active_version_id = previous_version_id
```

Element restore:

```text
copy original XML subtree/style/data for target_ref into new working version
```

The original deck enables recovery when an edit damages layout, data, or style.

## Current Technical Challenge

The main backend challenge is not chat or CRUD.

It is:

```text
PPTX XML -> canonical presentation graph -> deterministic edit operation -> PPTX XML -> render validation
```

The hard part is making every AI-visible object traceable back to exact XML nodes, then applying edits without losing layout, style, relationships, charts, or embedded data.

## Local First, Production Later

For now:

- filesystem for PPTX versions and artifacts
- SQLite for metadata and operation history
- local worker process for parse/render/edit/validate jobs

Later:

- object storage for files
- Postgres for metadata
- queue workers for long-running jobs
- tenant/user permissions
- audit logs and enterprise retention

