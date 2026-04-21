import path from "node:path";
import { promises as fsPromises } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  loadConfig,
  resolveSpecsRoot,
  resolveTddEnabled,
  shouldAutoAdvanceToNextTicket,
  shouldAutoStartFirstTicketAfterPlanning,
} from "../src/config.js";
import {
  areDependenciesDone,
  featureCostPath,
  featureMemoryPath,
  handoffLogPath,
  readFeatureCost,
  reviewerNotesPath,
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
  buildChiefPrompt,
  buildFeaturePlanningPrompt,
  buildReviewerPrompt,
  buildSubagentGuidance,
  buildTesterPrompt,
  buildWorkerPrompt,
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

type CommandContext = ExtensionCommandContext & {
  ui: {
    notify: (msg: string, type?: "error" | "warning" | "info") => void;
    select: Function;
    input: Function;
  };
};

export default function featureTicketFlow(pi: ExtensionAPI) {
  // ── Inject ticket as mandatory system prompt context ─────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const pending = getPendingExecution();
    if (!pending || pending.kind === "feature-plan") return;

    const feature = (pending as any).feature as string;
    const ticketId = (pending as any).ticketId as string;
    const specsRoot = (pending as any).specsRoot as string;
    const featureDir = path.join(specsRoot, feature);
    const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);

    let ticketContent: string;
    try {
      ticketContent = await fsPromises.readFile(ticketPath, "utf8");
    } catch {
      return;
    }

    const phase =
      pending.kind === "ticket-tester"
        ? "TESTER"
        : pending.kind === "ticket-execution"
          ? (pending as any).executionRole.toUpperCase()
          : "UNKNOWN";

    const lines: string[] = [
      "",
      "================================================================",
      `ACTIVE TICKET: ${ticketId} | PHASE: ${phase} | FEATURE: ${feature}`,
      "================================================================",
      "",
      "The following ticket is your MANDATORY specification for this turn.",
      "Every implementation note and acceptance criterion is REQUIRED.",
      "Do NOT skip steps. Do NOT reinterpret. Do NOT add scope.",
      "",
      ticketContent,
      "",
    ];

    lines.push(
      "--- STRICT GOVERNANCE (HARD RULES) ---",
      "The extension enforces these rules at tool-call time.",
      "- You may only modify files explicitly allowed for the active phase and ticket.",
      "- Never edit generated Drizzle SQL or drizzle/meta files manually.",
      "- Never edit .env files, deployment/infra configs, CI workflow files, or lockfiles.",
      "- Never run deploy/publish/git-push commands, reconcile scripts, direct SQL, or DB surgery.",
      "- If the ticket's allowed files are insufficient, stop immediately and respond BLOCKED.",
      "- Do not workaround a blocked tool by using bash, heredocs, sed, tee, node, or python to mutate protected files.",
      "",
    );

    if (phase === "TESTER") {
      lines.push(
        "--- TESTER PROTOCOL (NON-NEGOTIABLE) ---",
        "STEP 1. Read the Acceptance Criteria above.",
        "STEP 2. Write the MINIMUM tests that prove each AC, following the project's test guidelines.",
        "STEP 3. Do NOT run the tests. Execution belongs to the Worker.",
        `STEP 4. Write ${testerNotesPath(specsRoot, feature, ticketId)} with the tests written and guidelines followed.`,
        `STEP 5. Update ${handoffLogPath(specsRoot, feature, ticketId)} with the Tester section.`,
        "STEP 6. Say APPROVED only if tests are written and documented.",
        "DO NOT write implementation code. DO NOT run tests. DO NOT make anything pass.",
        "",
      );
    } else if (phase === "WORKER") {
      const notesPath = testerNotesPath(specsRoot, feature, ticketId);
      let notesContent = "";
      try {
        notesContent = await fsPromises.readFile(notesPath, "utf8");
      } catch {}

      if (notesContent) {
        lines.push(
          "--- WORKER PROTOCOL (NON-NEGOTIABLE) ---",
          "Tests have already been written by the Tester.",
          "STEP 1. Read the tester notes. Understand which tests exist and what they cover.",
          "STEP 2. Run the tests first and confirm the current failing state.",
          "STEP 3. Implement the MINIMUM code that makes those exact tests pass. Nothing more.",
          "STEP 4. Run the tests. Show GREEN output.",
          "STEP 5. Run typecheck. Fix any errors.",
          "STEP 6. Say APPROVED only if all tests pass and typecheck is clean.",
          "DO NOT rewrite existing tests unless the ticket explicitly requires it. DO NOT add features beyond what tests require.",
          "",
        );
      } else {
        lines.push(
          "--- WORKER PROTOCOL (NON-NEGOTIABLE, NO TESTER NOTES) ---",
          "STEP 1. Write failing tests for each Acceptance Criterion. Run them. Show FAILURES.",
          "STEP 2. Implement ONLY what is described in Implementation Notes, in order.",
          "STEP 3. Run the tests. Show GREEN output.",
          "STEP 4. Run typecheck. Fix any errors.",
          "STEP 5. Say APPROVED only if all tests pass and typecheck is clean.",
          "DO NOT combine steps. DO NOT skip the red phase. DO NOT invent shortcuts.",
          "",
        );
      }
    } else if (phase === "REVIEWER") {
      lines.push(
        "--- REVIEWER PROTOCOL (NON-NEGOTIABLE) ---",
        "STEP 1. Read all Acceptance Criteria above.",
        "STEP 2. Run the tests and inspect the implementation against the ticket.",
        "STEP 3. If everything is correct, do not edit code. Just document the review.",
        "STEP 4. If something is missing, you MAY edit tests and/or implementation within the ticket scope.",
        "STEP 5. When behavior must change, add or adjust tests first whenever needed, then apply the minimum implementation fix.",
        "STEP 6. Re-run tests after any edit. Run typecheck before approval.",
        `STEP 7. Write ${reviewerNotesPath(specsRoot, feature, ticketId)} with findings and any edits made.`,
        "STEP 8. Say APPROVED only if ALL ACs are met, tests pass, and typecheck is clean. Otherwise NEEDS-FIX.",
        "",
      );
    } else if (phase === "CHIEF") {
      lines.push(
        "--- CHIEF PROTOCOL (NON-NEGOTIABLE) ---",
        `STEP 1. Append a dated entry to ${featureMemoryPath(specsRoot, feature)} with decisions and patterns from this ticket.`,
        `STEP 2. Write ${workerContextPath(specsRoot, feature, ticketId)} summarising status, files modified, and reviewer findings.`,
        "STEP 3. Say APPROVED when both files are written.",
        "",
      );
    }

    lines.push("================================================================");

    return {
      systemPrompt: event.systemPrompt + lines.join("\n"),
    };
  });

  // ── Strict governance for tool calls ──────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    const pending = getPendingExecution();
    const decision = await evaluateGovernanceForToolCall(event, pending);
    if (!decision?.block) return;
    return decision;
  });

  // ── Show current phase in status bar ─────────────────────────────────────
  pi.on("agent_start", async (_event, ctx) => {
    const pending = getPendingExecution();
    if (!pending || pending.kind === "feature-plan") {
      ctx.ui.setStatus("feature-flow", "");
      return;
    }
    const ticketId = (pending as any).ticketId as string;
    const phase =
      pending.kind === "ticket-tester"
        ? "TESTER"
        : pending.kind === "ticket-execution"
          ? (pending as any).executionRole.toUpperCase()
          : "?";
    ctx.ui.setStatus("feature-flow", `[${ticketId} › ${phase}]`);
  });

  pi.on("agent_end", async (_statusEvent, ctx) => {
    ctx.ui.setStatus("feature-flow", "");
  });

  // ── Auto-advance on agent_end ──────────────────────────────────────────────
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

    let parsed = parseOutcome(event.messages);
    if (!parsed) {
      emitInfo(
        pi,
        [
          "Could not determine agent outcome.",
          "Expected one of: APPROVED, BLOCKED, NEEDS-FIX.",
          "Keeping checkpoint so the phase can be resumed safely.",
        ].join("\n"),
      );
      ctx.ui.notify("Could not determine agent outcome. Checkpoint preserved for resume.", "warning");
      return;
    }

    try {
      if (pending.kind === "ticket-tester" && parsed.status === "done") {
        const notesPath = testerNotesPath(pending.specsRoot, pending.feature, pending.ticketId);
        const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
        const missing: string[] = [];
        if (!(await fsPromises.access(notesPath).then(() => true).catch(() => false))) missing.push(notesPath);
        if (!(await fsPromises.access(logPath).then(() => true).catch(() => false))) missing.push(logPath);
        if (missing.length > 0) {
          parsed = {
            status: "needs_fix",
            note: `APPROVED was reported but tester artifacts were not written: ${missing.join(", ")}`,
          };
        }
      }

      if (pending.kind === "ticket-execution" && parsed.status === "done") {
        if (pending.executionRole === "worker") {
          const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
          if (!(await fsPromises.access(logPath).then(() => true).catch(() => false))) {
            parsed = {
              status: "needs_fix",
              note: `APPROVED was reported but worker handoff log was not written: ${logPath}`,
            };
          }
        }

        if (pending.executionRole === "reviewer") {
          const notesPath = reviewerNotesPath(pending.specsRoot, pending.feature, pending.ticketId);
          const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
          const missing: string[] = [];
          if (!(await fsPromises.access(notesPath).then(() => true).catch(() => false))) missing.push(notesPath);
          if (!(await fsPromises.access(logPath).then(() => true).catch(() => false))) missing.push(logPath);
          if (missing.length > 0) {
            parsed = {
              status: "needs_fix",
              note: `APPROVED was reported but reviewer artifacts were not written: ${missing.join(", ")}`,
            };
          }
        }

        if (pending.executionRole === "chief") {
          const contextPath = workerContextPath(pending.specsRoot, pending.feature, pending.ticketId);
          const memoryPath = featureMemoryPath(pending.specsRoot, pending.feature);
          const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
          const missing: string[] = [];
          if (!(await fsPromises.access(contextPath).then(() => true).catch(() => false))) missing.push(contextPath);
          if (!(await fsPromises.access(memoryPath).then(() => true).catch(() => false))) missing.push(memoryPath);
          if (!(await fsPromises.access(logPath).then(() => true).catch(() => false))) missing.push(logPath);
          if (missing.length > 0) {
            parsed = {
              status: "needs_fix",
              note: `APPROVED was reported but chief artifacts were missing: ${missing.join(", ")}`,
            };
          }
        }
      }

      setPendingExecution(undefined);
      if ("specsRoot" in pending && "feature" in pending) {
        await clearCheckpoint(
          (pending as { specsRoot: string }).specsRoot,
          (pending as { feature: string }).feature,
        );
      }
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

        // Load registry and optionally kick off the first ticket automatically
        const registry = await loadRegistry(pending.specsRoot, pending.feature);
        const planningConfig = await loadConfig(pending.cwd);
        const autoStartFirstTicket = shouldAutoStartFirstTicketAfterPlanning(planningConfig);
        emitInfo(
          pi,
          [
            `Feature **${pending.feature}** plan ready.`,
            "",
            `Tickets registered: ${registry.tickets.length}`,
            "",
            autoStartFirstTicket
              ? "Starting the first ticket automatically, then following execution policy."
              : "Automatic ticket start is disabled by config.",
            "",
            renderStatus(registry),
          ].join("\n"),
        );
        ctx.ui.notify(
          autoStartFirstTicket
            ? `Feature ${pending.feature} planned. ${registry.tickets.length} tickets. Starting first ticket...`
            : `Feature ${pending.feature} planned. ${registry.tickets.length} tickets. Waiting for manual start.`,
          "info",
        );
        if (autoStartFirstTicket) {
          await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot, ctx);
        }
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
        await launchWorkerChain(
          pi,
          ctx,
          pending.feature,
          pending.ticketId,
          pending.cwd,
          pending.specsRoot,
          pending.phase,
        );
        return;
      }

      // ticket-execution outcome (worker → reviewer → chief)
      const registry = await loadRegistry(pending.specsRoot, pending.feature);
      const ticket = getTicket(registry, pending.ticketId);
      if (!ticket) return;

      const usage = extractUsage(event.messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
      const cumulativeUsage = sumUsage(pending.accumulatedUsage, usage);
      const runIndex = Math.max(0, ticket.runs.length - 1);
      const now = new Date().toISOString();

      await recordTicketCost(pending.specsRoot, pending.feature, pending.ticketId, pending.executionRole, runIndex, {
        ...usage,
        recordedAt: now,
      });

      const label = outcomeLabel(parsed.status);
      const costStr = usage.costUsd > 0 ? ` — $${usage.costUsd.toFixed(4)}` : "";
      emitInfo(
        pi,
        `${pending.executionRole} phase for **${pending.ticketId}** (${pending.feature}): ${label}${parsed.note ? `\n${parsed.note}` : ""}${costStr}`,
      );

      if (parsed.status === "done") {
        if (pending.executionRole === "worker") {
          ctx.ui.notify(`Worker done for ${pending.ticketId}. Starting reviewer...`, "info");
          await launchReviewerPhase(
            pi,
            ctx,
            pending.feature,
            pending.ticketId,
            pending.cwd,
            pending.specsRoot,
            pending.phase,
            cumulativeUsage,
          );
          return;
        }

        if (pending.executionRole === "reviewer") {
          ctx.ui.notify(`Reviewer done for ${pending.ticketId}. Starting chief...`, "info");
          await launchChiefPhase(
            pi,
            ctx,
            pending.feature,
            pending.ticketId,
            pending.cwd,
            pending.specsRoot,
            pending.phase,
            cumulativeUsage,
          );
          return;
        }
      }

      resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
      if (ticket.runs.length > 0) {
        const lastRun = ticket.runs[ticket.runs.length - 1]!;
        lastRun.usage = cumulativeUsage;
      }
      await saveRegistry(pending.specsRoot, pending.feature, registry);

      ctx.ui.notify(
        `Ticket ${pending.ticketId}: ${label}`,
        parsed.status === "blocked" ? "warning" : "info",
      );

      if (parsed.status === "done") {
        const executionConfig = await loadConfig(pending.cwd);
        if (shouldAutoAdvanceToNextTicket(executionConfig)) {
          await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot, ctx);
        } else {
          emitInfo(
            pi,
            `Stopping after ${pending.ticketId} by config. Automatic advance to the next ticket is disabled.`,
          );
          ctx.ui.notify(
            `Ticket ${pending.ticketId} finished. Auto-advance is disabled; stopping here.`,
            "info",
          );
        }
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
      await applyRoleRuntimeConfig(pi, ctx, config, "planner");
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
          ctx,
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

type GovernancePhase = "PLANNER" | "TESTER" | "WORKER" | "REVIEWER" | "CHIEF" | "UNKNOWN";

type GovernanceContext = {
  phase: GovernancePhase;
  cwd: string;
  feature?: string;
  ticketId?: string;
  specsRoot?: string;
  allowedExactPaths: Set<string>;
  allowedDirectories: Set<string>;
  testerNotesPath?: string;
  reviewerNotesPath?: string;
  workerContextPath?: string;
  handoffLogPath?: string;
  featureMemoryPath?: string;
};

type RoleRuntimeContext = Pick<ExtensionContext, "modelRegistry" | "model" | "ui">;
type ExecutionRole = "worker" | "reviewer" | "chief";
type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

const PROTECTED_WRITE_PATH_PATTERNS = [
  /^drizzle\/.+\.sql$/i,
  /^drizzle\/meta(?:\/|$)/i,
  /^\.github\/workflows(?:\/|$)/i,
  /^\.circleci(?:\/|$)/i,
  /^infra(?:\/|$)/i,
  /^terraform(?:\/|$)/i,
  /^helm(?:\/|$)/i,
  /^\.changeset(?:\/|$)/i,
  /^scripts\/deploy(?:\/|$|-|\.)/i,
  /^deploy(?:\/|$)/i,
];

const PROTECTED_WRITE_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "railway.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "dockerfile",
  "procfile",
  "app.yaml",
]);

