import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureValidationResult, TicketRecord, ValidationIssue } from "./types.js";
import { validateExecutionPlanTemplate } from "./execution-plan-template.js";
import { getTicket, isPrimaryTicketMarkdown } from "./registry.js";
import { validateTicketTemplate } from "./ticket-template.js";

// Convention-based constants (not configurable)
// 01-master-spec.md is user-provided (warning if missing); 02-execution-plan.md is required for execution.
const SPEC_FILE = "01-master-spec.md" as const;
const REQUIRED_SPEC_FILES = ["02-execution-plan.md"] as const;
const TICKETS_DIR_NAME = "tickets";

export async function validateFeature(specsRoot: string, feature: string): Promise<FeatureValidationResult> {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, TICKETS_DIR_NAME);
  const issues: ValidationIssue[] = [];

  // Check spec file (user-provided: warn only if missing)
  const specFilePath = path.join(featureDir, SPEC_FILE);
  if (!(await pathExists(specFilePath))) {
    issues.push({
      severity: "warning",
      code: "missing-spec-file",
      message: `Spec file ${SPEC_FILE} not found. Create it before planning.`,
      filePath: specFilePath,
    });
  }

  // Check required generated files
  for (const fileName of REQUIRED_SPEC_FILES) {
    const filePath = path.join(featureDir, fileName);
    if (!(await pathExists(filePath))) {
      issues.push({
        severity: "error",
        code: "missing-spec-file",
        message: `Missing required file: ${fileName} — run /plan-feature to generate it.`,
        filePath,
      });
    }
  }

  const executionPlanPath = path.join(featureDir, "02-execution-plan.md");
  if (await pathExists(executionPlanPath)) {
    const planContent = await fs.readFile(executionPlanPath, "utf8");
    const planTemplateIssues = validateExecutionPlanTemplate(planContent);
    if (planTemplateIssues.length > 0) {
      issues.push({
        severity: "error",
        code: "execution-plan-template-mismatch",
        message: `Execution plan does not follow the required template: ${planTemplateIssues.join("; ")}.`,
        filePath: executionPlanPath,
      });
    }
  }

  // Check tickets directory
  if (!(await pathExists(ticketsDir))) {
    issues.push({
      severity: "error",
      code: "missing-tickets-dir",
      message: `Missing tickets directory: ${ticketsDir}`,
      filePath: ticketsDir,
    });
    return buildResult(feature, featureDir, issues);
  }

  // Discover ticket files
  const ticketFiles = (await fs.readdir(ticketsDir)).filter(isPrimaryTicketMarkdown).sort();
  if (ticketFiles.length === 0) {
    issues.push({
      severity: "error",
      code: "no-tickets",
      message: `No markdown tickets found in ${ticketsDir}`,
      filePath: ticketsDir,
    });
    return buildResult(feature, featureDir, issues);
  }

  // Parse tickets inline (avoid circular import)
  const tickets: TicketRecord[] = await Promise.all(
    ticketFiles.map(async (file) => {
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

  // Check for duplicate ids (case-insensitive)
  const seenIds = new Set<string>();
  for (const ticket of tickets) {
    const normalized = ticket.id.toLowerCase();
    if (seenIds.has(normalized)) {
      issues.push({
        severity: "error",
        code: "duplicate-ticket-id",
        message: `Duplicate ticket id: ${ticket.id}`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
    }
    seenIds.add(normalized);

    const content = await fs.readFile(ticket.path, "utf8");
    const templateIssues = validateTicketTemplate(content);
    if (templateIssues.length > 0) {
      issues.push({
        severity: "error",
        code: "ticket-template-mismatch",
        message: `Ticket ${ticket.id} does not follow the required template: ${templateIssues.join("; ")}.`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
    }

    // Warn about non-standard id format
    if (!/^(?:[A-Z]+-\d+|T\d+)$/i.test(ticket.id)) {
      issues.push({
        severity: "warning",
        code: "invalid-ticket-id",
        message: `Ticket id ${ticket.id} does not match recommended pattern (STK-001 or T1).`,
        ticketId: ticket.id,
        filePath: ticket.path,
      });
    }

    // Check for duplicate dependencies within a ticket
    const seenDeps = new Set<string>();
    for (const dep of ticket.dependencies) {
      const key = dep.toLowerCase();
      if (seenDeps.has(key)) {
        issues.push({
          severity: "warning",
          code: "duplicate-dependency",
          message: `Ticket ${ticket.id} repeats dependency ${dep}.`,
          ticketId: ticket.id,
          filePath: ticket.path,
        });
      }
      seenDeps.add(key);
    }
  }

  // Check for missing dependencies
  const allIds = new Set(tickets.map((t) => t.id.toLowerCase()));
  for (const ticket of tickets) {
    for (const dep of ticket.dependencies) {
      if (!allIds.has(dep.toLowerCase())) {
        issues.push({
          severity: "error",
          code: "missing-dependency",
          message: `Ticket ${ticket.id} depends on missing ticket ${dep}.`,
          ticketId: ticket.id,
          filePath: ticket.path,
        });
      }
    }
  }

  // Check for cycles
  const cycleIssues = detectCycles(tickets);
  issues.push(...cycleIssues);

  // Check for orphan tickets (when there are multiple tickets)
  if (tickets.length > 1) {
    const incoming = new Map<string, number>();
    for (const ticket of tickets) {
      incoming.set(ticket.id.toLowerCase(), 0);
    }
    for (const ticket of tickets) {
      for (const dep of ticket.dependencies) {
        const key = dep.toLowerCase();
        incoming.set(key, (incoming.get(key) || 0) + 1);
      }
    }
    for (const ticket of tickets) {
      const hasOutgoing = ticket.dependencies.length > 0;
      const hasIncoming = (incoming.get(ticket.id.toLowerCase()) || 0) > 0;
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

  return buildResult(feature, featureDir, dedupeIssues(issues));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTitle(content: string, fallbackId: string): string {
  const heading = content.match(/^#\s+[^—-]+[—-]\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const firstHeading = content.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() || fallbackId;
}

// Convention: `- Requires: TKT-001, TKT-002` or `- Requires: none`
function parseDependencies(content: string): string[] {
  const REQUIRES_LABEL = "Requires";
  const DEPENDENCY_SPLIT_PATTERN = ",";

  const match = content.match(new RegExp(`^-\\s*${REQUIRES_LABEL}:\\s*(.+)$`, "m"));
  const raw = match?.[1] || "";
  const value = raw.trim();
  if (!value || value.toLowerCase() === "none" || value === "-") return [];

  const splitter = DEPENDENCY_SPLIT_PATTERN === "," ? /,/ : new RegExp(DEPENDENCY_SPLIT_PATTERN);
  return value.split(splitter).map((part) => part.trim()).filter(Boolean);
}

function detectCycles(tickets: TicketRecord[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const ticketById = new Map(tickets.map((t) => [t.id.toLowerCase(), t]));

  const visit = (ticket: TicketRecord, trail: string[]) => {
    const key = ticket.id.toLowerCase();
    if (stack.has(key)) {
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
    if (visited.has(key)) return;
    visited.add(key);
    stack.add(key);

    for (const dep of ticket.dependencies) {
      const depTicket = ticketById.get(dep.toLowerCase());
      if (depTicket) visit(depTicket, [...trail, ticket.id]);
    }

    stack.delete(key);
  };

  for (const ticket of tickets) visit(ticket, []);
  return issues;
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = [
      issue.severity,
      issue.code,
      issue.ticketId || "",
      issue.filePath || "",
      issue.message,
    ].join("::");
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}