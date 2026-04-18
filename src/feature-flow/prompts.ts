import path from "node:path";
import { loadConfig, renderAgentRoles } from "../config.js";
import { buildExecutionPlanTemplateInstructions } from "../execution-plan-template.js";
import { buildTicketTemplateInstructions } from "../ticket-template.js";
import type { FeatureFlowConfig } from "../types.js";

// ─── Planning prompt ──────────────────────────────────────────────────────────

/**
 * Builds the planning prompt for the planner agent.
 * Reads from an existing spec document and produces execution plan + tickets.
 */
export function buildFeaturePlanningPrompt(
  feature: string,
  specsRoot: string,
  specPath: string,
  config: FeatureFlowConfig,
  tddEnabled: boolean,
): string {
  const featureDir = path.join(specsRoot, feature);

  return [
    `Run the bundled \`feature-planning\` skill for feature "${feature}".`,
    "",
    "## Inputs",
    `Feature directory: ${featureDir}`,
    `Spec document to read: ${specPath}`,
    "",
    "## Goal",
    "Read the spec document and produce a complete feature package:",
    `- ${path.join(featureDir, "02-execution-plan.md")}`,
    `- ticket files under ${path.join(featureDir, "tickets")}`,
    "",
    "Do NOT rewrite or move the spec document.",
    "Do NOT add a product review step or ask the user to approve in a browser.",
    "",
    "## Planner rules",
    "- Read the spec carefully before writing anything.",
    "- Write an execution plan with clear sequencing, approach, and validation strategy.",
    "- Create small, dependency-aware tickets as thin vertical slices.",
    "- Every ticket must include a `- Requires:` line.",
    "- Use STK-001, STK-002, ... ticket ids.",
    "- Keep all generated files inside the feature directory.",
    ...(tddEnabled
      ? [
          "- TDD is enabled. Include test expectations in the execution plan and tickets.",
          "- Prefer tickets that keep the red-green-refactor loop small and local.",
        ]
      : []),
    "",
    buildExecutionPlanTemplateInstructions(),
    "",
    buildTicketTemplateInstructions([]),
    "",
    "## Agent configuration",
    ...renderAgentRoles(config),
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");
}

// ─── Tester prompt (TDD — separate agent, red phase only) ───────────────────

/**
 * Prompt for the tester agent. Runs independently before the worker.
 * Goal: write failing tests, confirm red state, leave tester notes for the worker.
 */
export function buildTesterPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  testerNotesPath: string,
  config: FeatureFlowConfig,
): string {
  const masterSpecPath = path.join(featureDir, "01-master-spec.md");
  const executionPlanPath = path.join(featureDir, "02-execution-plan.md");
  const testerConfig = config.agents?.tester ?? {};

  return [
    `Run the bundled \`feature-execution\` skill — **Tester phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    `- Spec: ${masterSpecPath}`,
    `- Execution plan: ${executionPlanPath}`,
    `- Ticket: ${ticketPath}`,
    "",
    "## Your role: Tester (TDD red phase)",
    "- Use the `tdd` skill if available.",
    "- Read the ticket acceptance criteria carefully.",
    "- Write the smallest set of failing tests that prove the ticket goal.",
    "- Do NOT implement the feature — write tests only.",
    "- Confirm the tests are in the red state (failing for the right reason).",
    "",
    `## Output: write tester notes to ${testerNotesPath}`,
    "Use this exact format:",
    "```md",
    `# Tester Notes — ${ticketId}`,
    "",
    "## Tests written",
    "- <file path>: <what it tests>",
    "",
    "## Red state confirmed",
    "- <how you verified the tests are failing>",
    "",
    "## Notes for worker",
    "- <anything the worker should know before implementing>",
    "```",
    "",
    "## Agent configuration",
    ...(testerConfig.model ? [`model: ${testerConfig.model}`] : []),
    ...(testerConfig.thinking ? [`thinking: ${testerConfig.thinking}`] : []),
    ...(testerConfig.skills?.length ? [`skills: ${testerConfig.skills.join(", ")}`] : []),
    "",
    "When you finish, clearly say APPROVED (tests written and red), BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary.",
  ].join("\n");
}

// ─── Ticket execution prompt ──────────────────────────────────────────────────

/**
 * Builds the full ticket execution prompt including all agent roles:
 * tester (if TDD) → worker → reviewer → chief
 */