const FORBIDDEN_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+run\s+deploy\b|\bwrangler\s+deploy\b|\bvercel\b|\bnetlify\s+deploy\b|\bfly\s+deploy\b|\brailway\s+up\b|\bterraform\s+apply\b|\bpulumi\s+up\b|\bkubectl\s+apply\b|\bgh\s+workflow\s+run\b|\bdocker\s+push\b/i,
    reason: "Deploy/publish/infra execution is forbidden inside feature-flow phases.",
  },
  {
    pattern: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\bgit\s+push\b|\bgit\s+tag\b|\bgh\s+pr\s+create\b/i,
    reason: "Publishing and remote git operations are forbidden inside feature-flow phases.",
  },
  {
    pattern: /db:reconcile|db-reconcile|INSERT\s+INTO\s+drizzle\.__drizzle_migrations|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|\bpsql\b|drizzle-kit\s+push\b/i,
    reason: "Direct database surgery is forbidden. Use schema.ts + Drizzle generate/migrate only.",
  },
];

function sumUsage(base?: Partial<UsageTotals>, next?: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: (base?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    outputTokens: (base?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
    cacheReadTokens: (base?.cacheReadTokens ?? 0) + (next?.cacheReadTokens ?? 0),
    cacheWriteTokens: (base?.cacheWriteTokens ?? 0) + (next?.cacheWriteTokens ?? 0),
    costUsd: (base?.costUsd ?? 0) + (next?.costUsd ?? 0),
  };
}

async function evaluateGovernanceForToolCall(
  event: { toolName: string; input: unknown },
  pending: ReturnType<typeof getPendingExecution>,
): Promise<{ block: true; reason: string } | undefined> {
  const governance = await buildGovernanceContext(pending);

  if (event.toolName === "write" || event.toolName === "edit") {
    const filePath = ((event.input as any)?.path ?? "") as string;
    const resolvedPath = resolveCandidatePath(governance.cwd, filePath);
    const protectedReason = getProtectedPathReason(governance.cwd, resolvedPath);
    if (protectedReason) {
      return {
        block: true,
        reason: `${governance.phase} GOVERNANCE VIOLATION: ${protectedReason} Path: '${filePath}'. Respond BLOCKED instead of working around this restriction.`,
      };
    }

    const phaseDecision = getPhaseWriteDecision(governance, resolvedPath, filePath);
    if (phaseDecision) return phaseDecision;
  }

  if (event.toolName === "bash") {
    const command = String(((event.input as any)?.command ?? "") as string);
    const bashDecision = getForbiddenBashDecision(command, governance.phase);
    if (bashDecision) {
      return {
        block: true,
        reason: `${governance.phase} GOVERNANCE VIOLATION: ${bashDecision} Respond BLOCKED and explain the real constraint.`,
      };
    }
  }

  return undefined;
}

async function buildGovernanceContext(
  pending: ReturnType<typeof getPendingExecution>,
): Promise<GovernanceContext> {
  if (!pending) {
    return {
      phase: "UNKNOWN",
      cwd: process.cwd(),
      allowedExactPaths: new Set(),
      allowedDirectories: new Set(),
    };
  }

  const phase: GovernancePhase =
    pending.kind === "ticket-tester"
      ? "TESTER"
      : pending.kind === "ticket-execution"
        ? pending.executionRole.toUpperCase() as GovernancePhase
        : pending.kind === "feature-plan"
          ? "PLANNER"
          : "UNKNOWN";

  const context: GovernanceContext = {
    phase,
    cwd: pending.cwd,
    feature: "feature" in pending ? pending.feature : undefined,
    ticketId: "ticketId" in pending ? pending.ticketId : undefined,
    specsRoot: "specsRoot" in pending ? pending.specsRoot : undefined,
    allowedExactPaths: new Set(),
    allowedDirectories: new Set(),
  };

  if (!context.feature || !context.specsRoot || !context.ticketId) return context;

  context.testerNotesPath = testerNotesPath(context.specsRoot, context.feature, context.ticketId);
  context.reviewerNotesPath = reviewerNotesPath(context.specsRoot, context.feature, context.ticketId);
  context.workerContextPath = workerContextPath(context.specsRoot, context.feature, context.ticketId);
  context.handoffLogPath = handoffLogPath(context.specsRoot, context.feature, context.ticketId);
  context.featureMemoryPath = featureMemoryPath(context.specsRoot, context.feature);

  const ticketPath = path.join(context.specsRoot, context.feature, "tickets", `${context.ticketId}.md`);
  const ticketContent = await fsPromises.readFile(ticketPath, "utf8").catch(() => "");
  const allowedTargets = extractAllowedTargetsFromTicket(ticketContent, context.cwd);
  for (const target of allowedTargets.files) context.allowedExactPaths.add(target);
  for (const target of allowedTargets.directories) context.allowedDirectories.add(target);

  return context;
}

function extractAllowedTargetsFromTicket(
  content: string,
  cwd: string,
): { files: Set<string>; directories: Set<string> } {
  const files = new Set<string>();
  const directories = new Set<string>();
  if (!content.trim()) return { files, directories };

  const metadataLines = [...content.matchAll(/^\s*-\s*Files:\s*(.+)$/gim)].map((m) => m[1]!.trim());
  const rawTargets = metadataLines.length > 0
    ? metadataLines.flatMap((line) => line.split(",").map((part) => part.trim()).filter(Boolean))
    : extractPathMentions(content);

  for (const rawTarget of rawTargets) {
    const normalized = rawTarget.replace(/^`|`$/g, "").trim();
    if (!normalized || normalized === "none" || normalized.startsWith("<")) continue;
    const resolved = resolveCandidatePath(cwd, normalized);
    if (normalized.endsWith("/")) {
      directories.add(stripTrailingSlash(resolved));
      continue;
    }
    if (looksLikeDirectory(normalized)) {
      directories.add(stripTrailingSlash(resolved));
      continue;
    }
    files.add(resolved);
  }

  return { files, directories };
}

function extractPathMentions(content: string): string[] {
  const matches = new Set<string>();
  const regex = /`([^`\n]+(?:\/[A-Za-z0-9._-]+)+[^`\n]*)`|(?:^|[\s(])((?:\.?\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/gm;
  for (const match of content.matchAll(regex)) {
    const candidate = (match[1] || match[2] || "").trim();
    if (!candidate || !candidate.includes("/")) continue;
    matches.add(candidate);
  }
  return [...matches];
}

function getPhaseWriteDecision(
  governance: GovernanceContext,
  resolvedPath: string,
  rawPath: string,
): { block: true; reason: string } | undefined {
  if (governance.phase === "UNKNOWN" || governance.phase === "PLANNER") return undefined;

  const exact = governance.allowedExactPaths.has(resolvedPath);
  const inAllowedDir = [...governance.allowedDirectories].some((dir) => isWithinPath(resolvedPath, dir));

  if (governance.phase === "TESTER") {
    if (resolvedPath === governance.testerNotesPath || resolvedPath === governance.handoffLogPath || isTestLikePath(resolvedPath)) return undefined;
    return {
      block: true,
      reason:
        `TESTER PHASE VIOLATION: Cannot write '${rawPath}'. During TESTER you may only write test files, ${path.basename(governance.testerNotesPath ?? "tester-notes")}, and ${path.basename(governance.handoffLogPath ?? "handoff-log")}.`,
    };
  }

  if (governance.phase === "REVIEWER") {
    if (
      resolvedPath === governance.reviewerNotesPath
      || resolvedPath === governance.handoffLogPath
      || isTestLikePath(resolvedPath)
      || exact
      || inAllowedDir
    ) return undefined;
    return {
      block: true,
      reason:
        `REVIEWER PHASE VIOLATION: Reviewer may only modify ticket-scoped implementation files, test files, reviewer notes at '${governance.reviewerNotesPath}', and the handoff log at '${governance.handoffLogPath}'. Allowed exact paths: ${formatAllowedPaths(governance.allowedExactPaths)}${governance.allowedDirectories.size > 0 ? ` | Allowed directories: ${formatAllowedPaths(governance.allowedDirectories)}` : ""}`,
    };
  }

  if (governance.phase === "CHIEF") {
    if (resolvedPath === governance.featureMemoryPath || resolvedPath === governance.workerContextPath || resolvedPath === governance.handoffLogPath) return undefined;
    return {
      block: true,
      reason:
        `CHIEF PHASE VIOLATION: Chief may only write '${governance.featureMemoryPath}', '${governance.workerContextPath}', and '${governance.handoffLogPath}'.`,
    };
  }

  if (governance.phase === "WORKER") {
    if (resolvedPath === governance.handoffLogPath || exact || inAllowedDir) return undefined;
    return {
      block: true,
      reason:
        `WORKER PHASE VIOLATION: '${rawPath}' is outside the ticket-allowed file scope. Only paths explicitly listed in '- Files:' may be modified, plus the handoff log '${governance.handoffLogPath}'. Allowed exact paths: ${formatAllowedPaths(governance.allowedExactPaths)}${governance.allowedDirectories.size > 0 ? ` | Allowed directories: ${formatAllowedPaths(governance.allowedDirectories)}` : ""}`,
    };
  }

  return undefined;
}

function getForbiddenBashDecision(command: string, phase?: GovernancePhase): string | undefined {
  for (const entry of FORBIDDEN_BASH_PATTERNS) {
    if (entry.pattern.test(command)) return entry.reason;
  }

  if (phase === "TESTER" && isTestExecutionCommand(command)) {
    return "Tester may not execute tests. The tester role is limited to reading the ticket, writing test files, and documenting the test plan.";
  }

  const lower = command.toLowerCase();
  const mutatesFile = />|>>|\btee\b|\bsed\b[^\n]*\s-i\b|\bperl\b[^\n]*\s-pi\b|\bcp\b|\bmv\b|\brm\b|\btouch\b|\btruncate\b/.test(lower);

  for (const protectedHint of [".env", "drizzle/", "drizzle\\", ".github/workflows", "wrangler.", "vercel.json", "netlify.toml", "fly.toml", "railway.json", "docker-compose", "terraform", "helm/"]) {
    if (lower.includes(protectedHint.toLowerCase())) {
      return `Bash command attempts to mutate a protected path (${protectedHint}).`;
    }
  }

  return undefined;
}

function getProtectedPathReason(cwd: string, resolvedPath: string): string | undefined {
  const rel = toPosixRelative(cwd, resolvedPath);
  const base = path.basename(resolvedPath).toLowerCase();
  if (base.startsWith(".env")) return "Environment files are protected and may not be edited by the agent.";
  if (PROTECTED_WRITE_BASENAMES.has(base)) return `Protected deployment/runtime file '${path.basename(resolvedPath)}' may not be edited by the agent.`;
  if (PROTECTED_WRITE_PATH_PATTERNS.some((pattern) => pattern.test(rel))) {
    if (rel.startsWith("drizzle/")) {
      return "Generated Drizzle artifacts are protected. Edit schema.ts only and use db:generate/db:migrate.";
    }
    return `Protected path '${rel}' may not be edited by the agent.`;
  }
  if (/\.tf(?:vars)?$/i.test(base)) return "Terraform files are protected and may not be edited by the agent.";
  return undefined;
}

function resolveCandidatePath(cwd: string, rawPath: string): string {
  const clean = rawPath.replace(/^@/, "").trim();
  if (!clean) return path.resolve(cwd);
  return path.resolve(cwd, clean);
}

function looksLikeDirectory(target: string): boolean {
  const tail = target.split("/").pop() ?? target;
  return !tail.includes(".");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function toPosixRelative(root: string, target: string): string {
  const rel = path.relative(root, target);
  return rel.split(path.sep).join("/");
}

function isWithinPath(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isTestLikePath(filePath: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)\//.test(filePath) || /\.(?:test|spec)\.[^.]+$/i.test(filePath);
}

function isTestExecutionCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bphpunit\b|\brspec\b/i.test(command);
}

function formatAllowedPaths(paths: Set<string>): string {
  const values = [...paths].map((p) => p.split(path.sep).join("/")).sort();
  return values.length > 0 ? values.join(", ") : "(none declared)";
}

function parseConfiguredModelRef(
  raw: string | undefined,
  currentProvider: string | undefined,
): { provider: string; modelId: string } | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const slashIndex = value.indexOf("/");
  if (slashIndex >= 0) {
    const provider = value.slice(0, slashIndex).trim();
    const modelId = value.slice(slashIndex + 1).trim();
    if (provider && modelId) return { provider, modelId };
  }

  if (currentProvider) {
    return { provider: currentProvider, modelId: value };
  }

  return undefined;
}

async function applyRoleRuntimeConfig(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  config: Awaited<ReturnType<typeof loadConfig>>,
  role: "planner" | "tester" | "worker" | "reviewer" | "chief",
): Promise<void> {
  if (!ctx) return;

  const roleConfig = config.agents?.[role];
  if (!roleConfig) return;

  const modelRef = parseConfiguredModelRef(roleConfig.model, ctx.model?.provider);
  if (modelRef) {
    const targetModel = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
    if (!targetModel) {
      ctx.ui.notify(`Configured ${role} model not found: ${roleConfig.model}`, "warning");
    } else if (!ctx.model || ctx.model.provider !== targetModel.provider || ctx.model.id !== targetModel.id) {
      const success = await pi.setModel(targetModel);
      if (!success) {
        ctx.ui.notify(`Could not switch to ${role} model ${roleConfig.model} (missing API key?)`, "warning");
      }
    }
  }

  if (roleConfig.thinking) {
    pi.setThinkingLevel(roleConfig.thinking);
  }
}

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
      await launchTicketExecution(pi, ctx, feature, current.id, ctx.cwd, specsRoot, "resume");
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

  await startPreparedNextTicket(pi, feature, ctx.cwd, specsRoot, ctx);
}

async function startPreparedNextTicket(
  pi: ExtensionAPI,
  feature: string,
  cwd: string,
  specsRoot: string,
  ctx?: RoleRuntimeContext,
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
  await launchTicketExecution(pi, ctx, feature, next.id, cwd, specsRoot, mode);
}

async function launchTicketExecution(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
) {
  const config = await loadConfig(cwd);
  const tddEnabled = resolveTddEnabled(config);

  if (tddEnabled) {
    await launchTesterPhase(pi, ctx, feature, ticketId, cwd, specsRoot, phase, config);
  } else {
    await launchWorkerChain(pi, ctx, feature, ticketId, cwd, specsRoot, phase, config);
  }
}

/** Phase 1 (TDD only): run the tester agent to write failing tests. */
async function launchTesterPhase(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "tester");
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const notesPath = testerNotesPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);

  const message = [
    buildTesterPrompt(feature, ticketId, featureDir, ticketPath, notesPath, logPath, resolvedConfig),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const testerPending = { kind: "ticket-tester" as const, feature, ticketId, phase, cwd, specsRoot };
  setPendingExecution(testerPending);
  await persistCheckpoint(testerPending);
  pi.sendUserMessage(message);
}

/** Phase 2a: worker */
async function launchWorkerChain(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "worker");
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);

  const memPath = featureMemoryPath(specsRoot, feature);
  const memExists = await fsPromises.access(memPath).then(() => true).catch(() => false);

  const notesPath = testerNotesPath(specsRoot, feature, ticketId);
  const notesExist = await fsPromises.access(notesPath).then(() => true).catch(() => false);

  const ctxPath = workerContextPath(specsRoot, feature, ticketId);
  const ctxExists = await fsPromises.access(ctxPath).then(() => true).catch(() => false);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);

  const message = [
    buildWorkerPrompt(
      feature,
      ticketId,
      featureDir,
      ticketPath,
      memExists ? memPath : undefined,
      notesExist ? notesPath : undefined,
      ctxExists && phase === "retry" ? ctxPath : undefined,
      logPath,
      resolvedConfig,
      phase,
    ),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const execPending = {
    kind: "ticket-execution" as const,
    executionRole: "worker" as const,
    feature,
    ticketId,
    phase,
    cwd,
    specsRoot,
    accumulatedUsage: undefined,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  pi.sendUserMessage(message);
}

async function launchReviewerPhase(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  accumulatedUsage: UsageTotals,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "reviewer");

  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const memPath = featureMemoryPath(specsRoot, feature);
  const memExists = await fsPromises.access(memPath).then(() => true).catch(() => false);
  const reviewPath = reviewerNotesPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);

  const message = [
    buildReviewerPrompt(
      feature,
      ticketId,
      featureDir,
      ticketPath,
      memExists ? memPath : undefined,
      reviewPath,
      logPath,
      resolvedConfig,
    ),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const execPending = {
    kind: "ticket-execution" as const,
    executionRole: "reviewer" as const,
    feature,
    ticketId,
    phase,
    cwd,
    specsRoot,
    accumulatedUsage,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  pi.sendUserMessage(message);
}

async function launchChiefPhase(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  accumulatedUsage: UsageTotals,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "chief");

  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const memPath = featureMemoryPath(specsRoot, feature);
  const reviewPath = reviewerNotesPath(specsRoot, feature, ticketId);
  const contextPath = workerContextPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);

  const message = [
    buildChiefPrompt(feature, ticketId, featureDir, ticketPath, memPath, reviewPath, contextPath, logPath, resolvedConfig),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const execPending = {
    kind: "ticket-execution" as const,
    executionRole: "chief" as const,
    feature,
    ticketId,
    phase,
    cwd,
    specsRoot,
    accumulatedUsage,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  pi.sendUserMessage(message);
}
