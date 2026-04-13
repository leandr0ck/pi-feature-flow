import { promises as fs } from "node:fs";
import path from "node:path";
import { featureRoot, ticketsDirPath } from "./registry.js";
import { discoverTickets } from "./tickets.js";
import type { FeatureTicketFlowConfig, FeatureValidationResult, TicketRecord, ValidationIssue } from "./types.js";

export async function validateFeature(specsRoot: string, feature: string, config: FeatureTicketFlowConfig): Promise<FeatureValidationResult> {
  const root = featureRoot(specsRoot, feature);
  const issues: ValidationIssue[] = [];

  for (const requiredFile of config.requiredSpecFiles) {
    const filePath = path.join(root, requiredFile);
    if (!(await pathExists(filePath))) {
      issues.push({
        severity: "error",
        code: "missing-spec-file",
        message: `Missing required spec file: ${requiredFile}`,
        filePath,
      });
    }
  }

  const ticketsDir = ticketsDirPath(specsRoot, feature, config);
  if (!(await pathExists(ticketsDir))) {
    issues.push({
      severity: "error",
      code: "missing-tickets-dir",
      message: `Missing tickets directory: ${ticketsDir}`,
      filePath: ticketsDir,
    });
    return buildResult(feature, root, issues);
  }

  let tickets: TicketRecord[] = [];
  try {
    tickets = await discoverTickets(ticketsDir, config);
  } catch {
    tickets = [];
  }

  if (tickets.length === 0) {
    issues.push({
      severity: "error",
      code: "no-tickets",
      message: `No markdown tickets found in ${ticketsDir}`,
      filePath: ticketsDir,
    });
    return buildResult(feature, root, issues);
  }

  const byId = new Map<string, TicketRecord>();
  const incoming = new Map<string, number>();

  for (const ticket of tickets) {
    incoming.set(ticket.id, 0);
    const normalized = ticket.id.toLowerCase();
    if ([...byId.keys()].some((id) => id.toLowerCase() === normalized)) {
      issues.push({
        severity: "error",
        code: "duplicate-ticket-id",
        message: `Duplicate ticket id detected: ${ticket.id}`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
    }
    byId.set(ticket.id, ticket);

    if (!/^(?:[A-Z]+-\d+|T\d+)$/i.test(ticket.id)) {
      issues.push({
        severity: "warning",
        code: "invalid-ticket-id",
        message: `Ticket id ${ticket.id} does not match the recommended pattern (STK-001 or T1).`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
    }

    const seenDependencies = new Set<string>();
    for (const dependency of ticket.dependencies) {
      const key = dependency.toLowerCase();
      if (seenDependencies.has(key)) {
        issues.push({
          severity: "warning",
          code: "duplicate-dependency",
          message: `Ticket ${ticket.id} repeats dependency ${dependency}.`,
          ticketId: ticket.id,
          filePath: ticket.path,
        });
      }
      seenDependencies.add(key);
    }
  }

  for (const ticket of tickets) {
    for (const dependency of ticket.dependencies) {
      const target = findTicketInsensitive(tickets, dependency);
      if (!target) {
        issues.push({
          severity: "error",
          code: "missing-dependency",
          message: `Ticket ${ticket.id} depends on missing ticket ${dependency}.`,
          ticketId: ticket.id,
          filePath: ticket.path,
        });
        continue;
      }
      incoming.set(target.id, (incoming.get(target.id) || 0) + 1);
    }
  }

  const cycleIssues = detectCycles(tickets);
  issues.push(...cycleIssues);

  if (tickets.length > 1) {
    for (const ticket of tickets) {
      const hasOutgoing = ticket.dependencies.length > 0;
      const hasIncoming = (incoming.get(ticket.id) || 0) > 0;
      if (!hasOutgoing && !hasIncoming) {
        issues.push({
          severity: "warning",
          code: "orphan-ticket",
          message: `Ticket ${ticket.id} is orphaned: no dependencies and nothing depends on it.`,
          ticketId: ticket.id,
          filePath: ticket.path,
        });
      }
    }
  }

  return buildResult(feature, root, dedupeIssues(issues));
}

function detectCycles(tickets: TicketRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (ticket: TicketRecord, trail: string[]) => {
    if (stack.has(ticket.id)) {
      const cycleStart = trail.indexOf(ticket.id);
      const cycle = [...trail.slice(cycleStart), ticket.id];
      issues.push({
        severity: "error",
        code: "dependency-cycle",
        message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
      return;
    }

    if (visited.has(ticket.id)) return;
    visited.add(ticket.id);
    stack.add(ticket.id);

    for (const dependency of ticket.dependencies) {
      const dependencyTicket = findTicketInsensitive(tickets, dependency);
      if (dependencyTicket) visit(dependencyTicket, [...trail, ticket.id]);
    }

    stack.delete(ticket.id);
  };

  for (const ticket of tickets) visit(ticket, []);
  return issues;
}

function dedupeIssues(issues: ValidationIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [issue.severity, issue.code, issue.ticketId || "", issue.filePath || "", issue.message].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildResult(feature: string, featurePath: string, issues: ValidationIssue[]): FeatureValidationResult {
  return {
    feature,
    featurePath,
    issues,
    valid: issues.every((issue) => issue.severity !== "error"),
  };
}

function findTicketInsensitive(tickets: TicketRecord[], ticketId: string) {
  return tickets.find((ticket) => ticket.id.toLowerCase() === ticketId.toLowerCase());
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
