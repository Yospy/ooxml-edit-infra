# GitHub Repo Readiness

## Scope

- Prepare the repository for an initial GitHub push.
- Add a clear root README for setup, environment variables, local database creation, and development workflows.
- Add a commit-safe environment template.
- Tighten ignore rules so secrets, dependencies, builds, databases, and runtime artifacts are not pushed.
- Align package metadata with the technical repository name.

## Assumptions

- Repository name is `ooxml-edit-infra`.
- The project contains a Next.js UI in `UI/` and a Fastify backend in `backend/`.
- The backend requires Node.js with `node:sqlite`; use Node.js 23+ locally.
- The local SQLite database is created automatically by `AppDatabase` when the backend starts.
- Runtime deck artifacts and proprietary final-change events should not be committed.

## Architectural Decisions

- Keep frontend and backend package installs separate because the repo already has separate lockfiles.
- Add a root `package.json` only as a command router; do not introduce a new dependency manager or root lockfile.
- Keep `.env` local-only and commit `.env.example`.
- Document the default local ports: backend `4000`, UI `3000`.

## Tasks

1. Add root README with problem statement, architecture, setup, env variables, database behavior, scripts, and GitHub push checklist.
2. Add `.env.example` with required and optional environment variables.
3. Update `.gitignore` to allow `.env.example` while excluding generated dependencies, builds, SQLite files, and runtime data.
4. Add root `package.json` with convenience scripts.
5. Rename package metadata from YC placeholder names to `ooxml-edit-infra`.
6. Verify docs and metadata with typecheck/tests where available.

## Risks

- Accidentally committing `.env`, local SQLite files, or captured proprietary event JSON.
- Documenting setup that does not match current scripts.
- Hiding a required fixture such as `sample.pptx`.

## Verification Strategy

- Run `git status --short --ignored` to confirm ignored local artifacts.
- Run backend tests and typecheck.
- Run frontend typecheck and lint.
- Review the final diff for scope and GitHub readiness.
