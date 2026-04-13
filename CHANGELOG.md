# Changelog

All notable changes to this project will be documented in this file.

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

