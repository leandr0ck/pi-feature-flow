# pi-feature-flow

Pi package for feature-based ticket execution with a persistent registry, preflight validation, execution history, and next-ticket automation.

## What it adds

Commands:
- `/init-feature <slug>`
- `/start-feature <slug>`
- `/next-ticket <slug>`
- `/ticket-status <slug>`
- `/ticket-validate <slug>`
- `/ticket-done <slug>`
- `/ticket-blocked <slug>`
- `/ticket-needs-fix <slug>`

The extension:
- discovers features under a specs root
- discovers `tickets/*.md`
- validates required spec files before execution
- validates dependency graphs, missing dependencies, cycles, and orphan tickets
- creates and maintains a registry file
- keeps per-ticket run history (`start`, `resume`, `retry`)
- resolves the next executable ticket based on dependencies
- prioritizes `needs_fix` tickets for retry before untouched pending tickets
- launches your configured ticket execution workflow
- can auto-sync ticket status from agent output (`APPROVED`, `BLOCKED`, `NEEDS-FIX`)
- can scaffold a feature folder with starter files

## Expected structure

Default structure:

```text
./docs/technical-specs/
  <feature>/
    01-master-spec.md
    02-execution-plan.md
    tickets/
      STK-001.md
      STK-002.md
```

Each ticket can declare dependencies with a line like:

```md
- Requires: STK-001, STK-002
```

Alternative dependency parsing modes are also supported:
- `frontmatter`
- `custom` regex pattern

## Registry file

By default the extension writes:

```text
03-ticket-registry.json
```

inside each feature folder.

The registry stores:
- ticket status
- timestamps
- blocked reason
- execution run history

## Installation

### From local path

```bash
pi install /absolute/path/to/pi-feature-flow
```

### From git

```bash
pi install git:github.com/<you>/pi-feature-flow
```

Then run:

```bash
/reload
```

## Configuration

Create either:

- `.pi/feature-ticket-flow.json`
- `feature-ticket-flow.config.json`

Example:

```json
{
  "specsRoot": "../docs-vendraia/technical-specs",
  "ticketsDirName": "tickets",
  "registryFile": "03-ticket-registry.json",
  "featureSelectorTitle": "Choose feature",
  "requiredSpecFiles": ["01-master-spec.md", "02-execution-plan.md"],
  "executionMode": "chain-message",
  "executionTarget": "ticket-tdd-execution",
  "executionPromptTemplates": {
    "start": "Use the project chain \"{target}\" now.\nInput: feature={feature}; ticket={ticket}\nPhase: {phase}\nExecute only that ticket.\n{status_request}",
    "resume": "Resume ticket {ticket} for feature {feature}. Keep scope strict.\n{status_request}",
    "retry": "Retry ticket {ticket} for feature {feature}. Focus only on unresolved issues.\n{status_request}"
  },
  "executionStatusRequest": "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  "statusParsing": {
    "enabled": true,
    "approved": ["APPROVED"],
    "blocked": ["BLOCKED"],
    "needsFix": ["NEEDS-FIX"],
    "maxMessagesToInspect": 6
  },
  "dependencyParsing": {
    "mode": "requires-line",
    "requiresLabel": "Requires",
    "frontmatterField": "requires",
    "customPattern": "^-\\s*Depends on:\\s*(.+)$",
    "splitPattern": ","
  },
  "scaffold": {
    "createStarterTicket": true,
    "starterTicketId": "STK-001",
    "starterTicketTitle": "Initial implementation slice"
  }
}
```

## Execution modes

### `chain-message`
Sends a normal user message like:

```text
Use the project chain "ticket-tdd-execution" now.
Input: feature=my-feature; ticket=STK-001
Phase: start
Execute only that ticket.
When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.
```

### `command-message`
Sends:

```text
/<executionTarget> feature=my-feature; ticket=STK-001
```

### `custom-message`
Sends a very simple message and relies on your own prompt conventions.

### `subagent-chain`
Builds a structured prompt that tells Pi to use the `subagent` tool with a configured chain.

## Suggested workflow

1. Run `/init-feature <slug>` if the feature does not exist yet.
2. Create or refine the spec files and tickets.
3. Run `/ticket-validate <slug>`.
4. Run `/start-feature <slug>`.
5. Let the agent execute the selected ticket.
6. The extension can auto-update the registry if the agent clearly returns `APPROVED`, `BLOCKED`, or `NEEDS-FIX`.
7. You can still override manually with:
   - `/ticket-done <slug>`
   - `/ticket-blocked <slug>`
   - `/ticket-needs-fix <slug>`
8. Continue with `/next-ticket <slug>`.

## Publish

This repo is already structured as a Pi package:

- `package.json` contains the `pi` manifest
- `extensions/` contains the extension entrypoint

You can publish via npm or share directly from git.
