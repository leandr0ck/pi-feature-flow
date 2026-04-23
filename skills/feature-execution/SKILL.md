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

### Reviewer
- Use the `code-reviewer` skill if available.
- Review the diff against the ticket acceptance criteria.
- Verify tests pass.
- Flag any correctness, security, or maintainability concerns.
- Do not proceed to the manager if critical issues remain unaddressed.

### Manager
After the reviewer gives the green light:

1. **Append a dated entry** to `04-feature-memory.md` (cumulative, cross-ticket):
   ```md
   ### After <ticket-id> — <ISO date>
   - <technical decision made>
   - <pattern discovered (reusable utils, conventions, traps)>
   - <anything that will help the next ticket start faster>
   ```
   If the file does not exist, create it with this header first:
   ```md
   # Feature Memory: <feature>

   Accumulated context built ticket by ticket. Read this before starting each new ticket.

   ## Accumulated Context
   - (the manager fills this in over time)
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
