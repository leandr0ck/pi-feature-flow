import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveSpecsRoot } from "../src/config.js";
import {
  areDependenciesDone,
  findNextAvailableTicket,
  getTicket,
  listFeatureSlugs,
  loadRegistry,
  resolveTicketStatus,
  saveRegistry,
  startTicketRun,
} from "../src/registry.js";
import { renderStatus, renderValidation } from "../src/render.js";
import type { FeatureValidationResult, TicketStatus } from "../src/types.js";
import { validateFeature } from "../src/validation.js";

// ─── State ─────────────────────────────────────────────────────────────────────

let pendingExecution: {
  feature: string;
  ticketId: string;
  phase: "start" | "resume" | "retry";
  cwd: string;
  specsRoot: string;
} | undefined;

// ─── Extension entrypoint ──────────────────────────────────────────────────────

export default function featureTicketFlow(pi: ExtensionAPI) {

  // ── Auto-parse outcome from agent output ──────────────────────────────────

  pi.on("agent_end", async (event, ctx) => {
    const pending = pendingExecution;
    if (!pending) return;
    pendingExecution = undefined;

    const parsed = parseOutcome(event.messages);
    if (!parsed) return;

    try {
      const registry = await loadRegistry(pending.specsRoot, pending.feature);
      const ticket = getTicket(registry, pending.ticketId);
      if (!ticket) return;

      resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
      await saveRegistry(pending.specsRoot, pending.feature, registry);

      const label = parsed.status === "done" ? "APPROVED" : parsed.status === "blocked" ? "BLOCKED" : "NEEDS-FIX";
      emitInfo(pi, `Auto-updated ${pending.ticketId} for ${pending.feature}: ${label}${parsed.note ? `\n${parsed.note}` : ""}`);
      ctx.ui.notify(`Ticket ${pending.ticketId}: ${label}`, parsed.status === "blocked" ? "warning" : "info");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not auto-update ticket: ${message}`, "error");
    }
  });

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand("init-feature", {
    description: "Scaffold a feature folder with spec files and starter ticket",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /init-feature <slug>", "error");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const created = await scaffoldFeature(specsRoot, slug);
      emitInfo(pi, `Initialized ${slug}.\n${created.map((p) => `- ${p}`).join("\n")}`);

      const validation = await validateFeature(specsRoot, slug);
      emitInfo(pi, renderValidation(validation));
    },
  });

  pi.registerCommand("start-feature", {
    description: "Show feature status and start or resume the next ticket",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;
      if (!(await validateBeforeExecution(pi, feature, specsRoot, ctx))) return;

      const registry = await loadRegistry(specsRoot, feature);
      emitInfo(pi, renderStatus(registry));

      const choice = await ctx.ui.select(`Feature ${feature}`, [
        "Start or resume next ticket",
        "Show status only",
        "Cancel",
      ]);
      if (!choice || choice === "Cancel" || choice === "Show status only") return;

      await runNextTicketFlow(pi, feature, ctx);
    },
  });

  pi.registerCommand("next-ticket", {
    description: "Pick and execute the next available ticket automatically",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      await runNextTicketFlow(pi, feature, ctx);
    },
  });

  pi.registerCommand("ticket-done", {
    description: "Mark the current in-progress ticket as done",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((t) => t.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket in progress for ${feature}.`);
        return;
      }

      resolveTicketStatus(registry, current.id, "done");
      await saveRegistry(specsRoot, feature, registry);
      emitInfo(pi, `Marked ${current.id} as done.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} done`, [
        "Start next ticket",
        "Show feature status",
        "Stop here",
      ]);
      if (nextChoice === "Start next ticket") {
        await runNextTicketFlow(pi, feature, ctx);
      } else if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(specsRoot, feature);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-blocked", {
    description: "Mark the current in-progress ticket as blocked",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((t) => t.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket in progress for ${feature}.`);
        return;
      }

      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "dependency, bug, missing info...");
      resolveTicketStatus(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(specsRoot, feature, registry);
      emitInfo(pi, `Marked ${current.id} as blocked.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} blocked`, [
        "Try next available ticket",
        "Show feature status",
        "Stop here",
      ]);
      if (nextChoice === "Try next available ticket") {
        await runNextTicketFlow(pi, feature, ctx);
      } else if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(specsRoot, feature);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-needs-fix", {
    description: "Mark the current in-progress ticket as needs-fix and optionally retry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((t) => t.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket in progress for ${feature}.`);
        return;
      }

      const note = await ctx.ui.input(`What still needs fixing in ${current.id}?`, "tests failing, edge cases...");
      resolveTicketStatus(registry, current.id, "needs_fix", note || "Needs more work");
      await saveRegistry(specsRoot, feature, registry);
      emitInfo(pi, `Marked ${current.id} as needs-fix.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} needs-fix`, [
        "Retry now",
        "Show feature status",
        "Stop here",
      ]);
      if (nextChoice === "Retry now") {
        startTicketRun(registry, current.id, "retry");
        await saveRegistry(specsRoot, feature, registry);
        await launchTicketExecution(pi, feature, current.id, ctx.cwd, specsRoot, "retry");
      } else if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(specsRoot, feature);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-status", {
    description: "Show feature ticket progress from the registry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;
      const registry = await loadRegistry(specsRoot, feature);
      emitInfo(pi, renderStatus(registry));
    },
  });

  pi.registerCommand("ticket-validate", {
    description: "Validate spec files, dependencies, and ticket structure",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;
      const validation = await validateFeature(specsRoot, feature);
      emitInfo(pi, renderValidation(validation));
    },
  });
}

