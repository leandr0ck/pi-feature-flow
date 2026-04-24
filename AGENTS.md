# AGENTS.md

## Scope

This repo is `pi-feature-flow`.

It is a Pi extension that takes a feature spec, generates an execution plan, and then drives development ticket by ticket.

The goal of this strategy is to keep context narrow and specific for each task, instead of solving the whole feature in one large context.
Each ticket execution can learn from what was implemented before and persist that knowledge into shared feature memory for the rest of the feature run.

The project API is the code in this repo plus the Pi extension hooks it consumes.

## Upstream reference

`https://github.com/badlogic/pi-mono` is a **reference only** repo.
It is **not** this project.

Use it only when a task needs a specific Pi platform detail, contract, or package boundary.
Do **not** read it on every task.
Do **not** assume upstream files, commands, or packages exist here unless verified locally.

## Upstream packages

- `@mariozechner/pi-ai` — LLM API, providers, streaming, handoffs
- `@mariozechner/pi-agent-core` — agent runtime, events, tool execution
- `@mariozechner/pi-coding-agent` — terminal coding agent CLI
- `@mariozechner/pi-tui` — terminal UI framework
- `@mariozechner/pi-web-ui` — web chat UI components
- `@mariozechner/pi-mom` — Slack bot / automation app
- `@mariozechner/pi` (`packages/pods`) — GPU pod and vLLM management

## Cost and model philosophy

`pi-feature-flow` is designed to **spend reasoning where reasoning matters and optimize cost per phase**.

The core idea: **use the cheapest model that is still strong enough for the job**.

### Model tier guidance

| Role | Task shape | Recommended tier |
|------|------------|------------------|
| **Planner** | high-judgment decomposition, sequencing, dependency reasoning | strong reasoning model |
| **Tester** | narrow mechanical test authoring | cheap / lightweight model |
| **Worker** | code synthesis, debugging, scope-safe implementation | strong implementation model |
| **Reviewer** | correctness validation, scope control, regression detection | strong review model |
| **Manager** | synthesis, abstraction, feature memory consolidation | strong synthesis model |

The rule of thumb:
- use **cheap models for narrow mechanical work** (e.g. writing structured JSON, test files, handoff logs)
- use **stronger models for planning, review, and synthesis**

### Your job as an agent

When working on this codebase:
1. **Detect model-tier mismatches**: if you see a cheap model being used for high-judgment tasks, or a strong model wasted on mechanical tasks — flag it
2. **Suggest model improvements**: if the current config uses an expensive model where a cheaper one would suffice, suggest the change
3. **Respect the tier per role**: if you modify role logic or add new phases, align the model tier to the task shape — do not default everything to the strongest model
4. **Track cost per phase**: if adding a new role or phase, consider the cost model — the goal is better feature execution per dollar, not full automation

The extension already switches models per role at runtime. Your job is to make sure the model choices match the task complexity.

## Rules

- Make the smallest correct change.
- Keep defaults aligned across code, config, tests, and docs.
- Do not change workflow semantics casually.
- Do not rename artifacts or lifecycle files without updating validators and tests.
- Do not leave failing tests or failing typecheck.

## Before finishing

Run:

```bash
npm run typecheck
npm test -- --run
```

## Where to look first

- `extensions/feature-ticket-flow.ts`
- `src/config-store.ts`
- `src/config.ts`
- `src/registry.ts`
- `src/feature-flow/prompts.ts`
- `tests/feature-ticket-flow.test.ts`
- `tests/config-store.test.ts`

## If you change...

### config behavior
Update:
- `src/config-store.ts`
- `src/config.ts`
- `default-config.json`
- `tests/config-store.test.ts`
- `tests/config.test.ts`

### command flow
Update:
- `extensions/feature-ticket-flow.ts`
- `tests/feature-ticket-flow.test.ts`

### templates or artifacts
Update:
- prompts/templates/validators
- related tests

### registry or lifecycle state
Update:
- `src/registry.ts`
- `src/run-history.ts`
- `src/feature-flow/state.ts`
- related tests
