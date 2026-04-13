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
- `/review-feature <feature-name>` — open the browser-based review viewer for a feature
- `/approve-feature <feature-name>` — approve a feature directly without opening the viewer
- `/request-feature-changes <feature-name> [comment]` — request changes on a feature
- `/start-feature <feature-name>` — show status and start or resume the next ticket (requires approval)
- `/next-ticket <feature-name>` — pick and execute the next available ticket automatically (requires approval)
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

## Optional subagent integration

This package does not bundle or require `pi-subagents` in order to load.

If your Pi environment already provides the `subagent` tool, `pi-feature-flow` will prefer subagent delegation for planner/worker/reviewer flows.

If `subagent` is unavailable, the package still works and falls back to direct execution with standard Pi tools such as `read`, `write`, `edit`, and `bash`.

## What it creates

```text
./docs/technical-specs/
  <feature>/
    01-master-spec.md
    02-execution-plan.md
    03-ticket-registry.json
    04-technical-design.md  (optional — for technically complex features)
    05-review-log.md        (generated on review actions)
    tickets/
      STK-001.md
      STK-002.md
      ...
```

Each ticket must declare its execution profile and dependencies with lines like:

```md
- Profile: frontend
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
6. Open the review viewer in your browser — you must approve before tickets can be executed.
7. Once approved, start the first ticket (or use `/start-feature` or `/next-ticket`).
8. Continue with `/next-ticket` until all tickets are done.

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
| `defaultProfile` | `string` | `"default"` | Fallback profile used when a ticket does not declare a profile or when a feature-level fallback is set manually. |
| `tdd` | `boolean` | `false` | Adds TDD-oriented guidance to planning and execution prompts. The project is responsible for having a usable test setup. |
| `authoringSkills.productRequirementsSkill` | `string` | `prd-development` | Skill used for product-facing requirements and problem framing. |
| `authoringSkills.requirementsRefinementSkill` | `string` | `spec-driven-workflow` | Skill used to refine requirements into clearer FR/NFR/acceptance criteria. |
| `profiles.<name>.matchAny` | `string[]` | `[]` | Optional legacy routing keywords. Ticket-level `- Profile:` is the primary routing mechanism. |
| `profiles.<name>.preferSubagents` | `boolean` | `true` | If false, disables subagent-first guidance for that profile. |
| `profiles.<name>.agents.<role>.agent` | `string` | builtin role name | Subagent name to use for planner/worker/reviewer. |
| `profiles.<name>.agents.<role>.model` | `string` | unset | Preferred model for that role. |
| `profiles.<name>.agents.<role>.thinking` | `string` | unset | Preferred thinking level for that role. |

## Master spec model

`01-master-spec.md` is always the main planning document.

- Simple feature → PRD Lite / Feature Spec
- Medium feature → PRD-first master spec
- Technically complex feature → PRD-first master spec, then wait for an explicit technical design document before refinement and tickets

### Authoring skill routing

| Feature type | Skill slots used |
|---|---|
| Simple | `productRequirementsSkill` |
| Medium | `productRequirementsSkill` + `requirementsRefinementSkill` |
| Technically complex | First `productRequirementsSkill`; then the workflow blocks and asks the user to add `04-technical-design.md` before refinement and ticket generation continue |

### Technical-design gate for very complex work

When the planner detects that refinement would be unsafe without additional technical detail — for example because of architecture, contracts, migrations, concurrency, or rollout concerns — it should:

1. write/update `01-master-spec.md`
2. stop before generating tickets
3. ask the user to add `04-technical-design.md`
4. continue planning after that document exists

The user can create `04-technical-design.md` however they prefer:
- manually
- with another skill
- from internal docs
- from external research

After the file exists, run:

```bash
/start-feature <feature>
```

The workflow will resume planning, write `02-execution-plan.md`, generate tickets, validate, and continue.

## Profiles

Profiles let you choose different agent/model preferences per ticket.

`/feature` stays profile-agnostic. The planner should assign a `- Profile:` to each ticket so mixed frontend/backend features can execute correctly.

Example:
- `frontend` profile for UI and onboarding work
- `backend` profile for API, queue, and DB work
- `direct-mode` profile when you want no subagent delegation

The selected profile for each ticket is read from the ticket file. A feature-level profile can still be persisted in the registry as a manual fallback via `/feature-profile`, but ticket-level `- Profile:` takes precedence.

To set a feature-level fallback profile manually:

```bash
/feature-profile my-feature frontend
```

To inspect the current profile and options:

```bash
/feature-profile my-feature
```

## Suggested workflow

1. Start with `/feature <description>`.
2. Review the generated master spec and execution plan in the browser viewer.
3. Approve, request changes, or close the review. If you request changes, update the docs and run `/review-feature <feature>` again.
4. Once approved, the first ticket becomes executable. Use the viewer prompt or run `/start-feature <feature>`.
5. Confirm each generated ticket has a `- Profile:` and `- Requires:` line.
6. Let the package execute tickets. Use `/next-ticket <feature>` until the feature is done.
7. Use `/ticket-done`, `/ticket-blocked`, or `/ticket-needs-fix` if you need to override the current ticket state.

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
| `missing-ticket-profile` | error | A ticket is missing a required `- Profile:` line. |

## Publish

This repo is structured as a Pi package:
- `package.json` contains the `pi` manifest
- `extensions/` contains the extension entrypoint
- `skills/` contains bundled workflow skills
- `prompts/` contains bundled prompt templates

Publish via npm or share directly from git.
