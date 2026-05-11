# Professional Frontend MVP

## Scope

Build a Next.js App Router frontend in `UI/` for the PPTX deck review workspace. The app must implement six connected UI states: upload, processing, workspace ready, plan approval, review, and accepted/export ready.

## Assumptions

- Use npm.
- Use real shadcn-generated local components, not broad component packs.
- Use mock backend data only for this sprint.
- Browser does not render, mutate, diff, or validate PPTX files.
- Keep the UI monochrome, compact, professional, and Roboto-based.

## Architectural Decisions

- Frontend owns display, user decisions, selected slide, and Agent Panel state.
- Backend client mock owns simulated upload, plan creation, apply, validation, accept/reject/repair/revise/export events.
- Prompt submission creates a persisted edit plan only.
- Approval is the first point where apply/mutation simulation can run.
- Render canvas proves results only after approval and backend render simulation.

## Tasks

1. Scaffold fresh Next.js + TypeScript + Tailwind + ESLint App Router files in `UI/`.
2. Initialize shadcn and add only button, card, badge, textarea, progress, separator, scroll-area, tabs, and tooltip.
3. Add typed UI/backend contracts and lightweight mock backend functions.
4. Build the six connected screens with working transitions and keyboard behavior.
5. Apply professional monochrome editor styling with stable layout dimensions.
6. Verify typecheck, lint, production build, dependency surface, and browser behavior.
7. Refactor the Agent Panel into a Claude-style thread with a pinned bottom composer.
8. Add official shadcn-style dark mode with `next-themes`, a mode toggle, and token-based workspace colors.
9. Move plan/review decisions into a compact bottom composer decision bar with only `Reject` and `Submit`.

## Risks

- Tailwind/shadcn misconfiguration could produce unstyled browser-default UI.
- Installing broad UI packages could increase memory/disk footprint.
- Overbuilding PPTX rendering in-browser would violate backend ownership.

## Verification Strategy

- From `UI/`, run `npm run typecheck`.
- From `UI/`, run `npm run lint`.
- From `UI/`, run `npm run build`.
- Review `UI/package.json` for heavy dependencies.
- Confirm only required shadcn component files exist.
- Start the local dev server and inspect all six connected states.