// ─── Execution flow ───────────────────────────────────────────────────────────

async function runNextTicketFlow(pi: ExtensionAPI, feature: string, ctx: { cwd: string; isIdle: () => boolean; ui: { notify: Function; select: Function; input: Function } }) {
  const config = await loadConfig(ctx.cwd);
  const specsRoot = resolveSpecsRoot(ctx.cwd, config);
  if (!(await validateBeforeExecution(pi, feature, specsRoot, ctx))) return;

  const registry = await loadRegistry(specsRoot, feature);
  const current = registry.tickets.find((t) => t.status === "in_progress");

  if (current) {
    const choice = await ctx.ui.select(`Feature ${feature} has a ticket in progress`, [
      `Resume ${current.id}`,
      `Mark ${current.id} done and start next`,
      `Mark ${current.id} needs-fix and retry later`,
      `Mark ${current.id} blocked and start next`,
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return;
    if (choice.startsWith("Resume ")) {
      startTicketRun(registry, current.id, "resume");
      await saveRegistry(specsRoot, feature, registry);
      await launchTicketExecution(pi, feature, current.id, ctx.cwd, specsRoot, "resume");
      return;
    }
    if (choice.includes("done")) {
      resolveTicketStatus(registry, current.id, "done");
      await saveRegistry(specsRoot, feature, registry);
    }
    if (choice.includes("needs-fix")) {
      const note = await ctx.ui.input(`What still needs fixing in ${current.id}?`, "tests failing, edge cases...");
      resolveTicketStatus(registry, current.id, "needs_fix", note || "Needs more work");
      await saveRegistry(specsRoot, feature, registry);
    }
    if (choice.includes("blocked")) {
      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "dependency, bug, missing info...");
      resolveTicketStatus(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(specsRoot, feature, registry);
    }
  }

  // Refresh registry after status changes
  const refreshed = await loadRegistry(specsRoot, feature);
  const next = findNextAvailableTicket(refreshed);
  if (!next) {
    const blockedPending = refreshed.tickets.filter((t) =>
      (t.status === "pending" || t.status === "needs_fix") && !areDependenciesDone(t, refreshed),
    );
    if (blockedPending.length > 0) {
      const lines = blockedPending.slice(0, 10).map((t) => {
        const missing = t.dependencies.filter((d) => getTicket(refreshed, d)?.status !== "done");
        return `- ${t.id} waiting for ${missing.join(", ")}`;
      });
      emitInfo(pi, `No tickets are ready for ${feature}.\n\nBlocked:\n${lines.join("\n")}`);
      return;
    }
    emitInfo(pi, `No pending or retryable tickets remain for ${feature}.`);
    return;
  }

  const mode = next.status === "needs_fix" ? "retry" : "start";
  startTicketRun(refreshed, next.id, mode);
  await saveRegistry(specsRoot, feature, refreshed);
  emitInfo(pi, `Starting ${next.id} — ${next.title}`);
  await launchTicketExecution(pi, feature, next.id, ctx.cwd, specsRoot, mode);
}

async function launchTicketExecution(
  pi: ExtensionAPI,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
) {
  const config = await loadConfig(cwd);
  const resolved = resolveSpecsRoot(cwd, config);

  // Simple convention-based message format
  const message = [
    `Use the project chain "ticket-tdd-execution" now.`,
    `Input: feature=${feature}; ticket=${ticketId}`,
    `Phase: ${phase}`,
    "Execute only that ticket.",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");

  pendingExecution = { feature, ticketId, phase, cwd, specsRoot };
  pi.sendUserMessage(message);
}

// ─── Validation ───────────────────────────────────────────────────────────────

async function validateBeforeExecution(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
  ctx: { ui: { notify: Function } },
): Promise<boolean> {
  const validation = await validateFeature(specsRoot, feature);
  if (validation.valid) return true;

  emitInfo(pi, renderValidation(validation));
  ctx.ui.notify(`Feature ${feature} failed validation. Run /ticket-validate ${feature} for details.`, "warning");
  return false;
}

// ─── Feature slug resolution ──────────────────────────────────────────────────

async function resolveFeatureSlug(
  args: string,
  specsRoot: string,
  title: string,
  ctx: { ui: { notify: Function; select: Function } },
): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;

  const features = await listFeatureSlugs(specsRoot);
  if (features.length === 0) {
    ctx.ui.notify(`No features found under ${specsRoot}.`, "warning");
    return undefined;
  }

  const selected = await ctx.ui.select(title, features);
  return selected || undefined;
}

function createFeatureCompletions(prefix: string) {
  return loadConfig(process.cwd()).then(async (config) => {
    const specsRoot = resolveSpecsRoot(process.cwd(), config);
    const features = await listFeatureSlugs(specsRoot);
    const items = features
      .filter((slug) => slug.startsWith(prefix.trim()))
      .map((slug) => ({ value: slug, label: slug }));
    return items.length > 0 ? items : null;
  });
}

// ─── Outcome parsing ───────────────────────────────────────────────────────────

type ParsedOutcome = {
  status: "done" | "blocked" | "needs_fix";
  note?: string;
};

function parseOutcome(messages: Array<{ role: string; content?: unknown }>): ParsedOutcome | undefined {
  const APPROVED = ["APPROVED"];
  const BLOCKED = ["BLOCKED"];
  const NEEDS_FIX = ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"];

  const assistantTexts = messages
    .filter((m) => m?.role === "assistant")
    .flatMap((m) => {
      const content = m.content as Array<{ type: string; text?: string }> | undefined;
      return (content || []).filter((p) => p.type === "text").map((p) => p.text as string);
    })
    .slice(-6)
    .reverse();

  for (const text of assistantTexts) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    for (const keyword of BLOCKED) {
      const found = lines.find((l) => l === keyword || text.includes(keyword));
      if (found) return { status: "blocked", note: found };
    }
    for (const keyword of NEEDS_FIX) {
      const found = lines.find((l) => l === keyword || text.includes(keyword));
      if (found) return { status: "needs_fix", note: found };
    }
    for (const keyword of APPROVED) {
      const found = lines.find((l) => l === keyword || text.includes(keyword));
      if (found) return { status: "done", note: found };
    }
  }

  return undefined;
}

// ─── Scaffolding ───────────────────────────────────────────────────────────────

async function scaffoldFeature(specsRoot: string, feature: string) {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, "tickets");
  await fs.mkdir(ticketsDir, { recursive: true });

  const created: string[] = [];
  const requiredFiles = ["01-master-spec.md", "02-execution-plan.md"];

  for (const fileName of requiredFiles) {
    const absolutePath = path.join(featureDir, fileName);
    if (await pathExists(absolutePath)) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, scaffoldFileTemplate(fileName, feature), "utf8");
    created.push(path.relative(specsRoot, absolutePath));
  }

  // Create starter ticket
  const starterId = "STK-001";
  const starterPath = path.join(ticketsDir, `${starterId}.md`);
  if (!(await pathExists(starterPath))) {
    await fs.writeFile(
      starterPath,
      `# ${starterId} — Initial implementation slice\n\n## Goal\nDescribe the first thin slice for ${feature}.\n\n- Requires: none\n\n## Acceptance Criteria\n- Define one verifiable outcome for this first ticket.\n`,
      "utf8",
    );
    created.push(path.relative(specsRoot, starterPath));
  }

  return created;
}

function scaffoldFileTemplate(fileName: string, feature: string): string {
  if (fileName === "01-master-spec.md") {
    return [
      `# ${feature} master spec`,
      "",
      "## Goal",
      "Describe the feature goal.",
      "",
      "## Context",
      "Why this feature exists and what constraints matter.",
      "",
      "## Acceptance Criteria",
      "- Add machine-testable acceptance criteria here.",
    ].join("\n");
  }

  if (fileName === "02-execution-plan.md") {
    return [
      `# ${feature} execution plan`,
      "",
      "## Planned Tickets",
      `- ${feature}: break the work into tickets under ./tickets`,
      "",
      "## Notes",
      "- Keep ticket scope small and dependency-aware.",
    ].join("\n");
  }

  return `# ${feature}\n\nAdd content for ${fileName}.\n`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function emitInfo(pi: ExtensionAPI, text: string) {
  pi.sendMessage({ customType: "feature-ticket-flow", content: text, display: true });
}