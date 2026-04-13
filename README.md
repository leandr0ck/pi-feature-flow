# pi-feature-flow

Pi package for turning a feature description into:
- a feature folder
- a master spec
- an execution plan
- dependency-aware tickets
- automatic next-ticket execution with registry tracking

## Commands

- `/feature <description>` — create a feature from a description and start the workflow
- `/init-feature <feature-name>` — scaffold a feature folder with spec files and a starter ticket
- `/start-feature <feature-name>` — show status and start or resume the next ticket
- `/next-ticket <feature-name>` — pick and execute the next available ticket automatically
- `/ticket-status <feature-name>` — show current feature ticket progress
- `/ticket-validate <feature-name>` — validate spec files, dependencies, and ticket structure
- `/ticket-done <feature-name>` — mark the current in-progress ticket as done
- `/ticket-blocked <feature-name>` — mark the current in-progress ticket as blocked
- `/ticket-needs-fix <feature-name>` — mark the current in-progress ticket as needs-fix and retry
- `/feature-profile <feature-name> [profile]` — show or change the profile used for a feature

## Installation

```bash
pi install git:github.com/leandr0ck/pi-feature-flow
```

## What it creates

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

Each ticket must declare dependencies with a line like:

```md
- Requires: STK-001
```

## How it works

Run:

```text
/feature Build an onboarding flow with checklist, progress bar, and welcome email
```

The package will:
1. Derive a feature slug from the description.
2. Scaffold the feature folder.
3. Generate the master spec and execution plan.
4. Generate dependency-aware ticket files.
5. Validate the resulting structure.
6. Start the first executable ticket when planning is approved.

## Configuration

Config file:
- `.pi/feature-ticket-flow.yaml`

There is a ready-to-copy example in:
- `feature-ticket-flow.example.yaml`

### Minimal config

```yaml
specsRoot: ./docs/technical-specs
defaultProfile: default
```

### Recommended config

```yaml
specsRoot: ./docs/technical-specs
defaultProfile: default
tdd: false

authoringSkills:
  productRequirementsSkill: prd-development
  requirementsRefinementSkill: spec-driven-workflow
  technicalDesignSkill: technical-specification

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
```

### Supported fields

| Field | Type | Default | Description |
|---|---|---|---|
| `specsRoot` | `string` | `"./docs/technical-specs"` | Root directory containing feature folders. |
| `defaultProfile` | `string` | `"default"` | Profile used when no profile rule matches. |
| `tdd` | `boolean` | `false` | Adds TDD-oriented guidance to planning and execution prompts. The project is responsible for having a usable test setup. |
| `authoringSkills.productRequirementsSkill` | `string` | `prd-development` | Skill used for product-facing requirements and problem framing. |
| `authoringSkills.requirementsRefinementSkill` | `string` | `spec-driven-workflow` | Skill used to refine requirements into clearer FR/NFR/acceptance criteria. |
| `authoringSkills.technicalDesignSkill` | `string` | `technical-specification` | Skill used for deeper technical design when needed. |
| `profiles.<name>.matchAny` | `string[]` | `[]` | Keywords used to route a feature to a profile. |
| `profiles.<name>.preferSubagents` | `boolean` | `true` | If false, disables subagent-first guidance for that profile. |
| `profiles.<name>.agents.<role>.agent` | `string` | builtin role name | Subagent name to use for planner/worker/reviewer. |
| `profiles.<name>.agents.<role>.model` | `string` | unset | Preferred model for that role. |
| `profiles.<name>.agents.<role>.thinking` | `string` | unset | Preferred thinking level for that role. |

## Master spec model

`01-master-spec.md` is always the main planning document.

- Simple feature → PRD Lite / Feature Spec
- Medium feature → PRD-first master spec
- Complex feature → PRD-first master spec plus deeper technical sections when needed

### Authoring skill routing

| Feature type | Skill slots used |
|---|---|
| Simple | `productRequirementsSkill` |
| Medium | `productRequirementsSkill` + `requirementsRefinementSkill` |
| Complex | `productRequirementsSkill` + `requirementsRefinementSkill` + `technicalDesignSkill` |

## Profiles

Profiles let you choose different agent/model preferences by feature type.

Example:
- `frontend` profile for UI and onboarding work
- `backend` profile for API, queue, and DB work
- `direct-mode` profile when you want no subagent delegation

The selected profile is persisted in the feature registry, so later `/next-ticket` or `/start-feature` runs keep using the same profile.

To change a profile manually:

```bash
/feature-profile my-feature frontend
```

To inspect the current profile and options:

```bash
/feature-profile my-feature
```

## Suggested workflow

1. Use `/feature <description>`.
2. Review the generated master spec and execution plan.
3. Approve planning.
4. Let the package start the first ticket.
5. Continue with `/next-ticket <feature>` until the feature is done.
6. Use `/ticket-done`, `/ticket-blocked`, or `/ticket-needs-fix` if you need to override the current ticket state.

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
