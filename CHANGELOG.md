# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **`allowExternalToolCalls` config flag**: new `execution.allowExternalToolCalls` flag disables bash command blocking (migrate, db:push, direct SQL) for projects that need it outside feature-flow sessions.
- **Governance only when active**: tool-call governance now returns early when no feature-flow session is active, allowing normal agent usage without restrictions.
- **Status bar phase + model + thinking**: status bar now shows `[ticket › PHASE › model:active-model | thinking:level]` including the real active model and current thinking level, refreshed immediately on handoff and on `model_select` events.
- **Visible model switch feedback**: `applyRoleRuntimeConfig` now emits `notify` messages confirming which model is active per role (including thinking level), making model switches transparent.

## [0.4.0] - 2026-04-21

### Changed
- **Explicit runtime execution phases**: execution is now split into real `worker -> reviewer -> chief` phases instead of one combined worker/reviewer/chief turn.
- **Runtime model switching per role**: `agents.<role>.model` and `agents.<role>.thinking` are now applied before each real phase launch, not just rendered into prompts.
- **Per-phase cost accounting** now records `tester`, `worker`, `reviewer`, and `chief` separately.

### Added
- **Reviewer notes artifact**: reviewer now writes `tickets/<id>-reviewer-notes.md`, which the chief reads before finalizing memory / worker context.
- **Integration coverage for model switching** across planner, tester, worker, and reviewer handoffs.

## [0.3.0] - 2026-04-18

### Added
- **TDD two-phase execution**: tester and worker now run as separate agent phases with different model configurations. The tester writes failing tests, produces `tickets/<id>-tester-notes.md`, and the worker reads those notes before implementing.
- **Checkpoint persistence**: execution state is saved to `.pending-execution.json` and recovered on `session_start` after a crash or pi restart.
- **Retry context enrichment**: the Chief writes `tickets/<id>-worker-context.md` at the end of each ticket with files modified, reviewer findings, and continuation notes. On retry, the worker reads this file first to know exactly what to fix.
- **Cost tracking**: token usage and cost per ticket/phase are recorded. New `/feature-cost <name>` command shows a cost breakdown by ticket. Data stored in `05-cost.json`.

### Changed
- Removed YAML config support — JSON (`.pi/feature-flow.json`) is now the only config format.
- Added 120 unit + integration tests (was 33).

## [0.2.0] - 2026-04-13

### Added
- **Feature review & approval gate**: feature spec execution now requires explicit user approval before tickets can be executed. No more automatic ticket execution after planning.
- **Review state in registry**: `03-ticket-registry.json` now tracks `review.status` (`pending_review | approved | changes_requested`)
- **New extension**: `feature-review-viewer.ts` — opens a browser-based review UI with tabs for Master Spec, Execution Plan, and Technical Design (if exists)
- **New commands**:
  - `/review-feature <feature>` — opens the browser-based review viewer
  - `/approve-feature <feature>` — quick approval without opening the viewer
  - `/request-feature-changes <feature> [comment]` — request changes and save feedback
- **Review gate**: `/start-feature` and `/next-ticket` are blocked if the feature is not approved; they show the review status and instructions
- **Review log**: feedback and review actions are persisted in `05-review-log.md` inside the feature folder
- **Review status in `renderStatus()`**: the status badge is shown in ticket status output
- **`canExecuteFeature()` guard**: centralized check for review approval status
- **`renderFeatureReviewStatus()`**: helper to format review summary in TUI

### Changed
- `/feature <description>` no longer auto-starts the first ticket after planning. Instead, it opens the review viewer and waits for approval before enabling ticket execution.
- `loadRegistry()` now merges the `review` field from existing registries when discovering tickets, preserving review state across discovery cycles.

### Technical
- New files: `src/feature-flow/review.ts`, `src/feature-flow/review-html.ts`, `extensions/feature-review-viewer.ts`
- Package now ships 2 extensions (was 1)

## [0.1.7] - 2026-04-13

### Removed
- `technicalDesignSkill` and the `technical-specification` skill slot — no longer bundled or configured

### Changed
- `/feature` no longer creates a starter ticket automatically; it waits for planning output first
- `/init-feature` still scaffolds a feature folder with a starter ticket for manual use
- Authoring skill routing simplified: simple → PRD only; medium → PRD + refinement; technically complex → PRD first, then external technical document gate before refinement

### Added
- External technical document gate: when the planner detects significant technical complexity (architecture, contracts, migrations, concurrency, rollout), it stops before refinement and tickets, and asks the user to add `04-technical-design.md`
- `maybeContinuePlanning()` function checks for `04-technical-design.md` and resumes planning via `/start-feature <feature>` when the document exists and no tickets have been generated yet
- New `buildPlanningContinuationPrompt()` for resuming planning after the technical design document is provided

### Updated
- README, skill docs, and prompts updated to reflect the new flow and removed skill slot

## [0.1.8] - 2026-04-13

### Changed
- `02-execution-plan.md` now uses a strict markdown template with fixed sections for approach, sequence, dependencies, validation, and rollout
- Planning prompts now include the exact execution plan template as well as the ticket template
- Feature scaffolding now generates the execution plan from a shared template renderer

### Added
- `execution-plan-template-mismatch` validation error when `02-execution-plan.md` does not follow the required template
- Shared execution plan template helpers used by scaffolding, planning prompts, and validation

## [0.1.7] - 2026-04-13

### Changed
- Ticket generation now uses a strict markdown template with fixed sections: `Goal`, `Implementation Notes`, and `Acceptance Criteria`
- Planning prompts now include the exact ticket template instead of relying on looser natural-language guidance
- Starter ticket scaffolding now comes from the shared ticket template renderer

### Added
- `ticket-template-mismatch` validation error when a ticket does not follow the required markdown template
- Shared ticket template helpers used by scaffolding, planning prompts, and validation

## [0.1.6] - 2026-04-13

### Changed
- `/feature` is now profile-agnostic — no longer requires an explicit profile
- Execution profile is now declared per-ticket via `- Profile: <name>` in ticket files
- Profile resolution follows precedence: ticket profile → feature-level fallback → defaultProfile
- Profile routing validated before ticket execution (rejects unknown profiles)

### Added
- `missing-ticket-profile` validation error when a ticket lacks `- Profile:` line
- Profile check in `validateBeforeExecution` blocks execution of unknown ticket profiles
- `profileName` field on `TicketRecord` parsed from ticket markdown files
- Starter ticket now includes `- Profile: default` line

### Updated
- Skill docs (`feature-planning`, `feature-execution`) now document the `- Profile:` requirement
- `feature-ticket-flow.example.yaml` documents the new ticket-level profile approach

