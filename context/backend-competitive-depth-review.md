# Backend Competitive Depth Review

## Conclusion

This backend is meaningfully different from generic GPT/Claude-style assistants in the right way.

OpenAI GPTs and API agents are organized around instructions, knowledge, tool calls, actions, structured outputs, traces, and evals. Anthropic Claude/Claude Code exposes similar primitives: tool use, MCP, subagents, memory files, hooks, computer use, and prompt/eval workflows.

Those are agent orchestration primitives. They help the model decide and act, but they do not by themselves solve the product's hardest problem:

```text
existing PPTX -> exact requested edit -> original design preserved -> export still works
```

The technical depth should therefore be a PPTX edit compiler:

```text
user intent
  -> target resolution
  -> structured edit plan
  -> XML-provenance-bound operation
  -> deterministic package patch
  -> render/diff validation
  -> export gate
```

## Where We Match Current Leaders

The architecture already matches the reliable-agent patterns used by OpenAI/Anthropic-style systems:

- Structured tool/action boundary: the LLM emits a plan, not arbitrary side effects.
- Explicit schemas: edit plans, operations, job statuses, validation results.
- Retrieval/context layer: canonical graph gives the model relevant deck context instead of raw unbounded files.
- Human approval before mutation.
- Traceability: jobs, versions, operations, validation, exports.
- Evals/validation mindset: accuracy is measured, not assumed.

Relevant public docs:

- OpenAI GPTs: instructions, knowledge, capabilities, apps/actions, version history.
- OpenAI Actions: external APIs defined through schema and auth.
- OpenAI function calling/structured outputs: schema-bound model outputs for app actions.
- OpenAI evals: reproducible quality checks for agents.
- Anthropic Claude Code: subagents, tools/MCP, memory files, hooks.
- Anthropic eval tooling: prompt/test-case iteration.

## Where We Differ

Most GPT/Claude-style systems are optimized for:

```text
conversation -> knowledge/tool use -> generated answer/action
```

This system is optimized for:

```text
existing binary document -> provenance graph -> constrained edit DSL -> deterministic mutation -> visual proof
```

That difference is important. A GPT can read a PPTX or call an API, but reliable existing-deck editing needs lossless package handling:

- Preserve unknown OOXML.
- Preserve relationship IDs.
- Preserve masters/layouts/themes.
- Preserve media/chart/embedding references.
- Patch only the smallest XML subtree.
- Prove the visual result after mutation.

The moat is not "better prompt instructions." The moat is a compiler/runtime that makes the LLM unable to damage the deck outside approved operations.

## Recommended Technical Depth

Go deep on **target accuracy and mutation proof**, not broad deck generation.

Build this as the core system:

```text
Canonical Graph + XML Provenance + Render Validator + Eval Corpus
```

### 1. Canonical Graph As Accuracy Substrate

Every visible object should have:

- stable element ID
- slide ID/index
- inferred role: title, body, footer, logo, table, chart
- text runs
- bounds in EMUs
- style summary
- relationships
- exact XML provenance
- render-time bounding box if available

The graph is not just model context. It is the contract between visual intent and XML mutation.

### 2. Target Resolver Before Planner

Do not let the LLM guess targets directly from text.

Add a target-resolution layer that ranks candidate elements using:

- selected slide/object from UI
- user phrase match
- role match
- spatial position
- visual/render evidence
- ambiguity threshold

If confidence is low, ask a backend question before planning.

### 3. Tiny Edit DSL

MVP operations should stay small:

- `replace_text`
- `fit_text`
- `apply_style_ref`
- `restore_element_from_original`

Each op should declare:

- allowed target types
- XML patch strategy
- preconditions
- postconditions
- validation checks
- rollback behavior

### 4. Render-Diff Export Gate

Accuracy must be judged after mutation.

For every edit:

- render before/after
- detect changed slides
- compare expected changed regions
- flag unexpected movement/missing objects/style drift
- block export on render failure or blocking drift

This is the key trust layer competitors often lack when they regenerate or visually approximate decks.

### 5. Eval Corpus From Real Deck Failures

Create a fixture set of messy decks and user requests:

- ambiguous titles
- grouped shapes
- multiple similar text boxes
- placeholders vs literal shapes
- themed fonts/colors
- long text overflow
- hidden/off-canvas elements
- charts and embedded workbooks later

Track metrics:

- target selection accuracy
- no unintended text changes
- style preservation
- bounds preservation
- overflow rate
- render success rate
- PowerPoint open/export success
- stale-plan rejection
- restore success

## What Not To Overbuild Yet

Avoid deep investment in:

- multi-agent orchestration
- autonomous desktop/PowerPoint control
- full deck generation
- chart/table editing
- browser-side PPTX rendering
- generic assistant memory

These are useful later, but they are not the accuracy bottleneck.

## Strongest Differentiation Statement

The product should position technically as:

```text
AI plans the edit. The compiler edits the deck. The renderer proves it.
```

That is different from generic GPTs/Claude workflows, where the model/tool loop is usually the center of the system. Here, the center is deterministic document correctness.

## Sources Checked

- OpenAI GPT creation/help: https://help.openai.com/en/articles/8554397-creating-a-custom-gpt
- OpenAI GPT FAQ: https://help.openai.com/en/articles/8554407-gpts-faq
- OpenAI GPT Actions: https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts
- OpenAI function calling: https://platform.openai.com/docs/guides/function-calling
- OpenAI structured outputs: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI agent evals: https://platform.openai.com/docs/guides/agent-evals
- Anthropic Claude Code subagents: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Anthropic Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Anthropic Claude Code memory: https://docs.anthropic.com/en/docs/claude-code/memory
- Anthropic eval tool: https://docs.anthropic.com/en/docs/test-and-evaluate/eval-tool
