# Changelog

All notable changes to this project will be documented in this file.

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

