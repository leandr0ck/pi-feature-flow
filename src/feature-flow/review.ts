import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureReviewAction, FeatureReviewRecord, FeatureReviewResult, FeatureReviewStatus, TicketRegistry } from "../types.js";
import { loadRegistry, saveRegistry } from "../registry.js";

const REVIEW_FILE = "05-review-log.md";

export function defaultReviewRecord(): FeatureReviewRecord {
  return {
    status: "pending_review",
    requestedAt: new Date().toISOString(),
    comments: [],
  };
}

export function markReviewPending(specsRoot: string, feature: string, registry: TicketRegistry): TicketRegistry {
  registry.review = defaultReviewRecord();
  registry.updatedAt = new Date().toISOString();
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
): Promise<Array<{ label: string; path: string; content: string }>> {
  const featureDir = path.join(specsRoot, feature);
  const docs: Array<{ label: string; path: string; content: string }> = [];

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

  return docs;
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