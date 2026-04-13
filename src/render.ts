import type { TicketRecord, TicketRegistry } from "./types";
import { areDependenciesDone, getTicket } from "./registry";

export function renderStatus(registry: TicketRegistry) {
  const byStatus = {
    done: registry.tickets.filter((ticket) => ticket.status === "done"),
    inProgress: registry.tickets.filter((ticket) => ticket.status === "in_progress"),
    pending: registry.tickets.filter((ticket) => ticket.status === "pending"),
    blocked: registry.tickets.filter((ticket) => ticket.status === "blocked"),
  };

  const counts = [
    `done=${byStatus.done.length}`,
    `in_progress=${byStatus.inProgress.length}`,
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
    `Pending:\n${formatTicketLines(byStatus.pending, registry)}`,
    "",
    `Blocked:\n${formatTicketLines(byStatus.blocked)}`,
    "",
    `Done:\n${formatTicketLines(byStatus.done)}`,
  ].join("\n");
}

function formatTicketLines(tickets: TicketRecord[], registry?: TicketRegistry) {
  if (tickets.length === 0) return "- none";
  return tickets
    .map((ticket) => {
      const blockedBy =
        registry && ticket.status === "pending" && !areDependenciesDone(ticket, registry)
          ? ` (waiting for ${ticket.dependencies.filter((dependency) => getTicket(registry, dependency)?.status !== "done").join(", ")})`
          : "";
      const reason = ticket.blockedReason ? ` — ${ticket.blockedReason}` : "";
      return `- ${ticket.id}: ${ticket.title}${blockedBy}${reason}`;
    })
    .join("\n");
}
