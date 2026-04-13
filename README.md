# pi-feature-flow

Pi package for feature-based ticket execution with a persistent registry and next-ticket automation.

## What it adds

Commands:
- `/start-feature <slug>`
- `/next-ticket <slug>`
- `/ticket-status <slug>`
- `/ticket-done <slug>`
- `/ticket-blocked <slug>`

The extension:
- discovers features under a specs root
- discovers `tickets/*.md`
- creates and maintains a registry file
- resolves the next executable ticket based on dependencies
- launches your configured ticket execution workflow

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

## Registry file

By default the extension writes:

```text
03-ticket-registry.json
```

inside each feature folder.

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

Example for Vendraia:

```json
{
  "specsRoot": "../docs-vendraia/technical-specs",
  "ticketsDirName": "tickets",
  "registryFile": "03-ticket-registry.json",
  "featureSelectorTitle": "Choose feature",
  "executionMode": "chain-message",
  "executionTarget": "ticket-tdd-execution",
  "executionStatusRequest": "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  "dependencyParsing": {
    "mode": "requires-line",
    "requiresLabel": "Requires"
  }
}
```

## Execution modes

### `chain-message`
Sends a normal user message like:

```text
Use the project chain "ticket-tdd-execution" now.
Input: feature=my-feature; ticket=STK-001
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

## Suggested workflow

1. Create the feature spec and tickets.
2. Run `/start-feature <slug>`.
3. Let the agent execute the selected ticket.
4. Mark the result with:
   - `/ticket-done <slug>`
   - `/ticket-blocked <slug>`
5. Continue with `/start-feature <slug>` or `/next-ticket <slug>`.

## Publish

This repo is already structured as a Pi package:

- `package.json` contains the `pi` manifest
- `extensions/` contains the extension entrypoint

You can publish via npm or share directly from git.
