import path from "node:path";
import { promises as fsPromises } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveSpecsRoot, resolveTddEnabled } from "../src/config.js";
import {
  areDependenciesDone,
  featureCostPath,
  featureMemoryPath,
  readFeatureCost,
  workerContextPath,
  testerNotesPath,
  findNextAvailableTicket,
  getTicket,
  listFeatureSlugs,
  loadRegistry,
  recordTicketCost,
  resolveTicketStatus,
  saveRegistry,
  startTicketRun,
} from "../src/registry.js";
import { renderStatus, renderValidation } from "../src/render.js";
import { resolveFeatureSlug, validateBeforeExecution } from "../src/feature-flow/guards.js";
import {
  buildFeaturePlanningPrompt,
  buildSubagentGuidance,
  buildTesterPrompt,
  buildTicketExecutionPrompt,
  resolveSpecFileInFeatureDir,
} from "../src/feature-flow/prompts.js";
import {
  deriveFeatureSlug,
  ensureFeatureDir,
  ensureUniqueFeatureSlug,
  pathExists,
  scaffoldSpecFile,
} from "../src/feature-flow/scaffold.js";
import {
  emitInfo,
  extractUsage,
  getPendingExecution,
  loadCheckpoint,
  clearCheckpoint,
  persistCheckpoint,
  outcomeLabel,
  parseOutcome,
  setPendingExecution,
} from "../src/feature-flow/state.js";
import { createFeatureCompletions } from "../src/feature-flow/ui.js";
import { validateFeature } from "../src/validation.js";

type CommandContext = {
  cwd: string;
  isIdle: () => boolean;
  ui: {
    notify: (msg: string, type?: "error" | "warning" | "info") => void;
    select: Function;
    input: Function;
  };
};

