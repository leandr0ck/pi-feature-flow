# pi-feature-flow

pi-feature-flow turns a feature spec into a durable, iterative execution workflow. Instead of solving a full feature in one large chat context, it creates a plan and executes development ticket by ticket. Each ticket runs with narrow, task-specific context, while reusable learnings are persisted into shared feature memory for the rest of the feature.

## Why this exists

This package is meant to reduce context rot **and optimize model usage per task**.
Instead of solving an entire feature in one large chat context, it:

1. starts from a feature spec
2. generates an execution plan and dependency-aware tickets
3. executes one ticket at a time
4. keeps each phase narrow and task-specific
5. uses different models for different kinds of work
6. stores what was learned in durable feature memory

That gives you smaller contexts, better traceability, lower token spend, and a reusable record of what was decided and implemented.

### Cost and model philosophy

`pi-feature-flow` is designed to **spend reasoning where reasoning matters**.

The extension should:
- **not** use an expensive reasoning model for simple mechanical tasks like writing straightforward failing tests or producing structured handoff JSON
- **not** use a cheap lightweight model for high-judgment tasks like planning a feature, reviewing correctness, or consolidating reusable learnings
- switch models **per role / per phase** so each step uses the cheapest model that is still strong enough for that job

In practice, the workflow is optimized around this idea:
- **Planner** gets a stronger reasoning model because it has to decompose the feature correctly
- **Tester** gets a cheaper model because test authoring is narrower and more mechanical
- **Worker** gets a stronger implementation model because it must make code changes safely
- **Reviewer** gets a strong review model because correctness and scope control matter
- **Manager** gets a stronger synthesis model because it decides what should persist into feature memory

The goal is **better feature execution per dollar**, not just automation.

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

## Roles

The workflow is driven by five coordinated agent roles. Each role has a narrow, focused responsibility and writes structured handoff artifacts for the next phase.

| Role | Main job | Typical task shape | Default model strategy | Writes |
|------|----------|--------------------|------------------------|--------|
| **Planner** | Break the feature into a correct execution plan | high-judgment, dependency reasoning, sequencing | **strong reasoning model** | `02-execution-plan.md`, `tickets/*.md` |
| **Tester** | Write the smallest failing tests for the ticket | narrow, mechanical, spec-to-test translation | **cheaper / lighter model** | `*-tester-notes.md`, `*-tester-handoff.json`, `*-handoff-log.md` |
| **Worker** | Implement the ticket safely inside scope | code synthesis, debugging, local reasoning | **strong implementation model** | implementation files, `*-worker-handoff.json`, `*-handoff-log.md` |
| **Reviewer** | Validate correctness and fix small gaps if needed | high-judgment review, scope control, regression detection | **strong review model** | `*-reviewer-notes.md`, `*-reviewer-handoff.json`, `*-handoff-log.md` |
| **Manager** | Consolidate final learnings and continuation context | synthesis, abstraction, cross-ticket memory | **strong synthesis model** | `04-feature-memory.md`, `*-worker-context.md`, `*-manager-handoff.json`, `*-handoff-log.md` |

### Artifact lifecycle per ticket

```
Planner
  └─ 02-execution-plan.md       (shared, read by all)
  └─ tickets/STK-001.md         (shared, read by all)

Tester (tdd only)
  ├─ *-tester-notes.md          → Worker reads
  ├─ *-tester-handoff.json      → Worker reads
  └─ *-handoff-log.md           → Reviewer + Manager read

Worker
  ├─ <implementation files>     → Reviewer inspects
  ├─ *-worker-handoff.json      → Reviewer + Manager read
  └─ *-handoff-log.md           → Reviewer + Manager read

Reviewer
  ├─ *-reviewer-notes.md        → Manager reads
  ├─ *-reviewer-handoff.json    → Manager reads
  └─ *-handoff-log.md           → Manager reads + updates

Manager
  ├─ 04-feature-memory.md       ← NEW / UPDATED (shared, read by Worker of next tickets)
  ├─ *-worker-context.md        ← NEW (continuation notes for retries)
  ├─ *-manager-handoff.json     ← NEW
  └─ *-handoff-log.md           ← FINALIZED
```

### Who writes what, and with which model?

This workflow is intentionally **role-routed by model**.

| Output | Written by | Default model |
|--------|------------|---------------|
| `02-execution-plan.md` | Planner | `anthropic/claude-sonnet-4` |
| `tickets/STK-*.md` | Planner | `anthropic/claude-sonnet-4` |
| `*-tester-notes.md` | Tester | `anthropic/claude-haiku-4` |
| `*-tester-handoff.json` | Tester | `anthropic/claude-haiku-4` |
| implementation files | Worker | `anthropic/claude-sonnet-4` |
| `*-worker-handoff.json` | Worker | `anthropic/claude-sonnet-4` |
| `*-reviewer-notes.md` | Reviewer | `openai/gpt-4.1` |
| `*-reviewer-handoff.json` | Reviewer | `openai/gpt-4.1` |
| `04-feature-memory.md` | Manager | `anthropic/claude-sonnet-4` |
| `*-worker-context.md` | Manager | `anthropic/claude-sonnet-4` |
| `*-manager-handoff.json` | Manager | `anthropic/claude-sonnet-4` |

The runtime/control files are **not written by a model**. They are written by the extension itself:
- `03-ticket-registry.json`
- `.pending-execution.json`
- `feature-flow-history.jsonl`

### Recommended model tiers by role

Use the cheapest model that is still strong enough for the role.

| Role | Recommended tier | Why |
|------|------------------|-----|
| **Planner** | strong reasoning model | Needs decomposition, sequencing, dependency analysis, and good judgment about ticket boundaries. |
| **Tester** | cheap / lightweight model | Test authoring is usually narrower, more mechanical, and should be cheap to run repeatedly. |
| **Worker** | strong implementation model | Needs reliable code editing, local debugging, and enough reasoning to stay within ticket scope. |
| **Reviewer** | strong review model | Must catch correctness issues, scope creep, missing coverage, and regressions. |
| **Manager** | strong synthesis model | Must decide what is worth preserving in feature memory and what future tickets should reuse. |

A good default profile is:
- **Planner** → Sonnet / GPT-4.1 class
- **Tester** → Haiku / mini / low-cost class
- **Worker** → Sonnet / GPT-4.1 class
- **Reviewer** → GPT-4.1 / Sonnet class
- **Manager** → Sonnet / GPT-4.1 class

The rule of thumb is simple:
- use **cheap models for narrow mechanical work**
- use **stronger models for planning, review, and synthesis**

### Execution order per ticket

```
[Planner] ──► [Tester*] ──► Worker ──► Reviewer ──► Manager
                                    ▲           │
                                    └───────────┘
                                          (retry loop)
```

`* Tester` runs only when `tdd: true`. The retry loop (worker → reviewer → back to worker) handles `NEEDS-FIX` outcomes. `APPROVED` exits to Manager; `BLOCKED` halts the ticket.

### Phases

- **Planner**: reads the spec and creates the execution plan + tickets
- **Tester**: writes failing tests when `tdd: true`
- **Worker**: implements the ticket
- **Reviewer**: validates the implementation and can fix within ticket scope if needed
- **Manager**: finalizes knowledge handoff, writes feature memory, worker context, handoff log, and manager JSON — then closes the ticket in the registry

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
