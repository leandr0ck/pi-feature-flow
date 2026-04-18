import { promises as fs } from "node:fs";
import path from "node:path";
import type { TicketCostEntry, TicketRecord, TicketRegistry, TicketRunMode, FeatureCost } from "./types.js";
import { DEFAULT_TICKETS_DIR_NAME, DEFAULT_REGISTRY_FILE, DEFAULT_FEATURE_MEMORY_FILE } from "./config.js";

// ─── Path helpers ─────────────────────────────────────────────────────────────

function featureRoot(specsRoot: string, feature: string) {
  return path.join(specsRoot, feature);
}

export function ticketsDirPath(specsRoot: string, feature: string) {
  return path.join(featureRoot(specsRoot, feature), DEFAULT_TICKETS_DIR_NAME);
}

export function registryFilePath(specsRoot: string, feature: string) {
  return path.join(featureRoot(specsRoot, feature), DEFAULT_REGISTRY_FILE);
}

export function featureMemoryPath(specsRoot: string, feature: string) {
  return path.join(featureRoot(specsRoot, feature), DEFAULT_FEATURE_MEMORY_FILE);
}

export function testerNotesPath(specsRoot: string, feature: string, ticketId: string) {
  return path.join(featureRoot(specsRoot, feature), DEFAULT_TICKETS_DIR_NAME, `${ticketId}-tester-notes.md`);
}

export function workerContextPath(specsRoot: string, feature: string, ticketId: string) {
  return path.join(featureRoot(specsRoot, feature), DEFAULT_TICKETS_DIR_NAME, `${ticketId}-worker-context.md`);
}

export function featureCostPath(specsRoot: string, feature: string) {
  return path.join(featureRoot(specsRoot, feature), "05-cost.json");
}

// ─── Feature discovery ─────────────────────────────────────────────────────────

export async function listFeatureSlugs(specsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(specsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// ─── Registry operations ───────────────────────────────────────────────────────

export async function loadRegistry(specsRoot: string, feature: string): Promise<TicketRegistry> {
  const td = ticketsDirPath(specsRoot, feature);
  await fs.mkdir(td, { recursive: true });

  const tickets = await discoverTickets(td);
  if (tickets.length === 0) {
    throw new Error(`No tickets found for ${feature} in ${td}`);
  }

  let existing: TicketRegistry | undefined;
  try {
    existing = JSON.parse(
      await fs.readFile(registryFilePath(specsRoot, feature), "utf8"),
    ) as TicketRegistry;
  } catch {
    existing = undefined;
  }

  const merged = mergeRegistry(feature, tickets, existing);
  await saveRegistry(specsRoot, feature, merged);
  return merged;
}

export async function saveRegistry(specsRoot: string, feature: string, registry: TicketRegistry) {
  const filePath = registryFilePath(specsRoot, feature);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  registry.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

// ─── Feature memory ────────────────────────────────────────────────────────────

export async function readFeatureMemory(specsRoot: string, feature: string): Promise<string | undefined> {
  try {
    return await fs.readFile(featureMemoryPath(specsRoot, feature), "utf8");
  } catch {
    return undefined;
  }
}

// ─── Ticket discovery ──────────────────────────────────────────────────────────

async function discoverTickets(ticketsDir: string): Promise<TicketRecord[]> {
  const files = (await fs.readdir(ticketsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  const tickets = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(ticketsDir, file);
      const content = await fs.readFile(absolutePath, "utf8");
      const id = file.replace(/\.md$/, "");
      return {
        id,
        title: parseTitle(content, id),
        path: absolutePath,
        dependencies: parseDependencies(content),
        status: "pending" as const,
        updatedAt: new Date().toISOString(),
        runs: [],
      } satisfies TicketRecord;
    }),
  );

  return tickets.sort((a: TicketRecord, b: TicketRecord) => a.id.localeCompare(b.id));
}

function parseTitle(content: string, fallbackId: string): string {
  const heading = content.match(/^#\s+[^—-]+[—-]\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();

  const firstHeading = content.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() || fallbackId;
}

// Convention: `- Requires: TKT-001, TKT-002` or `- Requires: none`
const REQUIRES_LABEL = "Requires";
const DEPENDENCY_SPLIT_PATTERN = ",";

function parseDependencies(content: string): string[] {
  const match = content.match(new RegExp(`^-\\s*${REQUIRES_LABEL}:\\s*(.+)$`, "m"));
  const raw = match?.[1] || "";

  const value = raw.trim();
  if (!value || value.toLowerCase() === "none" || value === "-") return [];

  const splitter = DEPENDENCY_SPLIT_PATTERN === "," ? /,/ : new RegExp(DEPENDENCY_SPLIT_PATTERN);
  return value.split(splitter).map((part) => part.trim()).filter(Boolean);
}

// ─── Registry merge ───────────────────────────────────────────────────────────

function mergeRegistry(
  feature: string,
  discoveredTickets: TicketRecord[],
  existing?: TicketRegistry,
): TicketRegistry {
  const existingMap = new Map<string, TicketRecord>(
    (existing?.tickets ?? []).map((ticket: TicketRecord) => [ticket.id, ticket]),
  );
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
        runs: previous?.runs || [],
      } satisfies TicketRecord;
    }),
  };
}

