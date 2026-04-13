# pi-feature-flow

Agent-driven Pi package for turning a plain-language feature request into:
- a feature folder
- a master spec
- an execution plan
- dependency-aware tickets
- automatic next-ticket execution with registry tracking

This package now bundles its own workflow resources and the `pi-subagents` extension, so users do **not** need to preinstall a separate chain just to make it work.

## What it adds

Commands:
- `/feature <description>` — create a feature from a natural-language description and start the workflow
- `/init-feature <feature-name>` — scaffold a feature folder with spec files and a starter ticket
- `/start-feature <feature-name>` — show status and start or resume the next ticket
- `/next-ticket <feature-name>` — pick and execute the next available ticket automatically
- `/ticket-status <feature-name>` — show current feature ticket progress
- `/ticket-validate <feature-name>` — validate spec files, dependencies, and ticket structure
- `/ticket-done <feature-name>` — mark the current in-progress ticket as done
- `/ticket-blocked <feature-name>` — mark the current in-progress ticket as blocked
- `/ticket-needs-fix <feature-name>` — mark the current in-progress ticket as needs-fix and retry
- `/feature-profile <feature-name> [profile]` — show the current profile for a feature, or set it to a different one

Bundled resources:
- extension orchestrator in `extensions/feature-ticket-flow.ts`
- bundled skills in `skills/`
- bundled prompt template in `prompts/feature-from-description.md`
- bundled `pi-subagents` dependency for agent delegation

## New UX

You can now just describe the functionality:

```text
quiero un onboarding con checklist, progress bar y email de bienvenida
```

Or explicitly:

```text
/feature Build an onboarding flow with checklist, progress bar, and welcome email
```

The package will:
1. derive a feature slug
2. scaffold the feature folder
3. ask the agent to write the master spec and execution plan
4. ask the agent to generate dependency-aware ticket files
5. validate the resulting structure
6. automatically start the first executable ticket when planning is approved

## Expected structure

```text
./docs/technical-specs/
  <feature>/
    01-master-spec.md
    02-execution-plan.md
    03-ticket-registry.json
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

## Why this no longer depends on a user-installed chain

Previous versions assumed a separate chain like `ticket-tdd-execution` already existed in the user's environment.

This package now avoids that hard dependency by bundling:
- its own skills
- its own prompt template
- `pi-subagents` as a packaged dependency

At runtime the workflow prefers subagent delegation when the bundled `subagent` tool is available, and otherwise falls back to direct agent execution.

## Configuration

Preferred config file:
- `.pi/feature-ticket-flow.yaml`

Legacy fallback still supported:
- `.pi/feature-ticket-flow.json`

Example YAML:

```yaml
specsRoot: ./docs/technical-specs
autoCapture: true
defaultProfile: default

profiles:
  default:
    preferSubagents: true
    agents:
      planner:
        model: anthropic/claude-sonnet-4
      worker:
        model: anthropic/claude-sonnet-4
      reviewer:
        model: openai/gpt-5.4

  frontend:
    matchAny: [ui, dashboard, page, onboarding]
    agents:
      reviewer:
        model: openai/gpt-5.4
```

There is also a ready-to-copy example in:
- `feature-ticket-flow.example.yaml`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `specsRoot` | `string` | `"./docs/technical-specs"` | Root directory containing feature folders. |
| `autoCapture` | `boolean` | `true` | Whether free-form user messages can auto-start feature creation. |
| `defaultProfile` | `string` | `default` | Profile used when no profile rule matches. |
| `profiles.<name>.matchAny` | `string[]` | `[]` | Keyword list used to route a feature to a specific profile. |
| `profiles.<name>.preferSubagents` | `boolean` | `true` | If false, disables subagent-first guidance for that profile. |
| `profiles.<name>.agents.<role>.agent` | `string` | builtin role name | Which subagent name to use for planner/worker/reviewer. |
| `profiles.<name>.agents.<role>.model` | `string` | unset | Preferred model for that role. |
| `profiles.<name>.agents.<role>.thinking` | `string` | unset | Preferred thinking level for that role. |

This lets each user choose different models per role. For example:
- reviewer on `openai/gpt-5.4`
- worker on `anthropic/claude-sonnet-4`
- a separate `frontend` or `backend` profile for different feature types

The selected profile is persisted in the feature registry, so once a feature starts with `frontend`, later `/next-ticket` or `/start-feature` runs keep using that same profile instead of re-matching from scratch.

To change a profile manually, use:

```bash
/feature-profile my-feature frontend
```

Without a second argument, the command shows the current profile and all available options:

```bash
/feature-profile my-feature
```

Conventions used by the package:
- `tickets/` subdirectory inside each feature
- `03-ticket-registry.json` as the registry filename
- `01-master-spec.md` and `02-execution-plan.md` as required spec files
- `STK-001` as the starter ticket id
- `APPROVED` / `BLOCKED` / `NEEDS-FIX` as status keywords

## Suggested workflow

1. Describe the functionality in natural language or use `/feature <description>`.
2. Let the agent generate the feature package.
3. The package validates the generated files.
4. When planning is approved, the package automatically starts the first ticket.
5. Continue with `/next-ticket <slug>` until the feature is done.
6. Override ticket outcomes manually with `/ticket-done`, `/ticket-blocked`, or `/ticket-needs-fix` when needed.

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
- `skills/` contains bundled workflow skills
- `prompts/` contains bundled prompt templates

Publish via npm or share directly from git.
