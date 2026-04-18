---
name: feature-planning
description: Create an execution plan and dependency-aware tickets from a pre-existing spec document. Use when a user has a spec ready and wants the workflow to generate the plan and tickets automatically.
---

# Feature Planner

Use this skill when the user has an existing spec document and wants to generate a complete ticket plan from it.

## Role: planner

You are the **planner** agent. You do NOT write product specs — that work is already done.  
Your job is to read the spec and produce a lean, implementation-ready plan.

## Inputs

1. Read the spec document provided (e.g., `01-master-spec.md` or any user-supplied file).
2. Read any existing files in the feature directory to avoid duplicating work.

## Outputs to produce

- `02-execution-plan.md` — approach, sequencing, dependency logic, validation strategy
- `tickets/STK-001.md`, `STK-002.md`, ... — thin vertical slices

**Do NOT** modify the spec document.  
**Do NOT** open a web browser or ask the user to approve in a UI.  
**Do NOT** write application code during planning.

## Planning rules

1. Classify the spec scope: **simple** (one narrow flow) | **medium** (multiple states/integrations) | **complex** (many actors, data flows, migrations).
2. Choose ticket granularity accordingly — thin slices that can be independently verified.
3. Every ticket must include:
   - `- Requires: none | STK-001 | ...`
4. Use sequential ids: `STK-001`, `STK-002`, ...
5. Keep all files inside the feature directory.
6. If TDD is enabled, embed test expectations in tickets.
7. If critical technical detail is genuinely missing from the spec, say `BLOCKED` and describe exactly what is needed.

## Execution plan format (strict)

```md
# <feature> execution plan

## Approach Summary
- <2–4 bullets>

## Ticket Sequence
1. STK-001 — <slice>
2. STK-002 — <slice>

## Dependency Logic
- <why the order is safe and minimal>

## Validation Strategy
- <how each slice will be verified>

## Rollout Notes
- <optional rollout/migration notes, or "Not applicable">
```

Keep section names exactly as shown.

## Ticket format (strict)

```md
# STK-001 — <short title>

## Goal
<one short paragraph: the smallest verifiable outcome>

- Requires: none | STK-001 | STK-001, STK-002

## Implementation Notes
- <2–5 concrete notes>

## Acceptance Criteria
- <testable outcome>
- <testable outcome>
```

Keep section names exactly as shown.

## Good ticket slices

- data model + one narrow path
- UI + one backend path
- API endpoint + tests
- one workflow step end-to-end

## Bad ticket slices (avoid)

- "set up architecture"
- "refactor everything"
- "build the whole frontend"

## Finish state

- `APPROVED` — plan and tickets are coherent and ready for execution
- `BLOCKED` — critical information is missing; explain exactly what is needed
- `NEEDS-FIX` — plan exists but needs another pass
