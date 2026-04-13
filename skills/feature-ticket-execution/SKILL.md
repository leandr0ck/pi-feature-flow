---
name: feature-ticket-execution
description: Execute a single feature ticket as a thin vertical slice, using the feature spec, execution plan, and ticket file as the source of truth. Use when implementing or retrying one ticket in the bundled feature workflow.
---

# Feature Ticket Execution

Use this skill to execute exactly one ticket.

## Inputs to read first

Read these before changing code:
- feature master spec
- feature execution plan
- the target ticket file

## Execution rules

1. Implement only the assigned ticket.
2. Respect dependencies and do not pull future tickets into scope.
3. Prefer minimal, testable changes.
4. Update tests and docs only when they are directly affected.
5. If you discover follow-up work, capture it in the feature artifacts rather than silently expanding scope.
6. If you cannot complete the ticket due to a real blocker, stop and explain the blocker clearly.

## Good execution pattern

- understand ticket goal
- inspect relevant code paths
- implement smallest viable slice
- run targeted verification
- summarize what changed

## Outcome contract

Always end with one of:
- `APPROVED` when the ticket is complete
- `BLOCKED` when an external dependency or missing information prevents progress
- `NEEDS-FIX` when partial work landed but the ticket is not ready

Include a short note after the keyword when useful.