export default function featureTicketFlow(pi: ExtensionAPI) {
  // ── Checkpoint recovery on session_start ──────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Only attempt recovery on startup/reload — skip for new/fork sessions
    if (_event.reason !== "startup" && _event.reason !== "reload") return;

    const config = await loadConfig(ctx.cwd);
    const specsRoot = resolveSpecsRoot(ctx.cwd, config);
    const features = await listFeatureSlugs(specsRoot);

    for (const feature of features) {
      const checkpoint = await loadCheckpoint(specsRoot, feature);
      if (!checkpoint) continue;

      // Verify the ticket is still in_progress in the registry before resuming
      if (checkpoint.kind === "ticket-tester" || checkpoint.kind === "ticket-execution") {
        try {
          const registry = await loadRegistry(specsRoot, feature);
          const ticket = getTicket(registry, checkpoint.ticketId);
          if (ticket?.status !== "in_progress") {
            // Registry already resolved — stale checkpoint
            await clearCheckpoint(specsRoot, feature);
            continue;
          }
        } catch {
          await clearCheckpoint(specsRoot, feature);
          continue;
        }
      }

      emitInfo(
        pi,
        [
          `⚠️  Checkpoint found for **${feature}** (${checkpoint.kind}).`,
          `Run \`/start-feature ${feature}\` to resume.`,
        ].join("\n"),
      );
      // Only recover the first one — user can resume manually after that
      return;
    }
  });

  // ── Auto-advance on agent_end ──────────────────────────────────────────────
  pi.on("agent_end", async (event, ctx) => {
    const pending = getPendingExecution();
    if (!pending) return;

    setPendingExecution(undefined);
    if ("specsRoot" in pending && "feature" in pending) {
      await clearCheckpoint(
        (pending as { specsRoot: string }).specsRoot,
        (pending as { feature: string }).feature,
      );
    }
    const parsed = parseOutcome(event.messages);
    if (!parsed) return;

    try {
      if (pending.kind === "feature-plan") {
        const label = outcomeLabel(parsed.status);
        emitInfo(
          pi,
          `Feature planning for **${pending.feature}**: ${label}${parsed.note ? `\n${parsed.note}` : ""}`,
        );

        if (parsed.status !== "done") {
          ctx.ui.notify(
            `Feature planning for ${pending.feature}: ${label}`,
            parsed.status === "blocked" ? "warning" : "info",
          );
          return;
        }

        // Validate that the planner produced the expected files
        const validation = await validateFeature(pending.specsRoot, pending.feature);
        emitInfo(pi, renderValidation(validation));

        if (!validation.valid) {
          ctx.ui.notify(
            `Feature ${pending.feature} was planned but failed validation. Check the files.`,
            "warning",
          );
          return;
        }

        // Load registry and kick off first ticket automatically
        const registry = await loadRegistry(pending.specsRoot, pending.feature);
        emitInfo(
          pi,
          [
            `Feature **${pending.feature}** plan ready.`,
            "",
            `Tickets registered: ${registry.tickets.length}`,
            "",
            "Starting implementation automatically ticket by ticket.",
            "",
            renderStatus(registry),
          ].join("\n"),
        );
        ctx.ui.notify(
          `Feature ${pending.feature} planned. ${registry.tickets.length} tickets. Starting implementation...`,
          "info",
        );
        await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot);
        return;
      }

      // ticket-tester outcome: tester finished — decide whether to hand off to the worker
      if (pending.kind === "ticket-tester") {
        const label = outcomeLabel(parsed.status);
        const usage = extractUsage(event.messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
        const now = new Date().toISOString();

        // Record tester cost
        await recordTicketCost(pending.specsRoot, pending.feature, pending.ticketId, "tester", 0, {
          ...usage,
          recordedAt: now,
        });

        emitInfo(
          pi,
          `Tester phase for **${pending.ticketId}** (${pending.feature}): ${label}${parsed.note ? `\n${parsed.note}` : ""}${usage.costUsd > 0 ? ` — $${usage.costUsd.toFixed(4)}` : ""}`,
        );

        if (parsed.status !== "done") {
          // Tester blocked or needs-fix — surface to user, do not advance to worker
          const registry = await loadRegistry(pending.specsRoot, pending.feature);
          resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
          await saveRegistry(pending.specsRoot, pending.feature, registry);
          ctx.ui.notify(
            `Tester for ${pending.ticketId}: ${label}. Fix the tester phase before proceeding.`,
            parsed.status === "blocked" ? "warning" : "info",
          );
          return;
        }

        // Tester approved — hand off to worker chain
        ctx.ui.notify(`Tester done for ${pending.ticketId}. Starting worker...`, "info");
        await launchWorkerChain(pi, pending.feature, pending.ticketId, pending.cwd, pending.specsRoot, "start");
        return;
      }

      // ticket-execution outcome (worker → reviewer → chief)
      const registry = await loadRegistry(pending.specsRoot, pending.feature);
      const ticket = getTicket(registry, pending.ticketId);
      if (!ticket) return;

      // Record cost and usage for this run
      const usage = extractUsage(event.messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
      const runIndex = ticket.runs.length;
      const now = new Date().toISOString();

      resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
      // Attach usage to the current run (last one, just added by resolveTicketStatus)
      if (ticket.runs.length > 0) {
        const lastRun = ticket.runs[ticket.runs.length - 1]!;
        lastRun.usage = usage;
      }
      await saveRegistry(pending.specsRoot, pending.feature, registry);

      // Record feature-level cost
      await recordTicketCost(pending.specsRoot, pending.feature, pending.ticketId, "worker", runIndex, {
        ...usage,
        recordedAt: now,
      });

      const label = outcomeLabel(parsed.status);
      const costStr = usage.costUsd > 0 ? ` — $${usage.costUsd.toFixed(4)}` : "";
      emitInfo(
        pi,
        `Auto-updated ${pending.ticketId} for ${pending.feature}: ${label}${parsed.note ? `\n${parsed.note}` : ""}${costStr}`,
      );
      ctx.ui.notify(
        `Ticket ${pending.ticketId}: ${label}`,
        parsed.status === "blocked" ? "warning" : "info",
      );

      if (parsed.status === "done") {
        await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not auto-update ticket: ${message}`, "error");
    }
  });

  // ── /plan-feature ──────────────────────────────────────────────────────────
  pi.registerCommand("plan-feature", {
    description: "Plan a feature from an existing spec document (creates execution plan + tickets)",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const trimmed = args.trim();
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);

      // If no slug given, pick from list
      const feature = await resolveFeatureSlug(trimmed, specsRoot, "Choose feature to plan", ctx);
      if (!feature) return;

      const featureDir = path.join(specsRoot, feature);

      // Determine spec file
      const defaultSpecPath = resolveSpecFileInFeatureDir(featureDir);
      let specPath = defaultSpecPath;

      if (!(await pathExists(specPath))) {
        ctx.ui.notify(
          `Spec file not found: ${specPath}. Create 01-master-spec.md in the feature directory first.`,
          "error",
        );
        emitInfo(
          pi,
          [
            `Feature **${feature}**: spec file not found.`,
            "",
            `Expected: ${specPath}`,
            "",
            "Create your spec document at that path, then run `/plan-feature ${feature}` again.",
            "Or run `/init-feature ${feature}` to scaffold a stub spec.",
          ].join("\n"),
        );
        return;
      }

      const tddEnabled = resolveTddEnabled(config);
      await ensureFeatureDir(specsRoot, feature);

      emitInfo(
        pi,
        [
          `Planning **${feature}** from spec: ${specPath}`,
          tddEnabled ? "TDD mode: enabled" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      ctx.ui.notify(`Planning ${feature} from spec. Creating execution plan and tickets...`, "info");

      const planPending = { kind: "feature-plan" as const, feature, cwd: ctx.cwd, specsRoot };
      setPendingExecution(planPending);
      await persistCheckpoint(planPending);
      pi.sendUserMessage(
        buildFeaturePlanningPrompt(feature, specsRoot, specPath, config, tddEnabled),
      );
    },
  });

  // ── /init-feature ──────────────────────────────────────────────────────────
  pi.registerCommand("init-feature", {
    description: "Create a feature directory with a stub spec file",
    handler: async (args, ctx: CommandContext) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /init-feature <slug>", "error");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const featureDir = await ensureFeatureDir(specsRoot, slug);
      const created = await scaffoldSpecFile(featureDir, slug);

      if (created) {
        emitInfo(
          pi,
          [
            `Initialized **${slug}**.`,
            `- Created: ${path.join(featureDir, "01-master-spec.md")}`,
            "",
            "Fill in the spec, then run `/plan-feature ${slug}` to generate tickets.",
          ].join("\n"),
        );
      } else {
        emitInfo(pi, `Feature directory for **${slug}** already exists. Spec file unchanged.`);
      }

      ctx.ui.notify(`Feature ${slug} initialized.`, "info");
    },
  });

  // ── /start-feature ─────────────────────────────────────────────────────────
  pi.registerCommand("start-feature", {
    description: "Show feature status and start or resume the next ticket",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
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

  // ── /next-ticket ───────────────────────────────────────────────────────────
  pi.registerCommand("next-ticket", {
    description: "Pick and execute the next available ticket automatically",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      try {
        await runNextTicketFlow(pi, feature, ctx);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`next-ticket error: ${message}`, "error");
        emitInfo(pi, `Error in /next-ticket: ${message}`);
      }
    },
  });

  // ── /ticket-done ───────────────────────────────────────────────────────────
  pi.registerCommand("ticket-done", {
    description: "Mark the current in-progress ticket as done",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
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

  // ── /ticket-blocked ────────────────────────────────────────────────────────
  pi.registerCommand("ticket-blocked", {
    description: "Mark the current in-progress ticket as blocked",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket in progress for ${feature}.`);
        return;
      }

      const reason = await ctx.ui.input(
        `Why is ${current.id} blocked?`,
        "dependency, bug, missing info...",
      );
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

  // ── /ticket-needs-fix ──────────────────────────────────────────────────────
  pi.registerCommand("ticket-needs-fix", {
    description: "Mark the current in-progress ticket as needs-fix and optionally retry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket in progress for ${feature}.`);
        return;
      }

      const note = await ctx.ui.input(
        `What still needs fixing in ${current.id}?`,
        "tests failing, edge cases...",
      );
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
        await launchTicketExecution(
          pi,
          feature,
          current.id,
          ctx.cwd,
          specsRoot,
          "retry",
        );
      } else if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(specsRoot, feature);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  // ── /ticket-status ─────────────────────────────────────────────────────────
  pi.registerCommand("ticket-status", {
    description: "Show feature ticket progress from the registry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      emitInfo(pi, renderStatus(registry));
    },
  });

  // ── /feature-cost ──────────────────────────────────────────────────────────
  pi.registerCommand("feature-cost", {
    description: "Show feature cost breakdown by ticket and phase",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const cost = await readFeatureCost(specsRoot, feature);
      if (!cost || cost.entries.length === 0) {
        emitInfo(pi, `No cost data for **${feature}** yet. Costs are recorded when tickets finish executing.`);
        return;
      }

      const perTicket = new Map<string, { total: number; runs: number }>();
      for (const e of cost.entries) {
        const key = e.ticketId;
        const existing = perTicket.get(key) ?? { total: 0, runs: 0 };
        existing.total += e.costUsd;
        existing.runs += 1;
        perTicket.set(key, existing);
      }

      const lines = [
        `**Cost for ${feature}**: $${cost.totalCostUsd.toFixed(4)}`,
        "",
        "| Ticket | Runs | Cost |",
        "|--------|------|------|",
        ...Array.from(perTicket.entries())
          .sort((a, b) => b[1].total - a[1].total)
          .map(([id, data]) => `| ${id} | ${data.runs} | $${data.total.toFixed(4)} |`),
        "",
        `Total tokens: ${(cost.entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0)).toLocaleString()}`,
      ];

      emitInfo(pi, lines.join("\n"));
    },
  });

  // ── /ticket-validate ───────────────────────────────────────────────────────
  pi.registerCommand("ticket-validate", {
    description: "Validate spec files, dependencies, and ticket structure",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const validation = await validateFeature(specsRoot, feature);
      emitInfo(pi, renderValidation(validation));
    },
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function runNextTicketFlow(pi: ExtensionAPI, feature: string, ctx: CommandContext) {
  const config = await loadConfig(ctx.cwd);
  const specsRoot = resolveSpecsRoot(ctx.cwd, config);
  if (!(await validateBeforeExecution(pi, feature, specsRoot, ctx))) return;

  const registry = await loadRegistry(specsRoot, feature);
  const current = registry.tickets.find((ticket) => ticket.status === "in_progress");

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
      const note = await ctx.ui.input(`What still needs fixing in ${current.id}?`, "");
      resolveTicketStatus(registry, current.id, "needs_fix", note || "Needs more work");
      await saveRegistry(specsRoot, feature, registry);
    }
    if (choice.includes("blocked")) {
      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "");
      resolveTicketStatus(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(specsRoot, feature, registry);
    }
  }

  await startPreparedNextTicket(pi, feature, ctx.cwd, specsRoot);
}

