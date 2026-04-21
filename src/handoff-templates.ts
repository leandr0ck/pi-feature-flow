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
    "## Notes for worker",
    "- <anything the worker must know: file paths, imports, test command>",
    "",
  ].join("\n");
}

export function renderHandoffLogTemplate(ticketId: string): string {
  return [
    `# Handoff Log — ${ticketId}`,
    "",
    "## Tester",
    "- Tests written: <files and scope>",
    "- Test guidelines followed: <project conventions used>",
    "- Risks / assumptions: <none | bullets>",
    "- Notes for worker: <key context>",
    "",
    "## Worker",
    "- Files changed: <paths>",
    "- Technical decisions: <none | bullets>",
    "- Risks / tradeoffs: <none | bullets>",
    "- Notes for reviewer/chief: <key context>",
    "",
    "## Reviewer",
    "- Verifications: <checks performed>",
    "- Findings: <none | bullets>",
    "- Edits made: <none | tests added/updated | implementation adjusted>",
    "- Residual risks: <none | bullets>",
    "- Recommendation: <APPROVED | NEEDS-FIX | BLOCKED>",
    "",
    "## Chief",
    "- Promoted to feature memory: <none | bullets>",
    "- Reusable patterns for future tickets: <none | bullets>",
    "- Continuation advice: <none | bullets>",
    "",
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

export function toMarkdownCodeFence(content: string): string[] {
  return ["```md", ...content.trimEnd().split("\n"), "```"];
}
