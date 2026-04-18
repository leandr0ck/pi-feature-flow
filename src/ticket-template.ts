export type TicketTemplateInput = {
  id: string;
  title: string;
  goal: string;
  requires: string[];
  implementationNotes?: string[];
  acceptanceCriteria?: string[];
};

export const REQUIRED_TICKET_SECTIONS = ["## Goal", "## Implementation Notes", "## Acceptance Criteria"] as const;

export function renderTicketTemplate(input: TicketTemplateInput): string {
  const implementationNotes =
    input.implementationNotes && input.implementationNotes.length > 0
      ? input.implementationNotes
      : ["Document the smallest end-to-end slice needed for this ticket."];
  const acceptanceCriteria =
    input.acceptanceCriteria && input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria
      : ["One verifiable outcome is defined for this ticket."];

  return [
    `# ${input.id} — ${input.title}`,
    "",
    "## Goal",
    input.goal,
    "",
    `- Requires: ${input.requires.length > 0 ? input.requires.join(", ") : "none"}`,
    "",
    "## Implementation Notes",
    ...implementationNotes.map((note) => `- ${note}`),
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
  ].join("\n");
}

export function buildTicketTemplateInstructions(_availableProfiles?: string[]): string {
  return [
    "Ticket file format is strict. Do not invent your own structure.",
    "Every ticket markdown file must use this exact template shape:",
    "```md",
    "# STK-001 — <short title>",
    "",
    "## Goal",
    "<one short paragraph describing the smallest verifiable outcome>",
    "",
    "- Requires: none | STK-001 | STK-001, STK-002",
    "",
    "## Implementation Notes",
    "- <2-5 concrete implementation notes>",
    "",
    "## Acceptance Criteria",
    "- <testable outcome>",
    "- <testable outcome>",
    "```",
    "Keep the section names and metadata labels exactly as shown.",
  ].join("\n");
}

export function validateTicketTemplate(content: string): string[] {
  const issues: string[] = [];

  if (!/^#\s+[A-Z]+-\d+\s+[—-]\s+.+$/m.test(content)) {
    issues.push("missing or malformed top-level ticket heading");
  }

  for (const section of REQUIRED_TICKET_SECTIONS) {
    if (!content.includes(section)) {
      issues.push(`missing required section ${section}`);
    }
  }

  if (!/^-\s*Requires:\s*.+$/m.test(content)) {
    issues.push("missing required metadata line - Requires:");
  }

  return issues;
}
