# pi-feature-flow

Pi package for feature-based ticket execution with a persistent registry, preflight validation, execution history, and next-ticket automation.

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
- discovers `tickets/*.md` ticket files and extracts dependencies
- validates required spec files before execution
- validates dependency graphs (missing deps, cycles, orphans)
- creates and maintains a registry file with run history
- keeps per-ticket run history (`start`, `resume`, `retry`)
- resolves the next executable ticket based on dependencies
- prioritizes `needs_fix` tickets for retry before pending ones
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
      ...
```

Each ticket can declare dependencies with a line like:

```md
# STK-002 — Second ticket

- Requires: STK-001
```

Alternative dependency parsing modes are also supported via config.

## Registry file

By default the extension writes:

```text
03-ticket-registry.json
```

inside each feature folder.

The registry stores ticket status, timestamps, blocked reason, and execution run history.

## Installation

### From git

```bash
pi install git:github.com/leandr0ck/pi-feature-flow
```

## Configuration

Create either:
- `.pi/feature-ticket-flow.json`
- `feature-ticket-flow.config.json`

in your project root. The extension searches both, preferring the first found.

---

### Config reference

#### `specsRoot`

```json
"specsRoot": "./docs/technical-specs"
```

**Type:** `string`
**Default:** `"./docs/technical-specs"`

Root directory where feature folders are located. Resolved relative to your project root (cwd).

---

#### `ticketsDirName`

```json
"ticketsDirName": "tickets"
```

**Type:** `string`
**Default:** `"tickets"`

Name of the subdirectory inside each feature folder that contains `.md` ticket files.

---

#### `registryFile`

```json
"registryFile": "03-ticket-registry.json"
```

**Type:** `string`
**Default:** `"03-ticket-registry.json"`

Filename of the registry file written inside each feature folder. The registry tracks ticket status and run history.

---

#### `featureSelectorTitle`

```json
"featureSelectorTitle": "Choose feature"
```

**Type:** `string`
**Default:** `"Choose feature"`

Title shown in the interactive feature selector when you run a command without specifying a feature slug.

---

#### `requiredSpecFiles`

```json
"requiredSpecFiles": ["01-master-spec.md", "02-execution-plan.md"]
```

**Type:** `string[]`
**Default:** `["01-master-spec.md", "02-execution-plan.md"]`

List of filenames that must exist inside a feature folder before execution is allowed. If any are missing, `/start-feature` blocks execution.

---

#### `executionMode`

```json
"executionMode": "chain-message"
```

**Type:** `"chain-message" | "command-message" | "custom-message" | "subagent-chain"`
**Default:** `"chain-message"`

How the extension sends the ticket execution request to the agent.

| Mode | Description |
|------|-------------|
| `chain-message` | Sends a formatted user message instructing Pi to use a named project chain with feature/ticket context. |
| `command-message` | Sends a slash command (e.g. `/ticket-tdd-execution feature=...; ticket=...`). |
| `custom-message` | Sends a simple contextual message using the `executionPromptTemplate` format. |
| `subagent-chain` | Builds a structured prompt telling Pi to invoke the `subagent` tool with a configured chain of agents. |

---

#### `executionTarget`

```json
"executionTarget": "ticket-tdd-execution"
```

**Type:** `string`
**Default:** `"ticket-tdd-execution"`

Name of the project chain or command to invoke. Used in `chain-message` and `command-message` modes.

---

#### `executionPromptTemplate`

```json
"executionPromptTemplate": "Use the project chain \"{target}\" now.\nInput: feature={feature}; ticket={ticket}\nExecute only that ticket.\n{status_request}"
```

**Type:** `string`
**Default:** *(varies by mode)*

Fallback template for all execution phases. Supports placeholders:
- `{target}` — the `executionTarget` value
- `{feature}` — the current feature slug
- `{ticket}` — the current ticket id
- `{phase}` — execution phase (`start`, `resume`, `retry`)
- `{status_request}` — the `executionStatusRequest` text
- `{chain_json}` — serialized `executionChain` JSON (useful for `subagent-chain`)

---

#### `executionPromptTemplates`

```json
"executionPromptTemplates": {
  "start": "...",
  "resume": "...",
  "retry": "...",
  "blocked": "..."
}
```

**Type:** `Partial<Record<"start" | "resume" | "retry" | "blocked", string>>`
**Default:** `{}`

Phase-specific templates that override `executionPromptTemplate` for each execution mode. When a phase key is set, its template is used instead of the fallback.

---

#### `executionChain`

```json
"executionChain": [
  { "agent": "planner", "task": "Plan feature={feature}; ticket={ticket}. Keep scope strict." },
  { "agent": "implementer", "task": "Build feature={feature}; ticket={ticket}." },
  { "agent": "verifier", "task": "Verify feature={feature}; ticket={ticket}. Return APPROVED, BLOCKED, or NEEDS-FIX." }
]
```

**Type:** `ExecutionChainStep[]`
**Default:** *(planner → implementer → verifier chain)*

List of agent steps used in `subagent-chain` mode. Each step has:
- `agent` — name of the agent to invoke
- `task` — task template with placeholder support (`{feature}`, `{ticket}`, `{status_request}`, etc.)

---

#### `executionStatusRequest`

```json
"executionStatusRequest": "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX."
```

**Type:** `string`
**Default:** `"When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX."`

Instruction appended to execution messages telling the agent to produce a recognizable outcome token. This is used by `statusParsing` to auto-update ticket status.

---

#### `statusParsing`

```json
"statusParsing": {
  "enabled": true,
  "approved": ["APPROVED"],
  "blocked": ["BLOCKED"],
  "needsFix": ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"],
  "maxMessagesToInspect": 6
}
```

**Type:** `object`

Controls whether and how the extension auto-updates ticket status from agent output.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Whether to parse agent output for status tokens. Default: `true`. |
| `approved` | `string[]` | Keywords that mark a ticket as `done`. Default: `["APPROVED"]`. |
| `blocked` | `string[]` | Keywords that mark a ticket as `blocked`. Default: `["BLOCKED"]`. |
| `needsFix` | `string[]` | Keywords that mark a ticket as `needs_fix`. Default: `["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"]`. |
| `maxMessagesToInspect` | `number` | How many of the most recent assistant messages to scan. Default: `6`. |

The extension inspects the last `maxMessagesToInspect` assistant messages in reverse order and matches exact lines (or whole text) against these keyword lists.

---

#### `dependencyParsing`

```json
"dependencyParsing": {
  "mode": "requires-line",
  "requiresLabel": "Requires",
  "frontmatterField": "requires",
  "customPattern": "^-\\s*Depends on:\\s*(.+)$",
  "splitPattern": ","
}
```

**Type:** `object`

Controls how ticket dependencies are extracted from `.md` files.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"requires-line" \| "frontmatter" \| "custom"` | Parsing strategy. Default: `"requires-line"`. |
| `requiresLabel` | `string` | Label to look for in `- Label: value` format. Default: `"Requires"`. |
| `frontmatterField` | `string` | YAML key in frontmatter block (`---...---`). Default: `"requires"`. |
| `customPattern` | `string` | Regex pattern with a capture group for the dependency list. Default: `"^-\\s*Depends on:\\s*(.+)$"`. |
| `splitPattern` | `string` | Separator for multiple dependencies. Default: `","`. |

