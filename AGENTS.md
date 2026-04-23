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

## Defaults

If `.pi/feature-flow.json` is missing, the project creates it automatically when task flow starts.

Default config path:
- `.pi/feature-flow.json`

Default docs/spec root:
- `./docs`

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