// ─── Ticket lifecycle ─────────────────────────────────────────────────────────

export function startTicketRun(registry: TicketRegistry, ticketId: string, mode: TicketRunMode) {
  const now = new Date().toISOString();

  // Close any open run on tickets being superseded
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

  const openRun = ticket.runs.find((run: TicketRun) => !run.finishedAt);
  if (openRun) {
    closeOpenRun(ticket, now, openRun.outcome, openRun.note || `Superseded by ${mode} run`);
  }

  ticket.runs.push({ startedAt: now, mode });
}

export function resolveTicketStatus(
  registry: TicketRegistry,
  ticketId: string,
  status: "done" | "blocked" | "needs_fix",
  note?: string,
) {
  const now = new Date().toISOString();
  const ticket = getTicket(registry, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  ticket.status = status;
  ticket.updatedAt = now;
  ticket.blockedReason = status === "blocked" ? note || "Blocked" : undefined;
  if (status === "done") ticket.completedAt = now;
  if (status !== "done") ticket.completedAt = undefined;
  closeOpenRun(ticket, now, status, note);
}

function closeOpenRun(ticket: TicketRecord, finishedAt: string, outcome?: string, note?: string) {
  for (let index = ticket.runs.length - 1; index >= 0; index -= 1) {
    const run = ticket.runs[index];
    if (run.finishedAt) continue;
    run.finishedAt = finishedAt;
    if (outcome) run.outcome = outcome as TicketRecord["runs"][number]["outcome"];
    if (note) run.note = note;
    return;
  }
}

// ─── Ticket selection ─────────────────────────────────────────────────────────

export function findNextAvailableTicket(registry: TicketRegistry): TicketRecord | undefined {
  return (
    registry.tickets.find(
      (ticket) => ticket.status === "needs_fix" && areDependenciesDone(ticket, registry),
    ) ||
    registry.tickets.find(
      (ticket) => ticket.status === "pending" && areDependenciesDone(ticket, registry),
    )
  );
}

export function areDependenciesDone(ticket: TicketRecord, registry: TicketRegistry): boolean {
  return ticket.dependencies.every(
    (dependency) => getTicket(registry, dependency)?.status === "done",
  );
}

export function getTicket(registry: TicketRegistry, ticketId: string): TicketRecord | undefined {
  return registry.tickets.find((ticket: TicketRecord) => ticket.id === ticketId);
}

// ─── Cost tracking ──────────────────────────────────────────────────────────

export async function readFeatureCost(specsRoot: string, feature: string): Promise<FeatureCost | null> {
  try {
    const raw = await fs.readFile(featureCostPath(specsRoot, feature), "utf8");
    return JSON.parse(raw) as FeatureCost;
  } catch {
    return null;
  }
}

export async function recordTicketCost(
  specsRoot: string,
  feature: string,
  ticketId: string,
  phase: "tester" | "worker",
  runIndex: number,
  entry: Omit<TicketCostEntry, "ticketId" | "phase" | "runIndex">,
): Promise<void> {
  let cost: FeatureCost = await readFeatureCost(specsRoot, feature) ?? {
    feature,
    totalCostUsd: 0,
    entries: [],
    updatedAt: new Date().toISOString(),
  };

  const newEntry: TicketCostEntry = { ...entry, ticketId, phase, runIndex };
  // Update existing entry if same ticket/phase/runIndex already recorded
  const existingIdx = cost.entries.findIndex(
    (e) => e.ticketId === ticketId && e.phase === phase && e.runIndex === runIndex,
  );
  if (existingIdx >= 0) {
    cost.totalCostUsd -= cost.entries[existingIdx]!.costUsd;
    cost.entries[existingIdx] = newEntry;
  } else {
    cost.entries.push(newEntry);
  }
  cost.totalCostUsd = cost.entries.reduce((sum, e) => sum + e.costUsd, 0);
  cost.updatedAt = new Date().toISOString();

  await fs.writeFile(featureCostPath(specsRoot, feature), JSON.stringify(cost, null, 2) + "\n", "utf8");
}

// ─── Types (local alias to avoid circular import) ─────────────────────────────

type TicketRun = TicketRecord["runs"][number];
