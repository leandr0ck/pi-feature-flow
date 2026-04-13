# pi-feature-flow

Pi extension for feature-based ticket execution with a persistent registry, preflight validation, dependency tracking, and next-ticket automation.

## What it adds

Commands:
- `/init-feature <slug>` — scaffold a feature folder with spec files and starter ticket
- `/start-feature <slug>` — show status and start or resume the next ticket
- `/next-ticket <slug>` — pick and execute the next available ticket automatically
- `/ticket-status <slug>` — show current feature ticket progress
- `/ticket-validate <slug>` — validate spec files, dependencies, and ticket structure
- `/ticket-done <slug>` — mark the current in-progress ticket as done
- `/ticket-blocked <slug>` — mark the current in-progress ticket as blocked
- `/ticket-needs-fix <slug>` — mark the current in-progress ticket as needs-fix and retry

The extension:
- discovers features under a configurable specs root
- discovers `tickets/*.md` files and extracts dependencies
- validates required spec files before execution
- validates dependency graphs (missing deps, cycles, orphans)
- creates and maintains a registry with run history
- keeps per-ticket run history (`start`, `resume`, `retry`)
- resolves the next executable ticket based on dependencies
- prioritizes `needs_fix` tickets for retry before pending ones
- auto-syncs ticket status from agent output (`APPROVED`, `BLOCKED`, `NEEDS-FIX`)

## Expected structure

```
./docs/technical-specs/
  <feature>/
    01-master-spec.md
    02-execution-plan.md
    tickets/
      STK-001.md
      STK-002.md
      ...
```

Each ticket declares dependencies with a line like:

```md
# STK-002 — Second ticket

- Requires: STK-001
```

## Registry file

The extension writes `03-ticket-registry.json` inside each feature folder, storing ticket status, timestamps, blocked reasons, and run history.

## Installation

```bash
pi install git:github.com/leandr0ck/pi-feature-flow
```

## Configuration

Create `.pi/feature-ticket-flow.json` in your project root to override defaults.

```json
{
  "specsRoot": "./docs/technical-specs"
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `specsRoot` | `string` | `"./docs/technical-specs"` | Root directory containing feature folders. Resolved relative to your project root. |

All other behavior follows conventions embedded in the code:
- `tickets/` subdirectory inside each feature
- `03-ticket-registry.json` as the registry filename
- `01-master-spec.md` and `02-execution-plan.md` as required spec files
- `STK-001` as the starter ticket id
- `APPROVED` / `BLOCKED` / `NEEDS-FIX` as status keywords

## Suggested workflow

1. Run `/init-feature <slug>` to create the feature folder.
2. Write or refine the spec files and ticket markdown files.
3. Run `/ticket-validate <slug>` to check for structural issues.
4. Run `/start-feature <slug>` to see status and launch the first ticket.
5. The extension auto-updates the registry when the agent returns `APPROVED`, `BLOCKED`, or `NEEDS-FIX`.
6. Override manually with `/ticket-done`, `/ticket-blocked`, or `/ticket-needs-fix` as needed.
7. Continue with `/next-ticket <slug>` to keep the flow going.

## Registry schema

```typescript
interface TicketRegistry {
  feature: string;
  version: 1;
  updatedAt: string;
  tickets: TicketRecord[];
}

interface TicketRecord {
  id: string;
  title: string;
  path: string;
  dependencies: string[];
  status: "pending" | "in_progress" | "needs_fix" | "done" | "blocked";
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  runs: TicketRun[];
}

interface TicketRun {
  startedAt: string;
  finishedAt?: string;
  mode: "start" | "resume" | "retry";
  outcome?: "approved" | "blocked" | "needs_fix" | "done";
  note?: string;
}
```

## Validation rules

| Code | Severity | Description |
|------|----------|-------------|
| `missing-spec-file` | error | A required spec file is missing. |
| `missing-tickets-dir` | error | The tickets directory doesn't exist. |
| `no-tickets` | error | No `.md` ticket files found. |
| `duplicate-ticket-id` | error | Two tickets share the same id (case-insensitive). |
| `missing-dependency` | error | A ticket depends on a non-existent ticket. |
| `dependency-cycle` | error | Circular dependency detected. |
| `invalid-ticket-id` | warning | Ticket id doesn't match recommended pattern (`STK-001` or `T1`). |
| `duplicate-dependency` | warning | The same dependency is listed twice for one ticket. |
| `orphan-ticket` | warning | A ticket has no dependencies and nothing depends on it. |

## Publish

This repo is structured as a Pi package:
- `package.json` contains the `pi` manifest
- `extensions/` contains the extension entrypoint

Publish via npm or share directly from git.