export const REQUIRED_EXECUTION_PLAN_SECTIONS = [
  "## Approach Summary",
  "## Ticket Sequence",
  "## Dependency Logic",
  "## Validation Strategy",
] as const;

export function renderExecutionPlanTemplate(feature: string): string {
  return [
    `# ${feature} execution plan`,
    "",
    "## Approach Summary",
    "Describe the delivery approach in 2-4 bullets.",
    "",
    "## Ticket Sequence",
    "1. STK-001 — first thin slice",
    "2. STK-002 — next dependent slice",
    "",
    "## Dependency Logic",
    "- Explain why the ticket order is safe and minimal.",
    "",
    "## Validation Strategy",
    "- Define how each slice will be verified.",
    "",
    "## Rollout Notes",
    "- Add rollout, migration, or launch notes when relevant.",
    "",
  ].join("\n");
}

export function buildExecutionPlanTemplateInstructions(): string {
  return [
    "Execution plan format is strict. Do not invent your own structure.",
    "`02-execution-plan.md` must use this exact template shape:",
    "```md",
    "# <feature> execution plan",
    "",
    "## Approach Summary",
    "- <2-4 bullets>",
    "",
    "## Ticket Sequence",
    "1. STK-001 — <slice>",
    "2. STK-002 — <slice>",
    "",
    "## Dependency Logic",
    "- <why order/dependencies are correct>",
    "",
    "## Validation Strategy",
    "- <how the work will be verified>",
    "",
    "## Rollout Notes",
    "- <optional rollout/migration note, or state not applicable>",
    "```",
    "Keep the section names exactly as shown.",
  ].join("\n");
}

export function validateExecutionPlanTemplate(content: string): string[] {
  const issues: string[] = [];

  if (!/^#\s+.+\s+execution plan$/m.test(content)) {
    issues.push("missing or malformed execution plan heading");
  }

  for (const section of REQUIRED_EXECUTION_PLAN_SECTIONS) {
    if (!content.includes(section)) {
      issues.push(`missing required section ${section}`);
    }
  }

  if (!content.includes("## Rollout Notes")) {
    issues.push("missing required section ## Rollout Notes");
  }

  return issues;
}
