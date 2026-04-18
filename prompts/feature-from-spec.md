---
description: Plan a feature from an existing spec document and start the execution workflow
---
Read the spec document at the path or in the feature directory given below, then run the bundled feature workflow:

$@

Expectations:
- read the existing spec document (do NOT rewrite or move it)
- produce `02-execution-plan.md` with approach, ticket sequence, dependency logic, validation strategy
- create dependency-aware ticket files under `tickets/`
- if TDD is enabled, include test expectations in the plan and tickets
- when the plan is ready, say APPROVED and start executing tickets automatically