export function buildTicketExecutionPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  memoryPath: string | undefined,
  testerNotesPath: string | undefined,
  workerContextPath: string | undefined,
  config: FeatureFlowConfig,
  phase: "start" | "resume" | "retry",
): string {
  const masterSpecPath = path.join(featureDir, "01-master-spec.md");
  const executionPlanPath = path.join(featureDir, "02-execution-plan.md");

  const lines: string[] = [
    `Run the bundled \`feature-execution\` skill — **Worker/Reviewer/Chief phase** for feature "${feature}" ticket "${ticketId}".`,
    `Phase: ${phase}`,
    "",
    "## Files to read first",
    `- Spec: ${masterSpecPath}`,
    `- Execution plan: ${executionPlanPath}`,
    `- Ticket: ${ticketPath}`,
  ];

  if (testerNotesPath) {
    lines.push(`- Tester notes: ${testerNotesPath}  (failing tests written by the tester — read before implementing)`);
  }

  if (memoryPath) {
    lines.push(`- Feature memory: ${memoryPath}  (accumulated context from previous tickets)`);
  }

  if (phase === "retry" && workerContextPath) {
    lines.push(`- Worker context: ${workerContextPath}  (⚠️ RETRY — read this first: what was done, what failed, continuation notes)`);
  }

  lines.push(
    "",
    "## Execution rules",
    "- Implement ONLY the assigned ticket. Do not pull future tickets into scope.",
    "- Prefer minimal, testable changes.",
    "- If you discover follow-up work, record it in the ticket or execution plan rather than silently expanding scope.",
    "- If you cannot complete the ticket due to a real blocker, stop and explain clearly.",
  );

  if (testerNotesPath) {
    lines.push(
      "",
      "## Worker (TDD — green phase)",
      "- The tester has already written failing tests. Read the tester notes before writing any code.",
      "- Implement the smallest slice that makes those tests pass (green phase).",
      "- Clean up and refactor if safe (refactor phase).",
    );
  } else {
    lines.push(
      "",
      "## Worker",
      "- Implement the smallest slice that satisfies the ticket goal.",
      "- Run targeted verification where possible.",
    );
  }

  lines.push(
    "",
    "## Reviewer",
    "- Use the `code-reviewer` skill if available.",
    "- Review the diff against the ticket acceptance criteria.",
    "- Verify tests pass.",
    "- Flag any concerns before the chief updates state.",
  );

  lines.push(
    "",
    "## Chief — update state and memory",
    "After the reviewer finishes:",
    `1. Append a dated learnings entry to ${memoryPath || path.join(featureDir, "04-feature-memory.md")}`,
    "   - Technical decisions made in this ticket",
    "   - Patterns discovered (useful utilities, conventions, traps to avoid)",
    "   - Any context that will help the next ticket start faster",
    "   - If the file doesn't exist yet, create it with a short header first.",
    `2. Write a worker context file to ${workerContextPath || path.join(featureDir, "tickets", `${ticketId}-worker-context.md`)}`,
    "   Use this exact format:",
    "   ```md",
    `   # Worker Context — ${ticketId}`,
    "",
    "   ## Status",
    "   <APPROVED | NEEDS-FIX | BLOCKED>",
    "",
    "   ## Files modified",
    "   - <path>: <what was done> [complete | partial | failed]",
    "",
    "   ## Reviewer findings",
    "   - <issue or 'none'>",
    "",
    "   ## Continuation notes",
    "   - <what the next attempt must know: what not to redo, what to fix, where it failed>",
    "   ```",
    "   This file is read on retry — keep it concise and actionable.",
    "3. The ticket registry is updated automatically — do not modify it directly.",
    "",
    "## Agent configuration",
    ...renderAgentRoles(config),
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary of what was done.",
  );

  return lines.join("\n");
}

// ─── Subagent guidance ────────────────────────────────────────────────────────

export function buildSubagentGuidance(config: FeatureFlowConfig, phase: "planning" | "execution"): string[] {
  const agentPrefs = renderAgentRoles(config);

  const lines = [
    "- If the `subagent` tool is available in Pi, prefer subagent delegation.",
    phase === "planning"
      ? "- Delegation order: planner (creates plan + tickets)."
      : "- Delegation order: tester → worker → reviewer → chief.",
    ...(agentPrefs.length > 0
      ? ["- Use these configured role preferences when delegating:", ...agentPrefs]
      : []),
    "- If subagents are unavailable, do the work directly with read/write/edit/bash.",
  ];

  return lines;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function resolveSpecFileInFeatureDir(featureDir: string): string {
  // Convention: spec file is 01-master-spec.md
  return path.join(featureDir, "01-master-spec.md");
}

export async function loadConfigForCwd(cwd: string) {
  return loadConfig(cwd);
}
