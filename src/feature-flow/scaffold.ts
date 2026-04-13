import { promises as fs } from "node:fs";
import path from "node:path";
import { renderExecutionPlanTemplate } from "../execution-plan-template.js";
import { renderTicketTemplate } from "../ticket-template.js";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function deriveFeatureSlug(description: string): string {
  const stopWords = new Set([
    "a", "an", "and", "the", "for", "with", "that", "this", "from", "into", "your", "our", "user", "users",
    "need", "needs", "want", "wants", "build", "create", "implement", "add", "support", "feature", "flow",
    "quiero", "necesito", "crear", "agregar", "implementar", "para", "con", "una", "uno", "que", "los", "las",
  ]);

  const tokens = description
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !stopWords.has(token));

  const core = (tokens.length > 0 ? tokens : description.toLowerCase().split(/\s+/).filter(Boolean))
    .slice(0, 6)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return core || `feature-${new Date().toISOString().slice(0, 10)}`;
}

export async function ensureUniqueFeatureSlug(specsRoot: string, baseSlug: string): Promise<string> {
  let candidate = baseSlug;
  let index = 2;
  while (await pathExists(path.join(specsRoot, candidate))) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }
  return candidate;
}

export async function scaffoldFeature(specsRoot: string, feature: string, includeStarterTicket = true): Promise<string[]> {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });

  const created: string[] = [];
  const requiredFiles = ["01-master-spec.md", "02-execution-plan.md"];

  for (const fileName of requiredFiles) {
    const absolutePath = path.join(featureDir, fileName);
    if (await pathExists(absolutePath)) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, scaffoldFileTemplate(fileName, feature), "utf8");
    created.push(path.relative(specsRoot, absolutePath));
  }

  if (includeStarterTicket) {
    const starterId = "STK-001";
    const starterPath = path.join(ticketsDir, `${starterId}.md`);
    if (!(await pathExists(starterPath))) {
      await fs.writeFile(
        starterPath,
        renderTicketTemplate({
          id: starterId,
          title: "Initial implementation slice",
          goal: `Describe the first thin slice for ${feature}.`,
          profile: "default",
          requires: [],
          implementationNotes: ["Keep the ticket focused on one narrow vertical slice."],
          acceptanceCriteria: ["Define one verifiable outcome for this first ticket."],
        }),
        "utf8",
      );
      created.push(path.relative(specsRoot, starterPath));
    }
  }

  return created;
}

function scaffoldFileTemplate(fileName: string, feature: string): string {
  if (fileName === "01-master-spec.md") {
    return [
      `# ${feature} master spec`,
      "",
      "## Goal",
      "Describe the feature goal.",
      "",
      "## Context",
      "Why this feature exists and what constraints matter.",
      "",
      "## Acceptance Criteria",
      "- Add machine-testable acceptance criteria here.",
    ].join("\n");
  }

  if (fileName === "02-execution-plan.md") {
    return renderExecutionPlanTemplate(feature);
  }

  return `# ${feature}\n\nAdd content for ${fileName}.\n`;
}
