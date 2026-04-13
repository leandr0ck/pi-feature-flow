---
name: feature-planning
description: Turn a natural-language feature request into a full feature package with a master spec, execution plan, and dependency-aware ticket files. Use when a user describes functionality and wants the workflow to create the planning artifacts automatically before implementation.
---

# Feature Factory

Use this skill when the user gives a feature request in plain language and expects the system to create a feature package automatically.

## Goal

Convert a feature request into:
- `01-master-spec.md`
- `02-execution-plan.md`
- `tickets/STK-001.md`, `STK-002.md`, ...

## Normalized planning stack

Use `feature-planning` as the orchestration skill and normalize the document-authoring workflow like this:

1. **Classify the feature first**
   - **Simple feature**: one narrow flow, low risk, few business rules, no critical integrations.
   - **Medium feature**: multiple states/validations, some integrations, moderate backend or UX complexity.
   - **Complex system**: many business rules, multiple actors, critical data flows, finance/inventory/compliance/security concerns.

2. **Select the source skill(s) for the master spec**
   - **Simple** → use `prd-development` as the base, but produce a **PRD Lite** in `01-master-spec.md`.
   - **Medium** → use `prd-development` + `spec-driven-workflow`.
   - **Technically complex** → first use `prd-development` to establish the master spec, then stop and ask the user to add `04-technical-design.md` before refinement and ticket generation continue.

3. **Normalize document roles**
   - `01-master-spec.md` is always the **main product-facing document**.
   - For simple work it can be a **PRD Lite / Feature Spec**.
   - For medium and technically complex work it should be a **PRD-first master spec**.
   - If deeper technical detail is required before safe refinement, ask the user to provide `04-technical-design.md`. That document supports the master spec; it does not replace it.

4. **Golden rule**
   - Do **not** start from pure implementation detail if product scope, actors, business rules, or success criteria are still unclear.
   - For complex systems, the master spec should answer **what/why/scope/success** before the tickets decompose the **how**.

## Working rules

1. Read any existing files in the target feature directory first.
2. Keep everything inside the target feature folder.
3. Prefer thin vertical slices over architecture-first decomposition.
4. Every ticket must include both a `- Profile:` line and a `- Requires:` line.
5. Ticket ids should be sequential: `STK-001`, `STK-002`, ...
6. Keep ticket scope independently verifiable.
7. Do not start implementing app code during planning unless the parent prompt explicitly asks for it.

## Master spec expectations

`01-master-spec.md` should follow this normalized shape:

### For simple features
Produce a **PRD Lite / Feature Spec** with at least:
- summary
- problem / user goal
- target users or actors
- scope
- non-goals
- functional requirements
- acceptance criteria
- lightweight UX / API / data notes if relevant
- risks or open questions

### For medium or complex features
Produce a **PRD-first master spec** with at least:
- executive summary
- problem statement
- target users / actors
- business context / why now
- goals and success metrics
- scope
- functional requirements
- non-functional requirements when relevant
- acceptance criteria
- risks / dependencies
- open questions
- linked technical follow-ups if needed

### Technical detail policy
- Keep the master spec product-readable first.
- Include only the technical notes required to make planning unambiguous.
- If architecture, data models, contracts, integrations, migration, concurrency, or rollout strategy become substantial enough that refinement would be unsafe, stop and ask the user to add `04-technical-design.md`.
- The user may create `04-technical-design.md` manually, with another skill, or from internal/external documentation.

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
- `- Profile:` line with exactly one execution profile name
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
Ticket profiles should be explicit so mixed frontend/backend features route correctly during execution.
If critical information is missing — including missing `04-technical-design.md` for technically complex work — say `BLOCKED` and explain why.
If the plan exists but needs another pass, say `NEEDS-FIX`.
