import { promises as fs } from "node:fs";
import { HandoffPhase } from "../handoff-templates.js";

export type { HandoffPhase };

export type HandoffValidationResult = {
  ok: boolean;
  issues: string[];
};

/**
 * Detects unfilled template placeholders like <files and scope>.
 * HTML comments (<!-- ... -->) are stripped first to avoid false positives
 * from placeholder section markers that indicate future phases.
 */
function hasPlaceholderText(content: string): boolean {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  return /<[^>]+>/.test(withoutComments);
}

function hasRequiredHeadings(content: string, headings: string[]): boolean {
  return headings.every((heading) => content.includes(heading));
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isFileEntryArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry && typeof entry === "object"
      && isNonEmptyString((entry as Record<string, unknown>).path)
      && isNonEmptyString((entry as Record<string, unknown>).summary)
      && isNonEmptyString((entry as Record<string, unknown>).status));
}

function isTestEntryArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => entry && typeof entry === "object"
      && isNonEmptyString((entry as Record<string, unknown>).path)
      && isNonEmptyString((entry as Record<string, unknown>).scope));
}

async function validateMarkdownArtifact(
  filePath: string,
  headings: string[],
  label: string,
): Promise<string[]> {
  const content = await readTextIfExists(filePath);
  if (!content) return [`Missing ${label}: ${filePath}`];

  const issues: string[] = [];
  if (!hasRequiredHeadings(content, headings)) issues.push(`${label} is missing required sections: ${filePath}`);
  if (hasPlaceholderText(content)) issues.push(`${label} still contains template placeholders: ${filePath}`);
  return issues;
}

async function validateFeatureMemoryArtifact(filePath: string): Promise<string[]> {
  const content = await readTextIfExists(filePath);
  if (!content) return [`Missing feature memory: ${filePath}`];

  const currentHeadings = ["## Patterns confirmed", "## Decisions", "## Pitfalls to avoid", "## Ticket learnings"];

  const issues: string[] = [];
  if (!hasRequiredHeadings(content, currentHeadings)) {
    issues.push(`feature memory is missing required sections: ${filePath}`);
  }
  if (hasPlaceholderText(content)) issues.push(`feature memory still contains template placeholders: ${filePath}`);
  return issues;
}

async function validateJsonArtifact(
  filePath: string,
  phase: HandoffPhase,
): Promise<string[]> {
  const content = await readTextIfExists(filePath);
  if (!content) return [`Missing ${phase} handoff JSON: ${filePath}`];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [`Invalid ${phase} handoff JSON: ${filePath}`];
  }

  const issues: string[] = [];
  if (!isNonEmptyString(parsed.ticketId)) issues.push(`${phase} handoff JSON is missing ticketId: ${filePath}`);
  if (parsed.phase !== phase) issues.push(`${phase} handoff JSON has wrong phase: ${filePath}`);
  if (!isNonEmptyString(parsed.status)) issues.push(`${phase} handoff JSON is missing status: ${filePath}`);

  if (phase === "tester") {
    if (!isTestEntryArray(parsed.testsWritten)) issues.push(`tester handoff JSON must include testsWritten entries: ${filePath}`);
    if (!isStringArray(parsed.testGuidelines)) issues.push(`tester handoff JSON must include testGuidelines: ${filePath}`);
    if (!isStringArray(parsed.notesForWorker)) issues.push(`tester handoff JSON must include notesForWorker: ${filePath}`);
  }

  if (phase === "worker") {
    if (!isFileEntryArray(parsed.filesChanged)) issues.push(`worker handoff JSON must include filesChanged entries: ${filePath}`);
    if (!isStringArray(parsed.technicalDecisions)) issues.push(`worker handoff JSON must include technicalDecisions: ${filePath}`);
    if (!isStringArray(parsed.notesForReviewer)) issues.push(`worker handoff JSON must include notesForReviewer: ${filePath}`);
  }

  if (phase === "reviewer") {
    if (!isStringArray(parsed.findings)) issues.push(`reviewer handoff JSON must include findings: ${filePath}`);
    if (!isStringArray(parsed.editsMade)) issues.push(`reviewer handoff JSON must include editsMade: ${filePath}`);
    if (!isStringArray(parsed.evidence)) issues.push(`reviewer handoff JSON must include evidence: ${filePath}`);
    if (!isNonEmptyString(parsed.recommendation)) issues.push(`reviewer handoff JSON must include recommendation: ${filePath}`);
  }

  if (phase === "manager") {
    if (!isStringArray(parsed.promotedToFeatureMemory)) issues.push(`manager handoff JSON must include promotedToFeatureMemory: ${filePath}`);
    if (!isStringArray(parsed.reusablePatterns)) issues.push(`manager handoff JSON must include reusablePatterns: ${filePath}`);
    if (!isStringArray(parsed.continuationAdvice)) issues.push(`manager handoff JSON must include continuationAdvice: ${filePath}`);
  }

  return issues;
}

export async function validateTesterArtifacts(
  testerNotesPath: string,
  handoffLogPath: string,
  testerHandoffPath: string,
): Promise<HandoffValidationResult> {
  const issues = [
    ...await validateMarkdownArtifact(testerNotesPath, ["## Tests written", "## Test guidelines followed", "## Notes for worker"], "tester notes"),
    ...await validateMarkdownArtifact(handoffLogPath, ["## Tester", "## Worker", "## Reviewer", "## Manager"], "handoff log"),
    ...await validateJsonArtifact(testerHandoffPath, "tester"),
  ];
  return { ok: issues.length === 0, issues };
}

export async function validateWorkerArtifacts(
  handoffLogPath: string,
  workerHandoffPath: string,
): Promise<HandoffValidationResult> {
  const issues = [
    ...await validateMarkdownArtifact(handoffLogPath, ["## Worker", "## Reviewer", "## Manager"], "handoff log"),
    ...await validateJsonArtifact(workerHandoffPath, "worker"),
  ];
  return { ok: issues.length === 0, issues };
}

export async function validateReviewerArtifacts(
  reviewerNotesPath: string,
  handoffLogPath: string,
  reviewerHandoffPath: string,
): Promise<HandoffValidationResult> {
  const issues = [
    ...await validateMarkdownArtifact(reviewerNotesPath, ["## Verdict", "## Findings", "## Reviewer edits made", "## Evidence"], "reviewer notes"),
    ...await validateMarkdownArtifact(handoffLogPath, ["## Reviewer", "## Manager"], "handoff log"),
    ...await validateJsonArtifact(reviewerHandoffPath, "reviewer"),
  ];
  return { ok: issues.length === 0, issues };
}

export async function validateManagerArtifacts(
  workerContextPath: string,
  featureMemoryPath: string,
  handoffLogPath: string,
  managerHandoffPath: string,
): Promise<HandoffValidationResult> {
  const issues = [
    ...await validateMarkdownArtifact(workerContextPath, ["## Status", "## Files modified", "## Reviewer findings", "## Continuation notes"], "worker context"),
    ...await validateFeatureMemoryArtifact(featureMemoryPath),
    ...await validateMarkdownArtifact(handoffLogPath, ["## Manager"], "handoff log"),
    ...await validateJsonArtifact(managerHandoffPath, "manager"),
  ];
  return { ok: issues.length === 0, issues };
}


