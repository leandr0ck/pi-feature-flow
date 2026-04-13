import path from "node:path";
import {
  loadConfig,
  renderAgentPreferences,
  resolveExecutionProfile,
  resolveExecutionProfileByName,
} from "../config.js";
import type { FeatureExecutionProfile } from "../types.js";

export function buildFeaturePlanningPrompt(
  feature: string,
  specsRoot: string,
  description: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  authoringSkills: {
    productRequirementsSkill: string;
    requirementsRefinementSkill: string;
  },
  tddEnabled: boolean,
): string {
  const featureDir = path.join(specsRoot, feature);
  const availableProfiles = Object.keys(config.profiles || { default: {} });
  return [
    `Run the bundled agent-driven feature intake workflow for feature "${feature}".`,
    `Feature directory: ${featureDir}`,
    "User request:",
    description,
    "",
    "Primary goal:",
    "- Turn the user's description into a complete feature package with a master spec, execution plan, and implementation tickets.",
    "",
    "Required outputs:",
    `- ${path.join(featureDir, "01-master-spec.md")}`,
    `- ${path.join(featureDir, "02-execution-plan.md")}`,
    `- ticket files under ${path.join(featureDir, "tickets")}`,
    "",
    "Workflow guidance:",
    "- Prefer the bundled `feature-planning` and `feature-execution` skills if they are available.",
    `- Authoring skill defaults (override per project via authoringSkills in config):`,
    `  - productRequirementsSkill: "${authoringSkills.productRequirementsSkill}"`,
    `  - requirementsRefinementSkill: "${authoringSkills.requirementsRefinementSkill}"`,
    "",
    `- TDD enabled: ${tddEnabled ? "true" : "false"}`,
    "",
    "Skill routing by feature complexity:",
    "- Simple feature → use productRequirementsSkill.",
    "- Medium feature → use productRequirementsSkill + requirementsRefinementSkill.",
    "- Technically complex feature → first write the PRD/master spec, then STOP and ask the user to add `04-technical-design.md` before refinement and ticket generation.",
    "",
    "Treat `01-master-spec.md` as the principal document: PRD Lite for simple work, PRD-first master spec for medium/complex work.",
    "",
    "Planning rules:",
    "- Classify the request as simple, medium, or technically complex before writing specs.",
    "- Write a concise but actionable master spec.",
    "- Keep the master spec product-readable first.",
    "- If the feature is technically complex enough to need architecture, contracts, migration, concurrency, or rollout design before refinement, do not invent that detail yourself.",
    "- In that case, update `01-master-spec.md` with the product framing, explain exactly why more technical detail is required, ask the user to add `04-technical-design.md`, and end BLOCKED.",
    "- The user may create `04-technical-design.md` however they want: manually, with another skill, or from external/internal documentation.",
    "- Only write `02-execution-plan.md` and generate tickets when the feature is ready for refinement.",
    "- Write an execution plan with clear sequencing and risks when refinement can proceed.",
    ...(tddEnabled
      ? [
          "- Because TDD is enabled, include test expectations in the execution plan and tickets where relevant.",
          "- Prefer tickets that keep the red-green-refactor loop small and local to each slice.",
        ]
      : []),
    "- Create small, dependency-aware tickets as thin vertical slices.",
    "- Every ticket must include a `- Requires:` line.",
    "- Every ticket must include a `- Profile:` line with exactly one execution profile name.",
    `- Allowed ticket profiles: ${availableProfiles.join(", ")}`,
    "- Use STK-001, STK-002, ... ticket ids.",
    "- Keep all generated files inside the feature directory only.",
    "",
    "Do not implement application code yet unless the planning workflow truly requires a tiny probe. Focus on producing the feature package.",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");
}

export function buildPlanningContinuationPrompt(
  feature: string,
  specsRoot: string,
  authoringSkills: {
    productRequirementsSkill: string;
    requirementsRefinementSkill: string;
  },
  tddEnabled: boolean,
): string {
  const featureDir = path.join(specsRoot, feature);
  return [
    `Continue planning for feature "${feature}" now that additional technical detail is available.`,
    `Feature directory: ${featureDir}`,
    "Read these files first:",
    `- ${path.join(featureDir, "01-master-spec.md")}`,
    `- ${path.join(featureDir, "04-technical-design.md")}`,
    `- ${path.join(featureDir, "02-execution-plan.md")}`,
    "",
    "Goal:",
    "- Use the technical design document to complete refinement, write the execution plan, and generate dependency-aware tickets.",
    "",
    "Authoring skill defaults:",
    `- productRequirementsSkill: "${authoringSkills.productRequirementsSkill}"`,
    `- requirementsRefinementSkill: "${authoringSkills.requirementsRefinementSkill}"`,
    `- TDD enabled: ${tddEnabled ? "true" : "false"}`,
    "",
    "Rules:",
    "- Treat `01-master-spec.md` as the principal product-facing document.",
    "- Use `04-technical-design.md` as supporting technical context, not as a replacement for the master spec.",
    "- Update `02-execution-plan.md` with sequencing, risks, and validation strategy.",
    ...(tddEnabled
      ? [
          "- Because TDD is enabled, include test expectations in the execution plan and tickets where relevant.",
          "- Prefer tickets that keep the red-green-refactor loop small and local to each slice.",
        ]
      : []),
    "- Create small, dependency-aware tickets as thin vertical slices.",
    "- Every ticket must include a `- Profile:` line with exactly one execution profile name.",
    "- Every ticket must include a `- Requires:` line.",
    "- Use STK-001, STK-002, ... ticket ids.",
    "- Keep all generated files inside the feature directory only.",
    "",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");
}

export function resolveProfileForFeature(
  config: Awaited<ReturnType<typeof loadConfig>>,
  ticketProfileName?: string,
  featureProfileName?: string,
): ReturnType<typeof resolveExecutionProfile> {
  if (ticketProfileName && config.profiles?.[ticketProfileName]) {
    return resolveExecutionProfileByName(config, ticketProfileName);
  }
  if (featureProfileName && config.profiles?.[featureProfileName]) {
    return resolveExecutionProfileByName(config, featureProfileName);
  }
  return resolveExecutionProfileByName(config, config.defaultProfile || "default");
}

export function buildSubagentGuidance(
  profile: FeatureExecutionProfile,
  phase: "planning" | "execution",
): string[] {
  const preferences = renderAgentPreferences(profile);
  if (profile.preferSubagents === false) {
    return [
      "- This profile disables subagent delegation. Work directly with read/write/edit/bash.",
      ...(preferences.length > 0 ? ["- Preferred agent settings for equivalent direct execution:", ...preferences] : []),
    ];
  }

  return [
    "- If the `subagent` tool is available in Pi, prefer subagent delegation.",
    `- Preferred ${phase} chain order: planner -> worker -> reviewer.`,
    ...(preferences.length > 0 ? ["- Use these configured agent/model preferences when delegating:", ...preferences] : []),
    "- If subagents are unavailable, do the work directly with read/write/edit/bash.",
  ];
}
