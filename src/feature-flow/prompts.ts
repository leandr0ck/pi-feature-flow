import path from "node:path";
import { loadConfig, renderAgentRoles } from "../config.js";
import { buildExecutionPlanTemplateInstructions } from "../execution-plan-template.js";
import { buildTicketTemplateInstructions } from "../ticket-template.js";
import type { FeatureAgentRole, FeatureFlowConfig } from "../types.js";

function renderRoleConfig(config: FeatureFlowConfig, role: FeatureAgentRole): string[] {
  const roleConfig = config.agents?.[role] ?? {};
  return [
    ...(roleConfig.model ? [`model: ${roleConfig.model}`] : []),
    ...(roleConfig.thinking ? [`thinking: ${roleConfig.thinking}`] : []),
    ...(roleConfig.skills?.length ? [`skills: ${roleConfig.skills.join(", ")}`] : []),
  ];
}

function baseExecutionFiles(featureDir: string, ticketPath: string): string[] {
  return [
    `- Spec: ${path.join(featureDir, "01-master-spec.md")}`,
    `- Execution plan: ${path.join(featureDir, "02-execution-plan.md")}`,
    `- Ticket: ${ticketPath}`,
  ];
}

// ─── Planning prompt ──────────────────────────────────────────────────────────

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

// ─── Tester prompt ────────────────────────────────────────────────────────────

export function buildTesterPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  testerNotesPath: string,
  config: FeatureFlowConfig,
): string {
  return [
    `Run the bundled \`feature-execution\` skill — **Tester phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
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
    ...renderRoleConfig(config, "tester"),
    "",
    "When you finish, clearly say APPROVED (tests written and red), BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary.",
  ].join("\n");
}

// ─── Worker / Reviewer / Chief prompts ───────────────────────────────────────

export function buildWorkerPrompt(
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
  const lines = [
    `Run the bundled \`feature-execution\` skill — **Worker phase** for feature "${feature}" ticket "${ticketId}".`,
    `Phase: ${phase}`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
  ];

  if (testerNotesPath) lines.push(`- Tester notes: ${testerNotesPath}`);
  if (memoryPath) lines.push(`- Feature memory: ${memoryPath}  (accumulated context from previous tickets)`);
  if (phase === "retry" && workerContextPath) lines.push(`- Worker context: ${workerContextPath}  (⚠️ RETRY — read this first on retry)`);

  lines.push(
    "",
    "## Your role: Worker",
    "- Implement ONLY the assigned ticket. Do not pull future tickets into scope.",
    "- Prefer minimal, testable changes.",
    ...(testerNotesPath
      ? [
          "- The tester has already written failing tests. Read the tester notes before writing any code.",
          "- Implement the smallest slice that makes those tests pass (green phase).",
          "- Clean up and refactor if safe.",
        ]
      : [
          "- Implement the smallest slice that satisfies the ticket goal.",
          "- Run targeted verification where possible.",
        ]),
    "- If you discover follow-up work, record it in the ticket or execution plan rather than silently expanding scope.",
    "- If you cannot complete the ticket due to a real blocker, stop and explain clearly.",
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "worker"),
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary of what was implemented.",
  );

  return lines.join("\n");
}

export function buildReviewerPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  memoryPath: string | undefined,
  reviewerNotesPath: string,
  config: FeatureFlowConfig,
): string {
  const lines = [
    `Run the bundled \`feature-execution\` skill — **Reviewer phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
  ];

  if (memoryPath) lines.push(`- Feature memory: ${memoryPath}`);

  lines.push(
    "",
    "## Your role: Reviewer",
    "- Use the `code-reviewer` skill if available.",
    "- Review the latest implementation against the ticket acceptance criteria.",
    "- Verify tests pass or clearly explain what is still failing.",
    "- Flag correctness, regression, and maintainability issues.",
    "",
    `## Output: write reviewer notes to ${reviewerNotesPath}`,
    "Use this exact format:",
    "```md",
    `# Reviewer Notes — ${ticketId}`,
    "",
    "## Verdict",
    "<APPROVED | NEEDS-FIX | BLOCKED>",
    "",
    "## Findings",
    "- <issue or 'none'>",
    "",
    "## Evidence",
    "- <tests run, files inspected, or why blocked>",
    "```",
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "reviewer"),
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line review summary.",
  );

  return lines.join("\n");
}

export function buildChiefPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  memoryPath: string,
  reviewerNotesPath: string,
  workerContextPath: string,
  config: FeatureFlowConfig,
): string {
  return [
    `Run the bundled \`feature-execution\` skill — **Chief phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
    `- Reviewer notes: ${reviewerNotesPath}`,
    `- Feature memory: ${memoryPath}`,
    "",
    "## Your role: Chief — finalize knowledge handoff",
    `1. Append a dated learnings entry to ${memoryPath}`,
    "   - Technical decisions made in this ticket",
    "   - Patterns discovered (utilities, conventions, traps to avoid)",
    "   - Any context that will help the next ticket start faster",
    "   - If the file does not exist yet, create it with a short header first.",
    `2. Write a worker context file to ${workerContextPath}`,
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
    "   - <what the next attempt must know>",
    "   ```",
    "3. Do NOT modify the ticket registry directly. The extension updates it automatically.",
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "chief"),
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary of what was recorded.",
  ].join("\n");
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
  return path.join(featureDir, "01-master-spec.md");
}

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
  return buildWorkerPrompt(
    feature,
    ticketId,
    featureDir,
    ticketPath,
    memoryPath,
    testerNotesPath,
    workerContextPath,
    config,
    phase,
  );
}

export async function loadConfigForCwd(cwd: string) {
  return loadConfig(cwd);
}
