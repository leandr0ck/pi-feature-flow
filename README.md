# pi-feature-flow

pi-feature-flow turns a feature spec into a durable, iterative execution workflow. Instead of solving a full feature in one large chat context, it creates a plan and executes development ticket by ticket. Each ticket runs with narrow, task-specific context, while reusable learnings are persisted into shared feature memory for the rest of the feature.

## Why this exists

This package is meant to reduce context rot.
Instead of solving an entire feature in one large chat context, it:

1. starts from a feature spec
2. generates an execution plan and dependency-aware tickets
3. executes one ticket at a time
4. keeps each phase narrow and task-specific
5. stores what was learned in durable feature memory

That gives you smaller contexts, better traceability, and a reusable record of what was decided and implemented.

## Core workflow

```text
01-master-spec.md
  → /feature-plan
  → 02-execution-plan.md
  → tickets/*.md
  → /feature-start or /feature-next
  → ticket-by-ticket execution
  → feature memory + handoff artifacts
```

### Phases

- **Planner**: reads the spec and creates the execution plan + tickets
- **Tester**: writes failing tests when `tdd: true`
- **Worker**: implements the ticket
- **Reviewer**: validates the implementation and can fix within ticket scope if needed
- **Manager**: updates feature memory and continuation context

## Commands

- `/feature-init <feature>` — scaffold a feature folder with a stub `01-master-spec.md`
- `/feature-plan <feature>` — generate execution plan + tickets from a spec
- `/feature-start <feature>` — show status and start or resume the next ticket
- `/feature-next <feature>` — pick and execute the next available ticket automatically
- `/feature-done <feature>` — mark the current in-progress ticket as done
- `/feature-blocked <feature>` — mark the current in-progress ticket as blocked
- `/feature-needs-fix <feature>` — mark the current in-progress ticket as needs-fix and optionally retry
- `/feature-status <feature>` — show ticket progress from the registry
- `/feature-validate <feature>` — validate spec files, dependencies, and ticket structure
- `/feature-cost <feature>` — show cost breakdown by ticket and phase
- `/feature-flow-status` — show runtime flow status
- `/feature-flow-settings` — show effective config and diagnostics
- `/feature-flow-reset` — clear stale runtime/checkpoint state

## Installation

```bash
pi install git:github.com/leandr0ck/pi-feature-flow
```

## Configuration

Config file:
- `.pi/feature-flow.json`

If it does not exist, the extension creates it automatically when task flow starts.

### Defaults

- `specsRoot`: `./docs`
- `tdd`: `false`
- `execution.autoStartFirstTicketAfterPlanning`: `true`
- `execution.autoAdvanceToNextTicket`: `true`
- `execution.allowExternalToolCalls`: `false`

### Real config shape

```json
{
  "specsRoot": "./docs",
  "tdd": false,
  "execution": {
    "autoStartFirstTicketAfterPlanning": true,
    "autoAdvanceToNextTicket": true,
    "allowExternalToolCalls": false
  },
  "agents": {
    "planner": {
      "agent": "claude",
      "model": "anthropic/claude-sonnet-4",
      "thinking": "low"
    },
    "tester": {
      "agent": "claude",
      "model": "anthropic/claude-haiku-4",
      "thinking": "off",
      "skills": ["tdd"]
    },
    "worker": {
      "agent": "claude",
      "model": "anthropic/claude-sonnet-4",
      "thinking": "medium"
    },
    "reviewer": {
      "agent": "claude",
      "model": "openai/gpt-4.1",
      "thinking": "low"
    },
    "manager": {
      "agent": "claude",
      "model": "anthropic/claude-sonnet-4",
      "thinking": "minimal",
      "skills": ["context-engineering-advisor"]
    }
  }
}
```

### Notes

- `agents` config is per role: `planner`, `tester`, `worker`, `reviewer`, `manager`.
- Keep model values concrete and explicit, e.g. `anthropic/claude-sonnet-4`.
- Role settings can override agent name, model, thinking level, and skills.

## Generated feature structure

```text
./docs/
  <feature>/
    01-master-spec.md
    02-execution-plan.md
    03-ticket-registry.json
    04-feature-memory.md
    tickets/
      STK-001.md
      STK-001-tester-notes.md
      STK-001-tester-handoff.json
      STK-001-worker-handoff.json
      STK-001-reviewer-notes.md
      STK-001-reviewer-handoff.json
      STK-001-worker-context.md
      STK-001-manager-handoff.json
      STK-001-handoff-log.md
```

## Ticket format

Tickets should declare dependencies and editable files explicitly:

```md
# STK-002 — Add welcome email trigger

## Goal
Send the welcome email when onboarding completes for the first time.

- Requires: STK-001
- Files: src/onboarding/complete.ts, tests/onboarding/complete.test.ts

## Implementation Notes
- Reuse the onboarding completion event.
- Guard against duplicate sends.

## Acceptance Criteria
- Completing onboarding sends one welcome email.
- Repeating completion does not send duplicates.
```

## Persistence and traceability

The workflow writes durable artifacts so the agent does not have to reconstruct history from chat:

- **Registry** tracks ticket status and runs
- **Handoff files** carry phase-specific state between roles
- **Feature memory** stores reusable learnings for the rest of the feature
- **Worker context** preserves continuation notes for retries
- **Checkpoint state** allows resume after restart

## How to use it

1. Run `/feature-init <feature>` if you need a stub spec.
2. Fill in `01-master-spec.md`.
3. Run `/feature-plan <feature>` to create the plan and tickets.
4. Run `/feature-start <feature>` or `/feature-next <feature>` to begin execution.
5. Use `/feature-done`, `/feature-blocked`, or `/feature-needs-fix` when needed.

## Development

## Package layout

- `extensions/` — Pi extension entrypoint
- `src/` — config, prompts, registry, validation, UI helpers
- `skills/` — bundled workflow skills
- `prompts/` — prompt templates
- `tests/` — unit and integration coverage
