import type { FeatureValidationResult, TicketRecord, TicketRegistry, ValidationIssue } from "./types.js";
import { areDependenciesDone, getTicket } from "./registry.js";

export function renderStatus(registry: TicketRegistry) {
  const byStatus = {
    done: registry.tickets.filter((ticket) => ticket.status === "done"),
    inProgress: registry.tickets.filter((ticket) => ticket.status === "in_progress"),
    needsFix: registry.tickets.filter((ticket) => ticket.status === "needs_fix"),
    pending: registry.tickets.filter((ticket) => ticket.status === "pending"),
    blocked: registry.tickets.filter((ticket) => ticket.status === "blocked"),
  };

  const counts = [
    `done=${byStatus.done.length}`,
    `in_progress=${byStatus.inProgress.length}`,
    `needs_fix=${byStatus.needsFix.length}`,
    `pending=${byStatus.pending.length}`,
    `blocked=${byStatus.blocked.length}`,
  ].join(" | ");

  return [
    `Feature: ${registry.feature}`,
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
  ].join("\n");
}

export function renderValidation(result: FeatureValidationResult) {
  if (result.issues.length === 0) {
    return [`Feature: ${result.feature}`, `Path: ${result.featurePath}`, "Validation: OK"].join("\n");
  }

  const grouped = {
    error: result.issues.filter((issue: ValidationIssue) => issue.severity === "error"),
    warning: result.issues.filter((issue: ValidationIssue) => issue.severity === "warning"),
  };

  const lines = [
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

function formatTicketLines(tickets: TicketRecord[], registry?: TicketRegistry) {
  if (tickets.length === 0) return "- none";
  return tickets
    .map((ticket) => {
      const blockedBy =
        registry && (ticket.status === "pending" || ticket.status === "needs_fix") && !areDependenciesDone(ticket, registry)
          ? ` (waiting for ${ticket.dependencies.filter((dependency: string) => getTicket(registry, dependency)?.status !== "done").join(", ")})`
          : "";
      const reason = ticket.blockedReason ? ` — ${ticket.blockedReason}` : "";
      const lastRun = ticket.runs.at(-1);
      const runSummary = lastRun
        ? ` [last run: ${lastRun.mode}${lastRun.outcome ? ` -> ${lastRun.outcome}` : ""}]`
        : "";
      return `- ${ticket.id}: ${ticket.title}${blockedBy}${reason}${runSummary}`;
    })
    .join("\n");
}
