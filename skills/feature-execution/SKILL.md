---
name: feature-execution
description: Execute a single feature ticket through the tester → worker → reviewer → manager pipeline. Use when implementing or retrying one ticket in the bundled feature workflow.
---

# Feature Ticket Execution

Use this skill to execute exactly one ticket.

When TDD is enabled, the system runs **two separate agent phases**:
1. **Tester phase** — a dedicated agent writes failing tests and produces tester notes.
2. **Worker/Reviewer/Manager phase** — a separate agent reads those notes, implements the feature, and reviews and records the result.

When TDD is disabled, only the Worker/Reviewer/Manager phase runs.

---

## Tester phase (TDD only)

The tester agent receives a focused prompt. Its only job is the **red phase**.

### Files to read first
- `01-master-spec.md`
- `02-execution-plan.md`
- The target ticket file

### Goal
- Read the ticket acceptance criteria carefully.
- Write the smallest set of failing tests that prove the ticket goal.
- Do **not** implement the feature — write tests only.
- Confirm the tests are in the red state (failing for the right reason).

### Output: tester notes file
Write `tickets/<ticket-id>-tester-notes.md` with this exact format:

```md
# Tester Notes — <ticket-id>

## Tests written
- <file path>: <what it tests>

## Red state confirmed
- <how you verified the tests are failing>

## Hidden test dependencies
- <check all that apply>
  - [ ] uses full endpoint behavior rather than raw persistence
  - [ ] assumes valid derived data exists
  - [ ] depends on wrapped response format
  - [ ] depends on role-specific semantics (reject / ignore / strip field)
  - [ ] relies on specific database state or seed data
  - [ ] other: <specify>

## Notes for worker
- <anything the worker should know before implementing>
```

### Outcome contract
End with one of:
- `APPROVED` — tests written and red state confirmed
- `BLOCKED` — cannot write tests due to missing context or infrastructure
- `NEEDS-FIX` — tests were written but red state could not be confirmed

---

## Worker / Reviewer / Manager phase

The worker agent receives a separate prompt that includes the tester notes path.

### Files to read first
- `01-master-spec.md`
- `02-execution-plan.md`
- The target ticket file
- `tickets/<ticket-id>-tester-notes.md` (if TDD — **read before writing any code**)
- `04-feature-memory.md` (if it exists — accumulated context from previous tickets)

### Worker
- Read the tester notes first. The tests are already written and failing.
- Implement the smallest slice that makes those tests pass (green phase).
- Clean up and refactor if safe (refactor phase).
- If TDD is off: implement the smallest slice that satisfies the ticket goal directly.
- Prefer minimal, testable changes.
- Do not pull future tickets into scope.

#### Failure triage (mandatory)
After the first failing test run, classify each failure into exactly one bucket:
- **implementation** — code path exists but logic is wrong
- **fixture/setup** — test data, DB state, or setup is incomplete
- **contract/response-shape** — test and API disagree on response format
- **authorization/role** — wrong permissions or missing auth setup
- **duplicate/idempotency** — repeated inserts hitting unique constraints
- **precondition missing** — feature code never reached (entity absent despite 2xx)
- **convention-dependent** — behavior depends on undocumented conventions

If failures span 2+ buckets, pause and summarize root causes before editing.

#### Fixture-depth awareness
If a test combines HTTP calls with raw DB inserts, warn that fixtures may bypass required side effects.

#### Response-shape awareness
If a test probes multiple alternative shapes (e.g. a?.b || a?.c), verify the actual endpoint contract before implementing.

#### Precondition awareness
Before concluding a failure is an implementation gap, confirm the relevant code branch was actually reached.

#### Duplicate-data awareness
If errors include "duplicate key" or "unique constraint" — check for non-idempotent test setup before debugging domain logic.

#### Root-cause grouping (after second failure)
If the second run still has multiple failures, stop and group them:
- Group A: implementation gaps
- Group B: fixture/setup issues
- Group C: contract mismatch
- Group D: unresolved / convention-dependent

This breaks the "patch one symptom at a time" loop.

#### Confidence gating
Before marking APPROVED, state confidence separately for:
- Implementation correctness
- Fixture correctness
- Contract alignment
- Test pass state

If implementation is confident but tests fail due to setup ambiguity, return NEEDS-FIX with explicit cause categories.

### Reviewer
- Use the `code-reviewer` skill if available.
- Review the diff against the ticket acceptance criteria.
- Verify tests pass.
- Flag any correctness, security, or maintainability concerns.
- Do not proceed to the manager if critical issues remain unaddressed.

### Manager
After the reviewer gives the green light:

1. **Append the ticket learnings to `04-feature-memory.md`** (cumulative, cross-ticket):
   - Add the ticket's reusable learnings under the existing structured sections.
   - Keep the file in this canonical format:
   ```md
   # Feature Memory — <feature>

   ## Patterns confirmed
   - <reusable patterns that worked>

   ## Decisions
   - <important technical or product decisions>

   ## Pitfalls to avoid
   - <mistakes, traps, or regressions to avoid>

   ## Ticket learnings
   ### <feature>
   - <ISO date> <ticket-id>: <summary of what future tickets should reuse>
   ```

2. **Write `tickets/<ticket-id>-worker-context.md`** (per-ticket, per-attempt — used on retry):
   ```md
   # Worker Context — <ticket-id>

   ## Status
   <APPROVED | NEEDS-FIX | BLOCKED>

   ## Files modified
   - <path>: <what was done> [complete | partial | failed]

   ## Reviewer findings
   - <issue or 'none'>

   ## Continuation notes
   - <what not to redo, what to fix, where it failed>
   ```
   Keep it concise. If NEEDS-FIX, the continuation notes are the most important part.

3. The ticket registry is updated automatically — do not modify `03-ticket-registry.json` directly.

### Outcome contract

End with one of:
- `APPROVED` — ticket is complete, memory updated
- `BLOCKED` — external dependency or missing info prevents progress
- `NEEDS-FIX` — partial work landed but ticket is not ready; note what remains

Include a one-line summary after the keyword.
