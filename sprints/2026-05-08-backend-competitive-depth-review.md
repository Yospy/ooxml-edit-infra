# Backend Competitive Depth Review

## Scope

Review the backend architecture against current public OpenAI/Anthropic agent patterns and identify the strongest technical depth wedge for accuracy.

## Assumptions

- The product wedge remains reliable editing of existing PPTX files.
- Public vendor docs are enough to compare architecture patterns, not private implementation details.
- Accuracy means correct target, correct mutation, preserved design, validated exportability.

## Architectural Decisions

- Keep the LLM as planner only.
- Make deterministic PPTX mutation and rendered validation the core differentiator.
- Treat OpenAI/Claude-style agent patterns as supporting infrastructure, not the product moat.

## Tasks

1. Read `context/backend-architecture-context.md`.
2. Compare against current public OpenAI GPTs/API and Anthropic Claude/Claude Code patterns.
3. Identify similarities, differences, risks, and the recommended technical depth wedge.
4. Store conclusions in `context/backend-competitive-depth-review.md`.

## Risks

- Over-indexing on generic agent architecture instead of the accuracy bottleneck.
- Mistaking file-search/document understanding for lossless PPTX editing.
- Depending on visual LLM judgment without deterministic package provenance.

## Verification Strategy

- Check the recommendation is tied to the documented backend invariants.
- Check claims against primary vendor docs where possible.
- Confirm the recommended wedge is narrow enough for MVP execution.
