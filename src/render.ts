import type { FeatureValidationResult, TicketRecord, ValidationIssue } from "./types.js";

function ticketTimestamp(ticket: TicketRecord): number {
  const value = Date.parse(ticket.updatedAt || ticket.completedAt || ticket.startedAt || "");
  return Number.isNaN(value) ? 0 : value;
}

export function renderStatus(registry: import("./types.js").TicketRegistry): string {
  const byStatus = {
    done: registry.tickets.filter((t) => t.status === "done"),
    inProgress: registry.tickets.filter((t) => t.status === "in_progress"),
    needsFix: registry.tickets.filter((t) => t.status === "needs_fix"),
    pending: registry.tickets.filter((t) => t.status === "pending"),
    blocked: registry.tickets.filter((t) => t.status === "blocked"),
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
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderFeatureStatusSummary(registry: import("./types.js").TicketRegistry): string {
  const counts = {
    done: registry.tickets.filter((t) => t.status === "done").length,
    inProgress: registry.tickets.filter((t) => t.status === "in_progress").length,
    needsFix: registry.tickets.filter((t) => t.status === "needs_fix").length,
    pending: registry.tickets.filter((t) => t.status === "pending").length,
    blocked: registry.tickets.filter((t) => t.status === "blocked").length,
  };

  const latest = [...registry.tickets].sort((a, b) => ticketTimestamp(b) - ticketTimestamp(a))[0];
  if (!latest) {
    return [
      `Feature: ${registry.feature}`,
      "No tickets found.",
    ].join("\n");
  }

  const nextActionable =
    registry.tickets.find((t) => t.status === "needs_fix" && areDependenciesDone(t, registry))
    ?? registry.tickets.find((t) => t.status === "pending" && areDependenciesDone(t, registry));

  const lines = [
    `Feature: ${registry.feature}`,
    `Last ticket: ${latest.id} — ${latest.title}`,
    `Status: ${latest.status}`,
    `Updated: ${latest.updatedAt}`,
    `Counts: done=${counts.done} | in_progress=${counts.inProgress} | needs_fix=${counts.needsFix} | pending=${counts.pending} | blocked=${counts.blocked}`,
    `Next actionable: ${nextActionable ? `${nextActionable.id} — ${nextActionable.title} (${nextActionable.status})` : "none"}`,
  ];

  if (latest.blockedReason) lines.push(`Reason: ${latest.blockedReason}`);

  const lastRun = latest.runs.at(-1);
  if (lastRun) {
    lines.push(`Last run: ${lastRun.mode}${lastRun.outcome ? ` -> ${lastRun.outcome}` : ""}`);
  }

  return lines.join("\n");
}

export function renderValidation(result: FeatureValidationResult): string {
  if (result.issues.length === 0) {
    return [`Feature: ${result.feature}`, `Path: ${result.featurePath}`, "Validation: OK"].join(
      "\n",
    );
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

function areDependenciesDone(
  ticket: TicketRecord,
  registry: import("./types.js").TicketRegistry,
): boolean {
  return ticket.dependencies.every((dep) => {
    const found = registry.tickets.find((t) => t.id.toLowerCase() === dep.toLowerCase());
    return found?.status === "done";
  });
}

function formatTicketLines(
  tickets: TicketRecord[],
  registry?: import("./types.js").TicketRegistry,
): string {
  if (tickets.length === 0) return "- none";
  return tickets
    .map((ticket) => {
      let extra = "";

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

      if (ticket.blockedReason) {
        extra += ` — ${ticket.blockedReason}`;
      }

      const lastRun = ticket.runs.at(-1);
      if (lastRun) {
        extra += ` [${lastRun.mode}${lastRun.outcome ? ` -> ${lastRun.outcome}` : ""}]`;
      }

      return `- ${ticket.id}: ${ticket.title}${extra}`;
    })
    .join("\n");
}