**Mode: `requires-line`**

Looks for a markdown list item matching `- Requires: STK-001, STK-002`:

```md
# STK-002

- Requires: STK-001, STK-002
```

**Mode: `frontmatter`**

Extracts from YAML frontmatter:

```md
---
requires: STK-001, STK-002
---

# STK-002
```

**Mode: `custom`**

Uses `customPattern` regex with a capture group:

```json
"customPattern": "^-\\s*Depends on:\\s*(.+)$"
```

---

#### `scaffold`

```json
"scaffold": {
  "createStarterTicket": true,
  "starterTicketId": "STK-001",
  "starterTicketTitle": "Initial implementation slice"
}
```

**Type:** `object`

Controls what `/init-feature` creates.

| Field | Type | Description |
|-------|------|-------------|
| `createStarterTicket` | `boolean` | Whether to create a starter ticket in the tickets directory. Default: `true`. |
| `starterTicketId` | `string` | Filename id for the starter ticket (without `.md`). Default: `"STK-001"`. |
| `starterTicketTitle` | `string` | Title inserted in the starter ticket. Default: `"Initial implementation slice"`. |

---

## Execution modes

### `chain-message` (default)

Sends a normal user message instructing Pi to use a named project chain:

```
Use the project chain "ticket-tdd-execution" now.
Input: feature=my-feature; ticket=STK-001
Phase: start
Execute only that ticket.
When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.
```

