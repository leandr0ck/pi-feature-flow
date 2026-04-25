export function renderTesterNotesTemplate(ticketId: string): string {
  return [
    `# Tester Notes — ${ticketId}`,
    "",
    "## Tests written",
    "- <file path>: <what it tests>",
    "",
    "## Test guidelines followed",
    "- <project-specific test conventions or patterns applied>",
    "",
    "## Hidden test dependencies",
    "- <check all that apply>",
    "  - [ ] uses full endpoint behavior rather than raw persistence",
    "  - [ ] assumes valid derived data exists",
    "  - [ ] depends on wrapped response format",
    "  - [ ] depends on role-specific semantics (reject / ignore / strip field)",
    "  - [ ] relies on specific database state or seed data",
    "  - [ ] other: <specify>",
    "",
    "## Notes for worker",
    "- <anything the worker must know: file paths, imports, test command>",
    "",
  ].join("\n");
}

export type HandoffPhase = "tester" | "worker" | "reviewer" | "manager";

/**
 * Phase-aware handoff log template.
 * Only the current phase section has placeholders to fill.
 * Future phase sections are shown as HTML comments to provide context
 * but won't trigger the placeholder detector.
 */
export function renderHandoffLogTemplate(ticketId: string): string {
  return renderHandoffLogTemplateForPhase(ticketId, "tester");
}

export function renderHandoffLogTemplateForPhase(ticketId: string, phase: HandoffPhase): string {
  const sections: Record<HandoffPhase, string[]> = {
    tester: [
      "## Tester",
      "- Tests written: <files and scope>",
      "- Test guidelines followed: <project conventions used>",
      "- Risks / assumptions: <none | bullets>",
      "- Notes for worker: <key context>",
      "",
      "<!-- ## Worker section: filled by Worker phase after tests are implemented -->",
      "",
      "<!-- ## Reviewer section: filled by Reviewer phase after Worker completes -->",
      "",
      "<!-- ## Manager section: filled by Manager phase as final step -->",
    ],
    worker: [
      "## Tester",
      "- Tests written: <files and scope>",
      "- Test guidelines followed: <project conventions used>",
      "- Notes for worker: <key context>",
      "",
      "## Worker",
      "- Files changed: <paths>",
      "- Technical decisions: <none | bullets>",
      "- Risks / tradeoffs: <none | bullets>",
      "- Notes for reviewer/manager: <key context>",
      "",
      "<!-- ## Reviewer section: filled by Reviewer phase after Worker completes -->",
      "",
      "<!-- ## Manager section: filled by Manager phase as final step -->",
    ],
    reviewer: [
      "## Tester",
      "- Tests written: ...",
      "- Notes for worker: ...",
      "",
      "## Worker",
      "- Files changed: ...",
      "- Technical decisions: ...",
      "",
      "## Reviewer",
      "- Verifications: <checks performed>",
      "- Findings: <none | bullets>",
      "- Edits made: <none | tests added/updated | implementation adjusted>",
      "- Residual risks: <none | bullets>",
      "- Recommendation: <APPROVED | NEEDS-FIX | BLOCKED>",
      "",
      "<!-- ## Manager section: filled by Manager phase as final step -->",
    ],
    manager: [
      "## Tester",
      "- Tests written: ...",
      "",
      "## Worker",
      "- Files changed: ...",
      "- Technical decisions: ...",
      "",
      "## Reviewer",
      "- Findings: ...",
      "- Recommendation: ...",
      "",
      "## Manager",
      "- Promoted to feature memory: <none | bullets>",
      "- Reusable patterns for future tickets: <none | bullets>",
      "- Continuation advice: <none | bullets>",
    ],
  };

  return [
    `# Handoff Log — ${ticketId}`,
    "",
    ...sections[phase],
  ].join("\n");
}

export function renderReviewerNotesTemplate(ticketId: string): string {
  return [
    `# Reviewer Notes — ${ticketId}`,
    "",
    "## Verdict",
    "<APPROVED | NEEDS-FIX | BLOCKED>",
    "",
    "## Findings",
    "- <specific issue, or 'none'>",
    "",
    "## Reviewer edits made",
    "- <none | tests added/updated | implementation adjusted>",
    "",
    "## Evidence",
    "- <test output, files inspected, typecheck result>",
    "",
  ].join("\n");
}

