import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureReviewAction, FeatureReviewRecord, FeatureReviewResult, FeatureReviewStatus, TicketRegistry } from "../types.js";
import { loadRegistry, saveRegistry } from "../registry.js";

const REVIEW_FILE = "05-review-log.md";
const REVIEW_SNAPSHOTS_DIR = ".review-snapshots";
const SNAPSHOT_META_FILE = "meta.json";

type ReviewDocument = {
  label: string;
  path: string;
  content: string;
};

type ReviewSnapshotMeta = {
  revision: number;
  createdAt: string;
  files: string[];
};

export function defaultReviewRecord(): FeatureReviewRecord {
  return {
    status: "pending_review",
    requestedAt: new Date().toISOString(),
    comments: [],
  };
}

export function markReviewPending(specsRoot: string, feature: string, registry: TicketRegistry): TicketRegistry {
  const now = new Date().toISOString();
  const previous = registry.review;
  registry.review = {
    status: "pending_review",
    requestedAt: now,
    reviewedAt: previous?.reviewedAt,
    comments: previous?.comments || [],
    lastAction: previous?.lastAction,
  };
  registry.updatedAt = now;
  return registry;
}

export async function markFeatureReviewed(
  specsRoot: string,
  feature: string,
  action: FeatureReviewAction,
  comment?: string,
): Promise<TicketRegistry> {
  const registry = await loadRegistry(specsRoot, feature);
  const now = new Date().toISOString();

  if (!registry.review) {
    registry.review = defaultReviewRecord();
  }

  registry.review.lastAction = action;
  registry.review.reviewedAt = now;

  if (action === "approve") {
    registry.review.status = "approved";
  } else if (action === "request_changes") {
    registry.review.status = "changes_requested";
    if (comment) {
      registry.review.comments.push(comment);
    }
  }

  registry.updatedAt = now;
  await saveRegistry(specsRoot, feature, registry);

  // Also append to review log
  const featureDir = path.join(specsRoot, feature);
  const logPath = path.join(featureDir, REVIEW_FILE);
  const entry = [
    `- [${now}] ${action}${comment ? `: ${comment}` : ""}`,
  ].join("\n");
  const existing = await fs.readFile(logPath, "utf8").catch(() => "");
  await fs.writeFile(logPath, existing + entry + "\n", "utf8");

  return registry;
}

export function canExecuteFeature(registry: TicketRegistry): boolean {
  if (!registry.review) return false;
  return registry.review.status === "approved";
}

export function getReviewStatusLabel(status: FeatureReviewStatus): string {
  switch (status) {
    case "pending_review":
      return "⏳ awaiting review";
    case "approved":
      return "✅ approved";
    case "changes_requested":
      return "🔁 changes requested";
  }
}

export function formatReviewSummary(registry: TicketRegistry): string {
  if (!registry.review) return "No review record.";

  const lines: string[] = [];
  lines.push(`Review: ${getReviewStatusLabel(registry.review.status)}`);
  lines.push(`Requested: ${registry.review.requestedAt}`);

  if (registry.review.reviewedAt) {
    lines.push(`Reviewed: ${registry.review.reviewedAt}`);
  }

  if (registry.review.lastAction) {
    lines.push(`Last action: ${registry.review.lastAction}`);
  }

  if (registry.review.comments.length > 0) {
    lines.push("");
    lines.push("Feedback:");
    registry.review.comments.forEach((c) => lines.push(`  - ${c}`));
  }

  return lines.join("\n");
}

export async function getFeatureReviewDocuments(
  specsRoot: string,
  feature: string,
  baseDir?: string,
  opts?: { includeTickets?: boolean },
): Promise<ReviewDocument[]> {
  const featureDir = baseDir || path.join(specsRoot, feature);
  const docs: ReviewDocument[] = [];

  const candidates: Array<{ label: string; fileName: string }> = [
    { label: "Master Spec", fileName: "01-master-spec.md" },
    { label: "Execution Plan", fileName: "02-execution-plan.md" },
    { label: "Technical Design", fileName: "04-technical-design.md" },
  ];

  for (const { label, fileName } of candidates) {
    const filePath = path.join(featureDir, fileName);
    try {
      const content = await fs.readFile(filePath, "utf8");
      docs.push({ label, path: filePath, content });
    } catch {
      // skip if not present
    }
  }

  // Only include tickets after user approval — not during spec/plan review.
  if (opts?.includeTickets) {
    const ticketsDir = path.join(featureDir, "tickets");
    try {
      const ticketFiles = (await fs.readdir(ticketsDir))
        .filter((file) => file.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b));

      for (const file of ticketFiles) {
        const filePath = path.join(ticketsDir, file);
        const content = await fs.readFile(filePath, "utf8");
        const id = file.replace(/\.md$/, "");
        docs.push({ label: `Ticket ${id}`, path: filePath, content });
      }
    } catch {
      // ignore missing tickets dir
    }
  }

  return docs;
}

