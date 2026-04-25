import path from "node:path";
import { loadConfig, renderAgentRoles } from "../config.js";
import { buildExecutionPlanTemplateInstructions } from "../execution-plan-template.js";
import {
  renderManagerHandoffJsonTemplate,
  renderFeatureMemoryTemplate,
  renderHandoffLogTemplateForPhase,
  renderReviewerHandoffJsonTemplate,
  renderReviewerNotesTemplate,
  renderTesterHandoffJsonTemplate,
  renderTesterNotesTemplate,
  renderWorkerContextTemplate,
  renderWorkerHandoffJsonTemplate,
  toJsonCodeFence,
  toMarkdownCodeFence,
} from "../handoff-templates.js";
import { buildTicketTemplateInstructions } from "../ticket-template.js";
import type { FeatureAgentRole, FeatureFlowConfig } from "../types.js";

function renderRoleConfig(config: FeatureFlowConfig, role: FeatureAgentRole): string[] {
  const roleConfig = config.agents?.[role] ?? {};
  return [
    ...(roleConfig.model ? [`model: ${roleConfig.model}`] : []),
    `thinking: ${roleConfig.thinking ?? "medium"}`,
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
    "Read and write only inside the active feature directory. Do not inspect or modify files outside it.",
    "Do NOT add a product review step or ask the user to approve in a browser.",
    "",
    "## Planner rules",
    "- Read the spec carefully before writing anything.",
    "- Write an execution plan with clear sequencing, approach, and validation strategy.",
    "- Create small, dependency-aware tickets as thin vertical slices.",
    "- Every ticket must include a `- Requires:` line.",
    "- Every ticket must include a `- Files:` line with exact repo-relative files or directories the executor may modify.",
    "- Every ticket `- Files:` line must include at least one writable test file path (for example `tests/foo.test.ts` or `src/foo.test.ts`).",
    "- Use STK-001, STK-002, ... ticket ids.",
    "- Keep all generated files inside the feature directory.",
    "- `- Files:` must be precise. Prefer exact file paths. Use a directory only when a whole feature folder is intentionally in scope.",
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
  handoffLogPath: string,
  testerHandoffPath: string,
  config: FeatureFlowConfig,
): string {
  return [
    `Run the bundled \`feature-execution\` skill — **Tester phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
    "",
    "## Your role: Tester — TEST AUTHORING ONLY",
    "",
    "You have ONE job: read the ticket and write the smallest set of tests that prove the ticket goal.",
    "You must follow the project's existing test guidelines and conventions.",
    "You must NOT implement any feature code. You must NOT run the tests. You must NOT make them pass.",
    "",
    "### MANDATORY STEPS — execute in order, do not skip any:",
    "",
    "1. Read the ticket Acceptance Criteria carefully.",
    "2. Write the minimum tests that verify each AC.",
    "   - Test files must follow the project's existing test conventions and guidelines.",
    "   - Write tests only in paths explicitly listed in the ticket `- Files:` metadata.",
    "   - If the listed test scope is insufficient, respond BLOCKED instead of creating a new test file outside scope.",
    "   - Import paths must be correct even though the implementation may not exist yet.",
    "3. Do NOT run the test suite. Leave execution to the Worker.",
    `4. Write the tester notes file to: ${testerNotesPath}`,
    `5. Create or update the handoff log at: ${handoffLogPath}`,
    `6. Write the structured tester handoff JSON to: ${testerHandoffPath}`,
    "",
    "### Output format for tester notes (exact):",
    ...toMarkdownCodeFence(renderTesterNotesTemplate(ticketId)),
    "",
    "### Output format for handoff log update (exact template — update only the Tester section in this phase):",
    ...toMarkdownCodeFence(renderHandoffLogTemplateForPhase(ticketId, "tester")),
    "",
    "### Structured tester handoff JSON (exact keys, valid JSON):",
    ...toJsonCodeFence(renderTesterHandoffJsonTemplate(ticketId)),
    "",
    "### What APPROVED means here:",
    "- Tests are written",
    "- Project test guidelines are followed",
    "- Tester notes file is written",
    "- Handoff log is updated with the Tester section",
    "- Structured tester handoff JSON is written",
    "",
    "Say BLOCKED if required test infrastructure or conventions are missing. Say NEEDS-FIX if the tests are incomplete or not aligned with project guidelines.",
    "Say APPROVED only when all five conditions above are met.",
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "tester"),
    "",
    "When you finish, clearly say APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line summary.",
  ].join("\n");
}

// ─── Worker / Reviewer / Manager prompts ──────────────────────────────────────

export function buildWorkerPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  memoryPath: string | undefined,
  testerNotesPath: string | undefined,
  workerContextPath: string | undefined,
  handoffLogPath: string,
  workerHandoffPath: string,
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

  if (testerNotesPath) lines.push(`- Tester notes (READ THIS FIRST): ${testerNotesPath}`);
  lines.push(`- Handoff log: ${handoffLogPath}  (append the Worker section with implementation learnings)`);
  if (memoryPath) lines.push(`- Feature memory: ${memoryPath}  (patterns from previous tickets — read to avoid repeating mistakes)`);
  if (phase === "retry" && workerContextPath) lines.push(`- Worker context: ${workerContextPath}  (⚠️ RETRY — read first, understand what failed last time)`);

  lines.push(
    "",
    "## Your role: Worker",
    "",
    "You implement exactly what the ticket specifies. Nothing more, nothing less.",
    "The ticket is your specification. Its Implementation Notes are MANDATORY steps.",
    "Its Acceptance Criteria are REQUIRED outcomes. You are not allowed to reinterpret them.",
    "Governance is strict: you may only modify files explicitly listed in the ticket `- Files:` metadata (plus phase-owned notes files).",
    "Protected paths are always forbidden: generated drizzle SQL/meta files, .env files, deploy/infra configs, CI workflows, lockfiles.",
    "If the allowed files are insufficient, stop and say BLOCKED. Do not improvise.",
    "",
    "### MANDATORY STEPS — execute in order, do not skip any:",
    "",
    ...(testerNotesPath
      ? [
          "1. Read the tester notes. Understand which tests exist and what they cover.",
          "   DO NOT rewrite, delete, or modify the existing tests unless the ticket explicitly requires it.",
          "2. Run the tests first and confirm the current failing state before implementing.",
          "3. Follow the Implementation Notes in the ticket, in order.",
          "   Each note is a required step, not a suggestion.",
          "4. Implement the minimum code that makes the existing tests pass.",
          "   Do not add code that is not required by the tests.",
          "5. Run the tests. Show GREEN output verbatim.",
          "6. Run typecheck. Show clean output or fix every error.",
          `7. Update the Worker section in ${handoffLogPath} with files changed, technical decisions, and risks.`,
          `8. Write the structured worker handoff JSON to ${workerHandoffPath}.`,
          "9. Verify every Acceptance Criterion is met.",
          "10. Say APPROVED only if: tests pass + typecheck clean + all ACs satisfied + handoff log updated + worker handoff JSON written.",
        ]
      : [
          "1. Read the Implementation Notes in the ticket, in order.",
          "   Each note is a required step, not a suggestion.",
          "2. FIRST write failing tests for each Acceptance Criterion.",
          "3. Run the tests. CONFIRM FAILURES (red state). Show failing output.",
          "4. Implement the minimum code that makes those tests pass.",
          "5. Run the tests again. Show GREEN output verbatim.",
          "6. Run typecheck. Fix every error.",
          `7. Create or update ${handoffLogPath} with a Worker section describing the implementation and risks.`,
          `8. Write the structured worker handoff JSON to ${workerHandoffPath}.`,
          "9. Say APPROVED only if: tests pass + typecheck clean + all ACs satisfied + handoff log updated + worker handoff JSON written.",
        ]),
    "",
    "### What is NOT allowed:",
    "- Skipping the red phase (writing code before confirming tests fail)",
    "- Reusing existing infrastructure that contradicts the spec data model",
    "- Making up shortcuts not described in Implementation Notes",
    "- Editing drizzle/*.sql or drizzle/meta manually",
    "- Editing .env files, deploy/infra files, CI workflows, or lockfiles",
    "- Running deploy, publish, git push, raw SQL, reconcile, or direct DB surgery commands",
    "- Marking APPROVED before running tests",
    "",
    "### Structured worker handoff JSON (exact keys, valid JSON):",
    ...toJsonCodeFence(renderWorkerHandoffJsonTemplate(ticketId)),
    "",
    "If you discover follow-up work that is out of scope, record it in the ticket file and continue.",
    "If a real blocker prevents progress, say BLOCKED and explain exactly what is missing.",
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "worker"),
    "",
    "When you finish, say APPROVED, BLOCKED, or NEEDS-FIX.",
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
  handoffLogPath: string,
  reviewerHandoffPath: string,
  config: FeatureFlowConfig,
): string {
  const lines = [
    `Run the bundled \`feature-execution\` skill — **Reviewer phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
  ];

  lines.push(`- Handoff log: ${handoffLogPath}  (append Reviewer findings before finishing)`);
  if (memoryPath) lines.push(`- Feature memory: ${memoryPath}`);

  lines.push(
    "",
    "## Your role: Reviewer",
    "",
    "You validate the implementation against the ticket and perform a corrective code review when needed.",
    "Default mode is validation first. But if you find missing coverage or a small implementation gap, you may edit tests and/or implementation within the ticket-owned file scope.",
    "If you edit behavior, add or adjust tests first whenever needed so the fix follows TDD instead of ad-hoc patching.",
    "Governance is strict: you may only modify ticket-owned implementation files, test files, reviewer notes, and the handoff log. Protected-path changes remain forbidden.",
    "",
    "### MANDATORY STEPS — execute in order:",
    "",
    "1. Run the tests. Show the output.",
    "2. Check every Acceptance Criterion in the ticket: is each one fully satisfied?",
    "3. Check that Implementation Notes were followed — no undocumented shortcuts.",
    "4. Check for scope creep: code that was not required by the ticket.",
    "5. If review passes cleanly, do not edit code. Proceed to documentation.",
    "6. If review does NOT pass cleanly, you may fix it yourself inside the ticket scope.",
    "   - Add or adjust tests first when necessary.",
    "   - Then make the minimum implementation change required.",
    "   - Re-run tests after your edits and show the output.",
    "7. Run typecheck. Clean output required before approval.",
    `8. Write ${reviewerNotesPath} using the exact format below.`,
    `9. Update ${handoffLogPath} with a Reviewer section summarising findings, any edits made, evidence, and residual risks.`,
    `10. Write the structured reviewer handoff JSON to ${reviewerHandoffPath}.`,
    "11. Say APPROVED only if: tests pass + all ACs met + no undocumented scope + typecheck clean + handoff log updated + reviewer handoff JSON written.",
    "    Say NEEDS-FIX otherwise with specific findings.",
    "",
    `## Output: write reviewer notes to ${reviewerNotesPath}`,
    "Use this exact format:",
    ...toMarkdownCodeFence(renderReviewerNotesTemplate(ticketId)),
    "",
    "## Handoff log template (update only the Reviewer section in this phase)",
    ...toMarkdownCodeFence(renderHandoffLogTemplateForPhase(ticketId, "reviewer")),
    "",
    "## Structured reviewer handoff JSON (exact keys, valid JSON)",
    ...toJsonCodeFence(renderReviewerHandoffJsonTemplate(ticketId)),
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "reviewer"),
    "",
    "When you finish, say APPROVED, BLOCKED, or NEEDS-FIX.",
    "Include a one-line review summary.",
  );

  return lines.join("\n");
}

