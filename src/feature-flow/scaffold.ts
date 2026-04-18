import { promises as fs } from "node:fs";
import path from "node:path";

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
    "a", "an", "and", "the", "for", "with", "that", "this", "from", "into", "your", "our",
    "user", "users", "need", "needs", "want", "wants", "build", "create", "implement", "add",
    "support", "feature", "flow", "quiero", "necesito", "crear", "agregar", "implementar",
    "para", "con", "una", "uno", "que", "los", "las",
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

export async function ensureUniqueFeatureSlug(
  specsRoot: string,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug;
  let index = 2;
  while (await pathExists(path.join(specsRoot, candidate))) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }
  return candidate;
}

/**
 * Ensure the feature directory structure exists.
 * The spec file (01-master-spec.md) is user-provided — this only creates the directory.
 */
export async function ensureFeatureDir(specsRoot: string, feature: string): Promise<string> {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });
  return featureDir;
}

/**
 * Scaffold a stub spec file if one doesn't exist yet.
 * This is a helper for /init-feature — the user should fill it in before planning.
 */
export async function scaffoldSpecFile(featureDir: string, feature: string): Promise<boolean> {
  const specPath = path.join(featureDir, "01-master-spec.md");
  if (await pathExists(specPath)) return false;

  await fs.writeFile(
    specPath,
    [
      `# ${feature}`,
      "",
      "## Goal",
      "Describe the feature goal and the problem it solves.",
      "",
      "## Context",
      "Why this feature exists and what constraints matter.",
      "",
      "## Acceptance Criteria",
      "- Add machine-testable acceptance criteria here.",
      "",
      "> Fill in this spec, then run `/plan-feature ${feature}` to generate tickets.",
    ].join("\n"),
    "utf8",
  );
  return true;
}