function snapshotsDir(specsRoot: string, feature: string): string {
  return path.join(specsRoot, feature, REVIEW_SNAPSHOTS_DIR);
}

function revisionDir(specsRoot: string, feature: string, revision: number): string {
  return path.join(snapshotsDir(specsRoot, feature), `r${String(revision).padStart(3, "0")}`);
}

async function readSnapshotMeta(dir: string): Promise<ReviewSnapshotMeta | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, SNAPSHOT_META_FILE), "utf8")) as ReviewSnapshotMeta;
  } catch {
    return undefined;
  }
}

async function listSnapshotRevisions(specsRoot: string, feature: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(snapshotsDir(specsRoot, feature), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^r\d+$/.test(entry.name))
      .map((entry) => Number(entry.name.slice(1)))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function docsEqual(left: ReviewDocument[], right: ReviewDocument[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((doc, index) => doc.label === right[index]?.label && doc.content === right[index]?.content);
}

export async function ensureFeatureReviewSnapshot(specsRoot: string, feature: string): Promise<{ currentRevision: number; previousRevision?: number }> {
  const currentDocs = await getFeatureReviewDocuments(specsRoot, feature);
  const revisions = await listSnapshotRevisions(specsRoot, feature);
  const latestRevision = revisions.at(-1);

  if (latestRevision) {
    const previousDocs = await getFeatureReviewDocuments(specsRoot, feature, revisionDir(specsRoot, feature, latestRevision));
    if (docsEqual(currentDocs, previousDocs)) {
      return { currentRevision: latestRevision, previousRevision: revisions.length > 1 ? revisions.at(-2) : undefined };
    }
  }

  const nextRevision = (latestRevision || 0) + 1;
  const targetDir = revisionDir(specsRoot, feature, nextRevision);
  await fs.mkdir(targetDir, { recursive: true });

  for (const doc of currentDocs) {
    const relative = path.relative(path.join(specsRoot, feature), doc.path);
    const targetPath = path.join(targetDir, relative);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, doc.content, "utf8");
  }

  const meta: ReviewSnapshotMeta = {
    revision: nextRevision,
    createdAt: new Date().toISOString(),
    files: currentDocs.map((doc) => path.relative(path.join(specsRoot, feature), doc.path)),
  };
  await fs.writeFile(path.join(targetDir, SNAPSHOT_META_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");

  return { currentRevision: nextRevision, previousRevision: latestRevision };
}

export async function getFeatureReviewBundle(specsRoot: string, feature: string): Promise<{
  currentRevision: number;
  previousRevision?: number;
  currentDocs: Array<ReviewDocument & { previousContent?: string; changed: boolean }>;
}> {
  const { currentRevision, previousRevision } = await ensureFeatureReviewSnapshot(specsRoot, feature);
  const currentDocs = await getFeatureReviewDocuments(specsRoot, feature, revisionDir(specsRoot, feature, currentRevision));
  const previousDocs = previousRevision
    ? await getFeatureReviewDocuments(specsRoot, feature, revisionDir(specsRoot, feature, previousRevision))
    : [];
  const previousMap = new Map(previousDocs.map((doc) => [doc.label, doc]));

  return {
    currentRevision,
    previousRevision,
    currentDocs: currentDocs.map((doc) => {
      const previous = previousMap.get(doc.label);
      return {
        ...doc,
        previousContent: previous?.content,
        changed: (previous?.content || "") !== doc.content,
      };
    }),
  };
}

export async function parseReviewResult(body: string): Promise<FeatureReviewResult> {
  const params = new URLSearchParams(body);
  const action = params.get("action");

  if (action === "approved") {
    return { action: "approved", comment: params.get("comment") || undefined };
  }

  if (action === "changes_requested") {
    const comment = params.get("comment") || "";
    return { action: "changes_requested", comment };
  }

  return { action: "closed" };
}