export function buildManagerPrompt(
  feature: string,
  ticketId: string,
  featureDir: string,
  ticketPath: string,
  memoryPath: string,
  reviewerNotesPath: string,
  workerContextPath: string,
  handoffLogPath: string,
  managerHandoffPath: string,
  config: FeatureFlowConfig,
): string {
  return [
    `Run the bundled \`feature-execution\` skill — **Manager phase** for feature "${feature}" ticket "${ticketId}".`,
    "",
    "## Files to read first",
    ...baseExecutionFiles(featureDir, ticketPath),
    `- Reviewer notes: ${reviewerNotesPath}`,
    `- Handoff log: ${handoffLogPath}`,
    `- Feature memory: ${memoryPath}`,
    "",
    "## Your role: Manager — finalize knowledge handoff",
    "Governance is strict: you may only write the feature memory file, the worker context file, and the handoff log for this ticket.",
    `1. Read ${handoffLogPath} completely and use it as the source of truth for cross-role learnings.`,
    `2. Append a dated learnings entry to ${memoryPath}`,
    "   - Technical decisions made in this ticket",
    "   - Patterns discovered (utilities, conventions, traps to avoid)",
    "   - Any context that will help the next ticket start faster",
    "   - If the file does not exist yet, create it using the exact template below.",
    `3. Write a worker context file to ${workerContextPath}`,
    "   Use this exact format:",
    ...toMarkdownCodeFence(renderWorkerContextTemplate(ticketId)).map((line) => `   ${line}`),
    `4. Append a Manager section to ${handoffLogPath} summarising what was promoted to feature memory and what future tickets should reuse.`,
    `5. Write the structured manager handoff JSON to ${managerHandoffPath}.`,
    "6. Do NOT modify the ticket registry directly. The extension updates it automatically.",
    "",
    "## Feature memory template (use this exact template if the file does not exist yet)",
    ...toMarkdownCodeFence(renderFeatureMemoryTemplate(feature)),
    "",
    "## Handoff log template (update only the Manager section in this phase)",
    ...toMarkdownCodeFence(renderHandoffLogTemplateForPhase(ticketId, "manager")),
    "",
    "## Structured manager handoff JSON (exact keys, valid JSON)",
    ...toJsonCodeFence(renderManagerHandoffJsonTemplate(ticketId)),
    "",
    "## Agent configuration",
    ...renderRoleConfig(config, "manager"),
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
      : "- Delegation order: tester → worker → reviewer → manager.",
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
  handoffLogPath: string,
  config: FeatureFlowConfig,
  phase: "start" | "resume" | "retry",
  workerHandoffPath: string,
): string {
  return buildWorkerPrompt(
    feature,
    ticketId,
    featureDir,
    ticketPath,
    memoryPath,
    testerNotesPath,
    workerContextPath,
    handoffLogPath,
    workerHandoffPath,
    config,
    phase,
  );
}

export async function loadConfigForCwd(cwd: string) {
  return loadConfig(cwd);
}
