# Changelog

All notable changes to this project will be documented in this file.

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