export function renderWorkerContextTemplate(ticketId: string): string {
  return [
    `# Worker Context — ${ticketId}`,
    "",
    "## Status",
    "<APPROVED | NEEDS-FIX | BLOCKED>",
    "",
    "## Files modified",
    "- <path>: <what was done> [complete | partial | failed]",
    "",
    "## Reviewer findings",
    "- <issue or 'none'>",
    "",
    "## Failure classification",
    "- <check all that apply>",
    "  - [ ] implementation failure",
    "  - [ ] fixture/setup failure",
    "  - [ ] contract/response-shape mismatch",
    "  - [ ] authorization/role mismatch",
    "  - [ ] duplicate data / idempotency issue",
    "  - [ ] precondition missing (feature code never reached)",
    "  - [ ] unknown / convention-dependent",
    "",
    "## Root cause groups (if multiple failures)",
    "- Group A: <implementation gaps>",
    "- Group B: <fixture/setup issues>",
    "- Group C: <contract mismatch>",
    "- Group D: <unresolved / convention-dependent>",
    "",
    "## Continuation notes",
    "- <what the next attempt must know>",
    "",
  ].join("\n");
}

export function renderFeatureMemoryTemplate(feature: string): string {
  return [
    `# Feature Memory — ${feature}`,
    "",
    "## Patterns confirmed",
    "- <reusable patterns that worked>",
    "",
    "## Decisions",
    "- <important technical or product decisions>",
    "",
    "## Pitfalls to avoid",
    "- <mistakes, traps, or regressions to avoid>",
    "",
    "## Ticket learnings",
    `### ${feature}`,
    "- <placeholder — replace with dated ticket summaries>",
    "",
  ].join("\n");
}

export function renderTesterHandoffJsonTemplate(ticketId: string): string {
  return JSON.stringify({
    ticketId,
    phase: "tester",
    status: "APPROVED",
    testsWritten: [
      { path: "tests/example.test.ts", scope: "covers the acceptance criteria" },
    ],
    testGuidelines: ["followed project test conventions"],
    notesForWorker: ["run the documented test command first"],
  }, null, 2);
}

export function renderWorkerHandoffJsonTemplate(ticketId: string): string {
  return JSON.stringify({
    ticketId,
    phase: "worker",
    status: "APPROVED",
    filesChanged: [
      { path: "src/example.ts", summary: "implemented the minimal slice", status: "complete" },
    ],
    technicalDecisions: ["kept implementation minimal to match the ticket"],
    risks: ["none"],
    notesForReviewer: ["tests and typecheck were run"],
  }, null, 2);
}

export function renderReviewerHandoffJsonTemplate(ticketId: string): string {
  return JSON.stringify({
    ticketId,
    phase: "reviewer",
    status: "APPROVED",
    findings: ["none"],
    editsMade: ["none"],
    evidence: ["tests pass", "typecheck clean"],
    residualRisks: ["none"],
    recommendation: "APPROVED",
  }, null, 2);
}

export function renderManagerHandoffJsonTemplate(ticketId: string): string {
  return JSON.stringify({
    ticketId,
    phase: "manager",
    status: "APPROVED",
    promotedToFeatureMemory: ["documented decisions and reusable patterns"],
    reusablePatterns: ["reuse the validated implementation pattern in future tickets"],
    continuationAdvice: ["read feature memory before starting the next ticket"],
  }, null, 2);
}



export function toMarkdownCodeFence(content: string): string[] {
  return ["```md", ...content.trimEnd().split("\n"), "```"];
}

export function toJsonCodeFence(content: string): string[] {
  return ["```json", ...content.trimEnd().split("\n"), "```"];
}

/**
 * Render a failure analysis section for use in tester or worker handoffs.
 * The agent fills this after the first failing test run to classify failures
 * before making edits.
 */
export function renderFailureAnalysisTemplate(): string {
  return [
    "## Failure triage",
    "Classify each failing assertion into exactly one bucket:",
    "",
    "| Failure | Bucket |",
    "|---------|--------|",
    "| <describe failure> | implementation |",
    "| <describe failure> | fixture/setup |",
    "| <describe failure> | contract/response-shape |",
    "| <describe failure> | authorization/role |",
    "| <describe failure> | duplicate/idempotency |",
    "| <describe failure> | convention-dependent |",
    "| <describe failure> | unknown |",
    "",
    "### Root cause summary",
    "- <if failures span 2+ buckets, pause and summarize likely root causes>",
    "",
    "### Confidence assessment",
    "- Implementation correctness: <high | medium | low>",
    "- Fixture correctness:       <high | medium | low>",
    "- Contract alignment:        <high | medium | low>",
    "- Test pass state:           <passing | failing>",
    "",
  ].join("\n");
}
