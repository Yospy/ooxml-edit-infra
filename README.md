# ooxml-edit-infra

Infrastructure for reliable agentic Office edits: parse PPTX/DOCX/XLSX into canonical graphs, compile intent into deterministic OOXML mutations, render-validate outputs, and preserve versioned exports.

## What This Solves

It is easy to claim the end of white-collar work. It is much harder to make LLMs reliably edit real Office files.

Many agent workflows eventually need to take PPTX, DOCX, or XLSX files and change them to produce real-world outcomes. Current model performance is brittle unless users write painstaking, file-specific prompts that define exactly what "acceptable" means. That breaks down because templates, expected outputs, and business context change constantly.

This repository builds the infrastructure layer underneath those agents: structured parsing, deterministic OOXML mutation, render validation, version lineage, and export-safe review.

The core workflow is:

```text
Existing Office file
  -> parse into a canonical graph
  -> create a structured edit plan
  -> request user approval
  -> apply deterministic OOXML mutations
  -> render and validate the changed version
  -> review, accept, reject, restore, or export
```

The product rule is simple:

```text
AI proposes. User decides. The backend edits deterministically.
```

## Repository Layout

```text
.
├── UI/              # Next.js frontend workspace
├── backend/         # Fastify API, SQLite metadata, OOXML parse/edit/render pipeline
├── context/         # Architecture and product context
├── sprints/         # Sprint plans and implementation decisions
├── sample.pptx      # Local sample deck used by tests and UI sample upload
└── README.md
```

## Requirements

- Node.js 23 or newer
- npm
- OpenAI API key for real edit planning

Node.js 23+ is required because the backend uses `node:sqlite`.

## Environment Variables

Create a local `.env` file at the repository root:

```bash
cp .env.example .env
```

Then set the values you need:

| Variable | Required | Default | Used By | Purpose |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes for edit planning | none | Backend | Calls the OpenAI Responses API to create edit plans. |
| `OPENAI_MODEL` | No | `gpt-5.5` | Backend | Model used by the planner. |
| `PORT` | No | `4000` | Backend | API server port. |
| `HOST` | No | `0.0.0.0` | Backend | API server host. |
| `DATA_DIR` | No | `backend/data` | Backend | Local runtime directory for SQLite, uploaded decks, renders, exports, and version artifacts. |
| `NEXT_PUBLIC_BACKEND_URL` | No | `http://localhost:4000` | UI | Backend URL used by the browser client. |

Without `OPENAI_API_KEY`, upload, parse, render, and sample-deck flows can still run, but edit-plan requests fail with `OPENAI_API_KEY_MISSING`.

## Install

Install backend dependencies:

```bash
npm --prefix backend install
```

Install UI dependencies:

```bash
npm --prefix UI install
```

The root `package.json` provides convenience scripts, but dependencies stay inside `backend/` and `UI/` because each workspace has its own lockfile.

## Run Locally

Start the backend:

```bash
npm run dev:backend
```

Backend health check:

```bash
curl http://localhost:4000/health
```

Start the UI in a second terminal:

```bash
npm run dev:ui
```

Open:

```text
http://localhost:3000
```

## Local Database Setup

No manual database setup is required.

When the backend starts, `backend/src/database.ts` creates the SQLite database directory and runs schema creation automatically:

```text
backend/data/app.db
backend/data/app.db-shm
backend/data/app.db-wal
```

These files are local runtime state and are intentionally ignored by Git.

To reset local backend state:

```bash
rm -rf backend/data
```

The next backend run recreates the database and schema.

## Runtime Data

The app writes generated artifacts locally:

- Uploaded decks
- Extracted OOXML packages
- Versioned PPTX files
- Render artifacts
- Export artifacts
- Local SQLite files
- Final edit feedback events under `data/final-change-events/`

These are ignored because they may contain user deck content or proprietary feedback.

## Useful Scripts

From the repository root:

```bash
npm run dev:backend       # Start Fastify API on port 4000
npm run dev:ui            # Start Next.js UI on port 3000
npm run typecheck         # Typecheck backend and UI
npm run test              # Run backend tests
npm run lint              # Run UI lint
npm run check             # Backend tests + backend typecheck + UI typecheck + UI lint
```

Equivalent direct commands:

```bash
npm --prefix backend run test
npm --prefix backend run typecheck
npm --prefix UI run typecheck
npm --prefix UI run lint
```

## API Surface

Key local endpoints:

```text
GET  /health
POST /api/decks/upload
GET  /api/jobs/:jobId
GET  /api/decks/:deckId/status
POST /api/decks/:deckId/edit-requests
POST /api/decks/:deckId/decisions/:decisionId/respond
POST /api/decks/:deckId/versions/:versionId/accept
POST /api/decks/:deckId/versions/:versionId/reject
POST /api/decks/:deckId/versions/:versionId/restore
POST /api/decks/:deckId/versions/:versionId/export
```

## GitHub Push Checklist

Before pushing:

```bash
git status --short --ignored
npm run check
```

Confirm these are not staged:

- `.env`
- `backend/data/`
- `data/final-change-events/`
- `UI/.next/`
- `node_modules/`
- SQLite files (`*.db`, `*.db-shm`, `*.db-wal`)

Recommended repository description:

```text
Infrastructure for reliable agentic Office edits: parse PPTX/DOCX/XLSX into canonical graphs, compile intent into deterministic OOXML mutations, render-validate outputs, and preserve versioned exports.
```
