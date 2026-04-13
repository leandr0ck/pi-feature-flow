import type { FeatureReviewRecord, FeatureValidationResult, TicketRecord, TicketRegistry, ValidationIssue } from "./types.js";

export function renderStatus(registry: TicketRegistry): string {
  const byStatus = {
    done: registry.tickets.filter((t) => t.status === "done"),
    inProgress: registry.tickets.filter((t) => t.status === "in_progress"),
    needsFix: registry.tickets.filter((t) => t.status === "needs_fix"),
    pending: registry.tickets.filter((t) => t.status === "pending"),
    blocked: registry.tickets.filter((t) => t.status === "blocked"),
  };

  const reviewLabel = renderReviewBadge(registry.review);

  const counts = [
    `done=${byStatus.done.length}`,
    `in_progress=${byStatus.inProgress.length}`,
    `needs_fix=${byStatus.needsFix.length}`,
    `pending=${byStatus.pending.length}`,
    `blocked=${byStatus.blocked.length}`,
  ].join(" | ");

  return [
    `Feature: ${registry.feature}`,
    reviewLabel ? `Review: ${reviewLabel}` : null,
    `Updated: ${registry.updatedAt}`,
    `Counts: ${counts}`,
    "",
    `In progress:\n${formatTicketLines(byStatus.inProgress)}`,
    "",
    `Needs fix:\n${formatTicketLines(byStatus.needsFix, registry)}`,
    "",
    `Pending:\n${formatTicketLines(byStatus.pending, registry)}`,
    "",
    `Blocked:\n${formatTicketLines(byStatus.blocked)}`,
    "",
    `Done:\n${formatTicketLines(byStatus.done)}`,
  ].filter(Boolean).join("\n");
}

export function renderReviewBadge(review?: FeatureReviewRecord): string {
  if (!review) return "⏳ no review record";
  switch (review.status) {
    case "pending_review":
      return "⏳ pending review";
    case "approved":
      return "✅ approved";
    case "changes_requested":
      return "🔁 changes requested";
  }
}

export function renderValidation(result: FeatureValidationResult): string {
  if (result.issues.length === 0) {
    return [`Feature: ${result.feature}`, `Path: ${result.featurePath}`, "Validation: OK"].join("\n");
  }

  const grouped = {
    error: result.issues.filter((issue: ValidationIssue) => issue.severity === "error"),
    warning: result.issues.filter((issue: ValidationIssue) => issue.severity === "warning"),
  };

  const lines: string[] = [
    `Feature: ${result.feature}`,
    `Path: ${result.featurePath}`,
    `Validation: ${result.valid ? "warnings only" : "failed"}`,
    "",
  ];

  if (grouped.error.length > 0) {
    lines.push("Errors:");
    lines.push(...grouped.error.map((issue: ValidationIssue) => `- ${issue.message}`));
    lines.push("");
  }

  if (grouped.warning.length > 0) {
    lines.push("Warnings:");
    lines.push(...grouped.warning.map((issue: ValidationIssue) => `- ${issue.message}`));
  }

  return lines.join("\n");
}

export function renderFeatureReviewStatus(registry: TicketRegistry): string {
  if (!registry.review) return "No review record. Feature must be reviewed before execution.";

  const parts: string[] = [];
  parts.push(`Review status: ${renderReviewBadge(registry.review)}`);

  if (registry.review.requestedAt) {
    parts.push(`Requested: ${registry.review.requestedAt}`);
  }
  if (registry.review.reviewedAt) {
    parts.push(`Reviewed: ${registry.review.reviewedAt}`);
  }
  if (registry.review.lastAction) {
    parts.push(`Last action: ${registry.review.lastAction}`);
  }
  if (registry.review.comments.length > 0) {
    parts.push("");
    parts.push("Feedback:");
    registry.review.comments.forEach((c) => parts.push(`  - ${c}`));
  }

  return parts.join("\n");
}

function areDependenciesDone(ticket: TicketRecord, registry: TicketRegistry): boolean {
  return ticket.dependencies.every((dep) => {
    const found = registry.tickets.find((t) => t.id.toLowerCase() === dep.toLowerCase());
    return found?.status === "done";
  });
}

function formatTicketLines(tickets: TicketRecord[], registry?: TicketRegistry): string {
  if (tickets.length === 0) return "- none";
  return tickets
    .map((ticket) => {
      let extra = "";

      // Show why a ticket is blocked
      if (registry && (ticket.status === "pending" || ticket.status === "needs_fix")) {
        if (!areDependenciesDone(ticket, registry)) {
          const missing = ticket.dependencies
            .filter((d) => {
              const found = registry.tickets.find((t) => t.id.toLowerCase() === d.toLowerCase());
              return found?.status !== "done";
            })
            .join(", ");
          extra += ` (waiting for ${missing})`;
        }
      }

      // Show blocked reason
      if (ticket.blockedReason) {
        extra += ` — ${ticket.blockedReason}`;
      }

      // Show last run summary
      const lastRun = ticket.runs.at(-1);
      if (lastRun) {
        extra += ` [${lastRun.mode}${lastRun.outcome ? ` -> ${lastRun.outcome}` : ""}]`;
      }

      const profile = ticket.profileName ? ` [profile=${ticket.profileName}]` : "";
      return `- ${ticket.id}: ${ticket.title}${profile}${extra}`;
    })
    .join("\n");
}