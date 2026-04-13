import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  FeatureTicketFlowConfig,
  TicketRecord,
  TicketRegistry,
  TicketRunMode,
  TicketRunOutcome,
  TicketStatus,
} from "./types.js";
import { discoverTickets } from "./tickets.js";

export function featureRoot(specsRoot: string, feature: string) {
  return path.join(specsRoot, feature);
}

export function ticketsDirPath(specsRoot: string, feature: string, config: FeatureTicketFlowConfig) {
  return path.join(featureRoot(specsRoot, feature), config.ticketsDirName);
}

export function registryPath(specsRoot: string, feature: string, config: FeatureTicketFlowConfig) {
  return path.join(featureRoot(specsRoot, feature), config.registryFile);
}

export async function listFeatureSlugs(specsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(specsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function loadRegistry(specsRoot: string, feature: string, config: FeatureTicketFlowConfig): Promise<TicketRegistry> {
  const ticketsDir = ticketsDirPath(specsRoot, feature, config);
  await fs.mkdir(ticketsDir, { recursive: true });

  const discoveredTickets = await discoverTickets(ticketsDir, config);
  if (discoveredTickets.length === 0) {
    throw new Error(`No tickets found for feature ${feature} in ${ticketsDir}`);
  }

  let existing: TicketRegistry | undefined;
  try {
    existing = JSON.parse(await fs.readFile(registryPath(specsRoot, feature, config), "utf8")) as TicketRegistry;
  } catch {
    existing = undefined;
  }

  const merged = mergeRegistry(feature, discoveredTickets, existing);
  await saveRegistry(specsRoot, feature, config, merged);
  return merged;
}

export async function saveRegistry(specsRoot: string, feature: string, config: FeatureTicketFlowConfig, registry: TicketRegistry) {
  const filePath = registryPath(specsRoot, feature, config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

export function mergeRegistry(feature: string, discoveredTickets: TicketRecord[], existing?: TicketRegistry): TicketRegistry {
  const existingEntries: Array<[string, TicketRecord]> = existing?.tickets.map((ticket: TicketRecord) => [ticket.id, ticket]) || [];
  const existingMap = new Map<string, TicketRecord>(existingEntries);
  const now = new Date().toISOString();

  return {
    feature,
    version: 2,
    updatedAt: now,
    tickets: discoveredTickets.map((ticket) => {
      const previous = existingMap.get(ticket.id);
      return {
        ...ticket,
        status: normalizeStatus(previous?.status),
        blockedReason: previous?.blockedReason,
        startedAt: previous?.startedAt,
        completedAt: previous?.completedAt,
        updatedAt: previous?.updatedAt || now,
        runs: previous?.runs || [],
      } satisfies TicketRecord;
    }),
  };
}

export function startTicketRun(registry: TicketRegistry, ticketId: string, mode: TicketRunMode) {
  const now = new Date().toISOString();
  for (const ticket of registry.tickets) {
    if (ticket.status === "in_progress" && ticket.id !== ticketId) {
      ticket.status = "pending";
      ticket.updatedAt = now;
      closeOpenRun(ticket, now, "blocked", "Superseded by another ticket run");
    }
  }

  const ticket = getTicket(registry, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  ticket.status = "in_progress";
  ticket.updatedAt = now;
  ticket.blockedReason = undefined;
  if (!ticket.startedAt) ticket.startedAt = now;
  ticket.completedAt = undefined;

  const openRun = ticket.runs.find((run: TicketRecord["runs"][number]) => !run.finishedAt);
  if (openRun) {
    closeOpenRun(ticket, now, openRun.outcome, openRun.note || `Superseded by ${mode} run`);
  }

  ticket.runs.push({ startedAt: now, mode });
}

export function resolveTicketStatus(registry: TicketRegistry, ticketId: string, status: Exclude<TicketStatus, "pending">, note?: string) {
  const now = new Date().toISOString();
  const ticket = getTicket(registry, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  ticket.status = status;
  ticket.updatedAt = now;
  ticket.blockedReason = status === "blocked" ? note || "Blocked" : undefined;
  if (status === "done") ticket.completedAt = now;
  if (status !== "done") ticket.completedAt = undefined;
  closeOpenRun(ticket, now, toRunOutcome(status), note);
}

export function resetTicketToPending(registry: TicketRegistry, ticketId: string, note?: string) {
  const ticket = getTicket(registry, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  const now = new Date().toISOString();
  ticket.status = "pending";
  ticket.updatedAt = now;
  ticket.blockedReason = undefined;
  ticket.completedAt = undefined;
  closeOpenRun(ticket, now, undefined, note);
}

export function findNextAvailableTicket(registry: TicketRegistry): TicketRecord | undefined {
  return registry.tickets.find((ticket) => ticket.status === "needs_fix" && areDependenciesDone(ticket, registry))
    || registry.tickets.find((ticket) => ticket.status === "pending" && areDependenciesDone(ticket, registry));
}

export function areDependenciesDone(ticket: TicketRecord, registry: TicketRegistry): boolean {
  return ticket.dependencies.every((dependency) => getTicket(registry, dependency)?.status === "done");
}

export function getTicket(registry: TicketRegistry, ticketId: string) {
  return registry.tickets.find((ticket: TicketRecord) => ticket.id === ticketId);
}

function closeOpenRun(ticket: TicketRecord, finishedAt: string, outcome?: TicketRunOutcome, note?: string) {
  for (let index = ticket.runs.length - 1; index >= 0; index -= 1) {
    const openRun = ticket.runs[index];
    if (openRun.finishedAt) continue;
    openRun.finishedAt = finishedAt;
    if (outcome) openRun.outcome = outcome;
    if (note) openRun.note = note;
    return;
  }
}

function normalizeStatus(status: TicketStatus | undefined): TicketStatus {
  if (!status) return "pending";
  if (status === "needs_fix" || status === "pending" || status === "in_progress" || status === "done" || status === "blocked") {
    return status;
  }
  return "pending";
}

function toRunOutcome(status: Exclude<TicketStatus, "pending">): TicketRunOutcome {
  switch (status) {
    case "blocked":
      return "blocked";
    case "needs_fix":
      return "needs_fix";
    case "done":
      return "done";
    case "in_progress":
      return "approved";
  }
}