async function startPreparedNextTicket(
  pi: ExtensionAPI,
  feature: string,
  cwd: string,
  specsRoot: string,
) {
  const refreshed = await loadRegistry(specsRoot, feature);
  const next = findNextAvailableTicket(refreshed);

  if (!next) {
    const blockedPending = refreshed.tickets.filter(
      (ticket) =>
        (ticket.status === "pending" || ticket.status === "needs_fix") &&
        !areDependenciesDone(ticket, refreshed),
    );
    if (blockedPending.length > 0) {
      const lines = blockedPending.slice(0, 10).map((ticket) => {
        const missing = ticket.dependencies.filter(
          (dep) => getTicket(refreshed, dep)?.status !== "done",
        );
        return `- ${ticket.id} waiting for ${missing.join(", ")}`;
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
  await launchTicketExecution(pi, feature, next.id, cwd, specsRoot, mode);
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
  const tddEnabled = resolveTddEnabled(config);

  if (tddEnabled) {
    await launchTesterPhase(pi, feature, ticketId, cwd, specsRoot, config);
  } else {
    await launchWorkerChain(pi, feature, ticketId, cwd, specsRoot, phase, config);
  }
}

/** Phase 1 (TDD only): run the tester agent to write failing tests. */
async function launchTesterPhase(
  pi: ExtensionAPI,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const notesPath = testerNotesPath(specsRoot, feature, ticketId);

  const message = [
    buildTesterPrompt(feature, ticketId, featureDir, ticketPath, notesPath, resolvedConfig),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const testerPending = { kind: "ticket-tester" as const, feature, ticketId, cwd, specsRoot };
  setPendingExecution(testerPending);
  await persistCheckpoint(testerPending);
  pi.sendUserMessage(message);
}

/** Phase 2: run worker → reviewer → chief. Reads tester notes when they exist. */
async function launchWorkerChain(
  pi: ExtensionAPI,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);

  const memPath = featureMemoryPath(specsRoot, feature);
  const memExists = await fsPromises.access(memPath).then(() => true).catch(() => false);

  const notesPath = testerNotesPath(specsRoot, feature, ticketId);
  const notesExist = await fsPromises.access(notesPath).then(() => true).catch(() => false);

  const ctxPath = workerContextPath(specsRoot, feature, ticketId);
  const ctxExists = await fsPromises.access(ctxPath).then(() => true).catch(() => false);

  const message = [
    buildTicketExecutionPrompt(
      feature,
      ticketId,
      featureDir,
      ticketPath,
      memExists ? memPath : undefined,
      notesExist ? notesPath : undefined,
      ctxExists && phase === "retry" ? ctxPath : undefined,
      resolvedConfig,
      phase,
    ),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const execPending = { kind: "ticket-execution" as const, feature, ticketId, phase, cwd, specsRoot };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  pi.sendUserMessage(message);
}