### `command-message`

Sends a slash command:

```
/ticket-tdd-execution feature=my-feature; ticket=STK-001
```

### `custom-message`

Sends a simple message built from `executionPromptTemplate`:

```
feature=my-feature
ticket=STK-001
When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.
```

### `subagent-chain`

Builds a structured prompt telling Pi to invoke the `subagent` tool with a configured chain:

```
Use the subagent tool now with this exact chain configuration:
[
  {
    "agent": "planner",
    "task": "Plan my-feature/STK-001. Keep scope strict."
  },
  {
    "agent": "implementer",
    "task": "Build my-feature/STK-001."
  },
  {
    "agent": "verifier",
    "task": "Verify my-feature/STK-001. Return APPROVED, BLOCKED, or NEEDS-FIX."
  }
]
Context: feature=my-feature; ticket=STK-001
Execute only that ticket.
When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.
```

## Suggested workflow

1. Run `/init-feature <slug>` if the feature folder doesn't exist yet.
2. Create or refine the spec files and ticket markdown files.
3. Run `/ticket-validate <slug>` to check for structural issues.
4. Run `/start-feature <slug>` to see status and launch the first ticket.
5. Let the agent execute the selected ticket.
6. The extension can auto-update the registry if the agent returns `APPROVED`, `BLOCKED`, or `NEEDS-FIX` in its output.
7. You can manually override with:
   - `/ticket-done <slug>`
   - `/ticket-blocked <slug>`
   - `/ticket-needs-fix <slug>`
8. Continue with `/next-ticket <slug>` to keep the flow going.

## Registry schema

```typescript
interface TicketRegistry {
  feature: string;
  version: 2;
  updatedAt: string;          // ISO timestamp
  tickets: TicketRecord[];
}

interface TicketRecord {
  id: string;                 // e.g. "STK-001"
  title: string;             // extracted from markdown heading
  path: string;              // absolute path to the .md file
  dependencies: string[];     // ticket ids this ticket depends on
  status: "pending" | "in_progress" | "needs_fix" | "done" | "blocked";
  blockedReason?: string;    // set when status is "blocked"
  startedAt?: string;        // ISO timestamp of first run
  completedAt?: string;      // ISO timestamp when marked done
  updatedAt: string;         // ISO timestamp of last change
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

When you run `/ticket-validate <slug>` or `/start-feature <slug>`, the extension checks:

| Code | Severity | Description |
|------|----------|-------------|
| `missing-spec-file` | error | A required spec file from `requiredSpecFiles` is missing. |
| `missing-tickets-dir` | error | The tickets directory doesn't exist. |
| `no-tickets` | error | No `.md` ticket files found in the tickets directory. |
| `duplicate-ticket-id` | error | Two tickets have the same id (case-insensitive). |
| `missing-dependency` | error | A ticket depends on a ticket id that doesn't exist. |
| `dependency-cycle` | error | Circular dependency detected in the ticket graph. |
| `invalid-ticket-id` | warning | Ticket id doesn't match recommended pattern (`STK-001` or `T1`). |
| `duplicate-dependency` | warning | The same dependency is listed more than once for a ticket. |
| `orphan-ticket` | warning | A ticket has no dependencies and nothing depends on it. |

## Publish

This repo is already structured as a Pi package:
- `package.json` contains the `pi` manifest with the extensions entrypoint
- `extensions/` contains the extension implementation

You can publish to npm or share directly from git.