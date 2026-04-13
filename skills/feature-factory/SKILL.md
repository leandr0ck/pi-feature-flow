---
name: feature-factory
description: Turn a natural-language feature request into a full feature package with a master spec, execution plan, and dependency-aware ticket files. Use when a user describes functionality and wants the workflow to create the planning artifacts automatically before implementation.
---

# Feature Factory

Use this skill when the user gives a feature request in plain language and expects the system to create a feature package automatically.

## Goal

Convert a feature request into:
- `01-master-spec.md`
- `02-execution-plan.md`
- `tickets/STK-001.md`, `STK-002.md`, ...

## Working rules

1. Read any existing files in the target feature directory first.
2. Keep everything inside the target feature folder.
3. Prefer thin vertical slices over architecture-first decomposition.
4. Every ticket must include a `- Requires:` line.
5. Ticket ids should be sequential: `STK-001`, `STK-002`, ...
6. Keep ticket scope independently verifiable.
7. Do not start implementing app code during planning unless the parent prompt explicitly asks for it.

## Master spec expectations

Include at least:
- problem / user goal
- target users or actors
- scope
- non-goals
- UX / API / data notes if relevant
- acceptance criteria
- risks or open questions

## Execution plan expectations

Include at least:
- approach summary
- sequence of tickets
- dependency logic
- validation / testing strategy
- rollout or migration notes if relevant

## Ticket writing guide

Each ticket should include:
- title
- goal
- `- Requires:` line
- implementation notes if useful
- acceptance criteria

Prefer slices like:
- data model + one narrow path
- UI + one backend path
- API endpoint + tests
- one workflow step end-to-end

Avoid tickets that are only:
- "set up architecture"
- "refactor everything"
- "build the whole frontend"

## Finish state

When the feature package is coherent and ready for execution, explicitly say `APPROVED`.
If critical information is missing, say `BLOCKED` and explain why.
If the plan exists but needs another pass, say `NEEDS-FIX`.
