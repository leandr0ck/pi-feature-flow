import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig, TicketRecord, TicketRegistry, TicketStatus } from "./types";
import { discoverTickets } from "./tickets";

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
  const existingMap = new Map(existing?.tickets.map((ticket) => [ticket.id, ticket]) || []);
  const now = new Date().toISOString();

  return {
    feature,
    version: 1,
    updatedAt: now,
    tickets: discoveredTickets.map((ticket) => {
      const previous = existingMap.get(ticket.id);
      return {
        ...ticket,
        status: previous?.status || "pending",
        blockedReason: previous?.blockedReason,
        startedAt: previous?.startedAt,
        completedAt: previous?.completedAt,
        updatedAt: previous?.updatedAt || now,
      };
    }),
  };
}

export function markTicket(registry: TicketRegistry, ticketId: string, status: TicketStatus, blockedReason?: string) {
  const now = new Date().toISOString();
  for (const ticket of registry.tickets) {
    if (ticket.status === "in_progress" && ticket.id !== ticketId && status === "in_progress") {
      ticket.status = "pending";
      ticket.updatedAt = now;
    }
  }

  const ticket = getTicket(registry, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  ticket.status = status;
  ticket.updatedAt = now;
  ticket.blockedReason = status === "blocked" ? blockedReason || "Blocked" : undefined;

  if (status === "in_progress" && !ticket.startedAt) ticket.startedAt = now;
  if (status === "done") ticket.completedAt = now;
  if (status !== "done") ticket.completedAt = undefined;
}

export function findNextAvailableTicket(registry: TicketRegistry): TicketRecord | undefined {
  return registry.tickets.find((ticket) => ticket.status === "pending" && areDependenciesDone(ticket, registry));
}

export function areDependenciesDone(ticket: TicketRecord, registry: TicketRegistry): boolean {
  return ticket.dependencies.every((dependency) => getTicket(registry, dependency)?.status === "done");
}

export function getTicket(registry: TicketRegistry, ticketId: string) {
  return registry.tickets.find((ticket) => ticket.id === ticketId);
}
