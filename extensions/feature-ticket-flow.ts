import path from "node:path";
import { promises as fsPromises } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { CommandPreset, FeatureAgentRole, FeatureFlowConfig, TicketRegistry } from "../src/types.js";
import {
  loadConfig,
  resolveSpecsRoot,
  resolveTddEnabled,
  shouldAutoAdvanceToNextTicket,
  shouldAutoStartFirstTicketAfterPlanning,
} from "../src/config.js";
import { createRuntimeConfigStore, ensureConfigFile } from "../src/config-store.js";
import { startRun, updateRun, finishRun, getActiveRuns, getRecentRuns, type Phase } from "../src/run-history.js";
import { renderFeatureFlowStatusSummary } from "../src/ui/status.js";
import { FeatureFlowSettingsComponent } from "../src/ui/settings.js";
import { resolveModelForRole } from "../src/model-tiers.js";
import {
  areDependenciesDone,
  managerHandoffPath,
  featureCostPath,
  featureMemoryPath,
  handoffLogPath,
  readFeatureCost,
  reviewerHandoffPath,
  reviewerNotesPath,
  testerHandoffPath,
  workerHandoffPath,
  workerContextPath,
  testerNotesPath,
  findNextAvailableTicket,
  getTicket,
  listFeatureSlugs,
  loadRegistry,
  recordTicketCost,
  resolveTicketStatus,
  setTicketStatus,
  setTicketCommitHash,
  saveRegistry,
  startTicketRun,
} from "../src/registry.js";
import { renderFeatureStatusSummary, renderStatus, renderValidation } from "../src/render.js";
import { resolveFeatureSlug, validateBeforeExecution } from "../src/feature-flow/guards.js";
import {
  buildManagerPrompt,
  buildFeaturePlanningPrompt,
  buildReviewerPrompt,
  buildSubagentGuidance,
  buildTesterPrompt,
  buildWorkerPrompt,
  resolveSpecFileInFeatureDir,
} from "../src/feature-flow/prompts.js";
import { getForbiddenBashDecision } from "../src/feature-flow/bash-governance.js";
import {
  validateManagerArtifacts,
  validateReviewerArtifacts,
  validateTesterArtifacts,
  validateWorkerArtifacts,
} from "../src/feature-flow/handoff-validation.js";
import {
  checkRepoClean,
  commitSnapshot,
  buildCommitMessage,
} from "../src/feature-flow/git.js";
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

let activeModelLabel: string | undefined;
let sessionThinkingLevel: ThinkingLevel | undefined;
let thinkingOverrideActive = false;

// ─── Config gate helpers ───────────────────────────────────────────────────────

type CommandContext = ExtensionCommandContext & {
  ui: {
    notify: (msg: string, type?: "error" | "warning" | "info") => void;
    select: Function;
    input: Function;
  };
};

/**
 * Returns the ConfigGateState for the given cwd without throwing.
 * Uses createRuntimeConfigStore internally (fresh per call).
 */
function getConfigGateState(cwd: string) {
  return createRuntimeConfigStore(cwd).getGateState();
}

/**
 * Emits a notification for config diagnostics at session_start.
 * Shows a summary line: errors, warnings, or clean.
 */
function notifyConfigDiagnostics(ctx: { cwd: string; ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } }): void {
  const gate = getConfigGateState(ctx.cwd);
  if (gate.diagnostics.length === 0) return; // clean — no notification

  const errors = gate.diagnostics.filter((d) => d.level === "error");
  const warnings = gate.diagnostics.filter((d) => d.level === "warning");

  const parts: string[] = [];
  if (errors.length > 0) parts.push(`${errors.length} error${errors.length > 1 ? "s" : ""}`);
  if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
  const summary = parts.join(", ");

  ctx.ui.notify(`feature-flow config: ${summary}. Run /feature-flow-settings to review.`, errors.length > 0 ? "warning" : "info");
}

/**
 * Guard: blocks a command if the config gate is closed (errors present).
 * Returns true if blocked (command should abort).
 */
function blockIfGateClosed(ctx: { cwd: string; ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } }): boolean {
  const gate = getConfigGateState(ctx.cwd);
  if (!gate.blocked) return false;

  const errorCodes = gate.diagnostics
    .filter((d) => d.level === "error")
    .map((d) => d.code)
    .join(", ");
  ctx.ui.notify(
    `feature-flow config error: ${gate.message} (codes: ${errorCodes}). Fix the errors or run /feature-flow-settings.`,
    "error",
  );
  return true;
}

function updateFeatureFlowStatus(
  ctx: Pick<ExtensionContext, "ui" | "model">,
  activeModelLabel?: string,
  thinkingLevel?: string,
) {
  const pending = getPendingExecution();
  if (!pending) {
    ctx.ui.setStatus("feature-flow", "");
    return;
  }

  ctx.ui.setStatus(
    "feature-flow",
    buildFeatureFlowStatusLabel(pending, activeModelLabel ?? formatModelLabel(ctx.model), thinkingLevel),
  );
}

function restoreSessionThinkingLevel(pi: ExtensionAPI) {
  if (sessionThinkingLevel === undefined) return;
  pi.setThinkingLevel(sessionThinkingLevel);
  thinkingOverrideActive = false;
}

async function clearStalePendingExecution(
  pending: ReturnType<typeof getPendingExecution>,
  reason?: string,
): Promise<void> {
  if (!pending) return;
  setPendingExecution(undefined);
  if ("specsRoot" in pending && "feature" in pending) {
    await clearCheckpoint(pending.specsRoot, pending.feature);
  }
  if (reason) {
    console.warn(`[feature-flow] cleared stale pending execution: ${reason}`);
  }
}

async function getValidatedPendingExecution(): Promise<ReturnType<typeof getPendingExecution>> {
  const pending = getPendingExecution();
  if (!pending) return undefined;

  if (!("specsRoot" in pending) || !("feature" in pending)) {
    await clearStalePendingExecution(pending, "missing specsRoot/feature");
    return undefined;
  }

  const checkpoint = await loadCheckpoint(pending.specsRoot, pending.feature);

  if (pending.kind === "feature-plan") {
    if (!checkpoint || checkpoint.kind !== "feature-plan") {
      await clearStalePendingExecution(pending, "feature-plan without matching checkpoint");
      return undefined;
    }
    return pending;
  }

  if (!checkpoint || checkpoint.kind === "feature-plan") {
    await clearStalePendingExecution(pending, "ticket phase without matching checkpoint");
    return undefined;
  }

  if (checkpoint.feature !== pending.feature || checkpoint.ticketId !== pending.ticketId) {
    await clearStalePendingExecution(pending, "checkpoint ticket mismatch");
    return undefined;
  }

  if (pending.kind === "ticket-tester" && checkpoint.kind !== "ticket-tester") {
    await clearStalePendingExecution(pending, "tester pending mismatches checkpoint kind");
    return undefined;
  }

  if (pending.kind === "ticket-execution") {
    if (checkpoint.kind !== "ticket-execution" || checkpoint.executionRole !== pending.executionRole) {
      await clearStalePendingExecution(pending, "execution pending mismatches checkpoint role");
      return undefined;
    }
  }

  try {
    const registry = await loadRegistry(pending.specsRoot, pending.feature);
    const ticket = getTicket(registry, pending.ticketId);
    if (!ticket || ticket.status !== "in_progress") {
      await clearStalePendingExecution(pending, `ticket ${pending.ticketId} is not in_progress`);
      return undefined;
    }
  } catch {
    await clearStalePendingExecution(pending, "could not load registry for pending execution");
    return undefined;
  }

  return pending;
}

export default function featureTicketFlow(pi: ExtensionAPI) {
  const refreshFeatureFlowStatus = (
    ctx: Pick<ExtensionContext, "ui" | "model">,
  ) => {
    updateFeatureFlowStatus(ctx, activeModelLabel, pi.getThinkingLevel());
  };

  // ── Inject ticket as mandatory system prompt context ─────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const pending = await getValidatedPendingExecution();
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
    } else if (phase === "MANAGER") {
      lines.push(
        "--- MANAGER PROTOCOL (NON-NEGOTIABLE) ---",
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
    const pending = await getValidatedPendingExecution();
    const decision = await evaluateGovernanceForToolCall(event, pending);
    if (!decision?.block) return;
    return decision;
  });

  // ── Show current phase + active model in status bar ──────────────────────
  pi.on("agent_start", async (_event, ctx) => {
    const pending = await getValidatedPendingExecution();
    const runId = buildRunId(pending);
    if (runId) {
      try {
        updateRun(runId, {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinking: pi.getThinkingLevel(),
        });
      } catch {
        // Silent
      }
    }
    refreshFeatureFlowStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    activeModelLabel = `${event.model.provider}/${event.model.id}`;
    await getValidatedPendingExecution();
    refreshFeatureFlowStatus(ctx);
  });

  pi.on("agent_end", async (_statusEvent, ctx) => {
    ctx.ui.setStatus("feature-flow", "");
    if (!getPendingExecution()) {
      restoreSessionThinkingLevel(pi);
    }
  });

  // ── Auto-advance on agent_end ──────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    activeModelLabel = formatModelLabel(ctx.model);
    sessionThinkingLevel = pi.getThinkingLevel();
    thinkingOverrideActive = false;

    // Show config diagnostics summary (if any)
    notifyConfigDiagnostics(ctx);

    // Register command presets from config (idempotent — skips already-registered)
    const sessionConfig = await loadConfig(ctx.cwd);
    registerPresetCommands(pi, sessionConfig);

    // Only attempt recovery on startup/reload — skip for new/fork sessions
    if (_event.reason !== "startup" && _event.reason !== "reload") return;

    const config = sessionConfig;
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

  pi.on("session_shutdown", async () => {
    restoreSessionThinkingLevel(pi);
  });

  // ── Auto-advance on agent_end ──────────────────────────────────────────────
  pi.on("agent_end", async (event, ctx) => {
    const pending = getPendingExecution();
    try {
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

      if (pending.kind === "ticket-tester" && parsed.status === "done") {
        const notesPath = testerNotesPath(pending.specsRoot, pending.feature, pending.ticketId);
        const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
        const testerJsonPath = testerHandoffPath(pending.specsRoot, pending.feature, pending.ticketId);
        const ticketPath = path.join(pending.specsRoot, pending.feature, "tickets", `${pending.ticketId}.md`);
        const validation = await validateTesterArtifacts(notesPath, logPath, testerJsonPath, ticketPath);
        if (!validation.ok) {
          parsed = {
            status: "needs_fix",
            note: `tester artifacts validation failed: ${validation.issues.join("; ")}. Ensure the handoff log only contains the filled Tester section — future phase sections should remain as HTML comments (<!-- ... -->).`,
          };
        }
      }

      if (pending.kind === "ticket-execution" && parsed.status === "done") {
        if (pending.executionRole === "worker") {
          const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
          const workerJsonPath = workerHandoffPath(pending.specsRoot, pending.feature, pending.ticketId);
          const validation = await validateWorkerArtifacts(logPath, workerJsonPath);
          if (!validation.ok) {
            parsed = {
              status: "needs_fix",
              note: `worker artifacts validation failed: ${validation.issues.join("; ")}`,
            };
          }
        }

        if (pending.executionRole === "reviewer") {
          const notesPath = reviewerNotesPath(pending.specsRoot, pending.feature, pending.ticketId);
          const logPath = handoffLogPath(pending.specsRoot, pending.feature, pending.ticketId);
          const reviewerJsonPath = reviewerHandoffPath(pending.specsRoot, pending.feature, pending.ticketId);
          const validation = await validateReviewerArtifacts(notesPath, logPath, reviewerJsonPath);
          if (!validation.ok) {
            parsed = {
              status: "needs_fix",
              note: `reviewer artifacts validation failed: ${validation.issues.join("; ")}`,
            };
          }
        }


      }

      // Track run completion in history
      const runId = buildRunId(pending);
      if (runId) {
        const status = parsed.status === "done" ? "ok" : parsed.status === "blocked" ? "error" : "error";
        const errorMsg = parsed.status !== "done" ? parsed.note : undefined;
        try { finishRun(runId, status, errorMsg); } catch { /* silent */ }
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
          // Track blocked/needs-fix for feature-plan
          const planRunId = `${pending.feature}/plan`;
          try { finishRun(planRunId, "error", parsed.note); } catch { /* silent */ }
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
          // Track validation failure
          const planRunId = `${pending.feature}/plan`;
          try { finishRun(planRunId, "error", "validation failed"); } catch { /* silent */ }
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
          model: activeModelLabel,
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
          "profileName" in pending ? pending.profileName : undefined,
        );
        return;
      }

      // ticket-execution outcome (worker → reviewer → manager)
      const registry = await loadRegistry(pending.specsRoot, pending.feature);
      const ticket = getTicket(registry, pending.ticketId);
      if (!ticket) return;

      const usage = extractUsage(event.messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
      const cumulativeUsage = sumUsage(pending.accumulatedUsage, usage);
      const runIndex = Math.max(0, ticket.runs.length - 1);
      const now = new Date().toISOString();

      await recordTicketCost(pending.specsRoot, pending.feature, pending.ticketId, pending.executionRole, runIndex, {
        ...usage,
        model: activeModelLabel,
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
            "profileName" in pending ? pending.profileName : undefined,
            cumulativeUsage,
          );
          return;
        }

        if (pending.executionRole === "reviewer") {
          ctx.ui.notify(`Reviewer done for ${pending.ticketId}. Starting manager...`, "info");
          await launchManagerPhase(
            pi,
            ctx,
            pending.feature,
            pending.ticketId,
            pending.cwd,
            pending.specsRoot,
            pending.phase,
            "profileName" in pending ? pending.profileName : undefined,
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
      // Save status first (registry is persisted below or in commitDoneTicket)
      await saveRegistry(pending.specsRoot, pending.feature, registry);

      ctx.ui.notify(
        `Ticket ${pending.ticketId}: ${label}`,
        parsed.status === "blocked" ? "warning" : "info",
      );

      if (parsed.status === "done") {
        // Commit the ticket to git before advancing
        const commitHash = await commitDoneTicket(
          registry,
          pending.cwd,
          pending.specsRoot,
          pending.feature,
          pending.ticketId,
          ctx,
        );

        if (!commitHash) {
          // Commit failed — do NOT advance; user must resolve manually
          ctx.ui.notify(
            `⚠️ ${pending.ticketId} marked done but commit failed. Fix the issue and commit manually before running the next ticket.`,
            "warning",
          );
          emitInfo(
            pi,
            `Commit failed for ${pending.ticketId}. The ticket is marked done but changes are not committed. Auto-advance halted.`,
          );
          return;
        }

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
    } finally {
      if (!getPendingExecution()) {
        restoreSessionThinkingLevel(pi);
      }
    }
  });

  // ── /feature-plan ──────────────────────────────────────────────────────────
  pi.registerCommand("feature-plan", {
    description: "Plan a feature from an existing spec document (creates execution plan + tickets)",
    handler: async (args, ctx: CommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }
      if (blockIfGateClosed(ctx)) return;

      // Ensure config file exists with defaults
      ensureConfigFile(ctx.cwd);

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
            "Create your spec document at that path, then run `/feature-plan ${feature}` again.",
            "Or run `/feature-init ${feature}` to scaffold a stub spec.",
          ].join("\n"),
        );
        return;
      }

      const tddEnabled = resolveTddEnabled(config);
      await ensureFeatureDir(specsRoot, feature);

      // Preflight: repo must be clean before starting a new plan
      if (!(await preflightRepoClean(ctx.cwd, ctx))) return;

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
      trackPhaseStart(planPending);
      refreshFeatureFlowStatus(ctx);
      const plannerModelOk = await applyRoleRuntimeConfig(pi, ctx, config, "planner");
      if (!plannerModelOk) {
        setPendingExecution(undefined);
        await clearCheckpoint(specsRoot, feature).catch(() => undefined);
        refreshFeatureFlowStatus(ctx);
        return;
      }
      refreshFeatureFlowStatus(ctx);
      pi.sendUserMessage(
        buildFeaturePlanningPrompt(feature, specsRoot, specPath, config, tddEnabled),
      );
    },
  });

  // ── /feature-init ──────────────────────────────────────────────────────────
  pi.registerCommand("feature-init", {
    description: "Create a feature directory with a stub spec file",
    handler: async (args, ctx: CommandContext) => {
      // Ensure config file exists with defaults
      ensureConfigFile(ctx.cwd);

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
            "Fill in the spec, then run `/feature-plan ${slug}` to generate tickets.",
          ].join("\n"),
        );
      } else {
        emitInfo(pi, `Feature directory for **${slug}** already exists. Spec file unchanged.`);
      }

      ctx.ui.notify(`Feature ${slug} initialized.`, "info");
    },
  });

  // ── /feature-start ─────────────────────────────────────────────────────────
  pi.registerCommand("feature-start", {
    description: "Show feature status and start or resume the next ticket",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }
      if (blockIfGateClosed(ctx)) return;

      // Ensure config file exists with defaults
      ensureConfigFile(ctx.cwd);

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      // Preflight: repo must be clean when starting fresh
      if (!(await preflightRepoClean(ctx.cwd, ctx))) return;

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

  // ── /feature-next ──────────────────────────────────────────────────────────
  pi.registerCommand("feature-next", {
    description: "Pick and execute the next available ticket automatically",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }
      if (blockIfGateClosed(ctx)) return;

      // Ensure config file exists with defaults
      ensureConfigFile(ctx.cwd);

      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      // Preflight: repo must be clean when starting fresh
      if (!(await preflightRepoClean(ctx.cwd, ctx))) return;

      try {
        await runNextTicketFlow(pi, feature, ctx);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`feature-next error: ${message}`, "error");
        emitInfo(pi, `Error in /feature-next: ${message}`);
      }
    },
  });

  // ── /feature-done ───────────────────────────────────────────────────────────
  pi.registerCommand("feature-done", {
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

      // Commit the ticket to git
      await commitDoneTicket(registry, ctx.cwd, specsRoot, feature, current.id, ctx);

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

  // ── /feature-blocked ────────────────────────────────────────────────────────
  pi.registerCommand("feature-blocked", {
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

  // ── /feature-needs-fix ──────────────────────────────────────────────────────
  pi.registerCommand("feature-needs-fix", {
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

  // ── /feature-status ────────────────────────────────────────────────────────
  pi.registerCommand("feature-status", {
    description: "Show feature ticket progress from the registry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      emitInfo(pi, renderFeatureStatusSummary(registry));
    },
  });

  // ── /feature-flow-reset ────────────────────────────────────────────────────
  pi.registerCommand("feature-flow-reset", {
    description: "Clear stale in-memory/checkpoint feature-flow execution state",
    handler: async (_args, ctx: CommandContext) => {
      const pending = getPendingExecution();
      if (!pending) {
        ctx.ui.setStatus("feature-flow", "");
        ctx.ui.notify("feature-flow: no pending execution to clear", "info");
        return;
      }

      await clearStalePendingExecution(pending, "manual reset command");
      ctx.ui.setStatus("feature-flow", "");
      ctx.ui.notify("feature-flow: pending execution cleared", "info");
      emitInfo(pi, "Feature-flow runtime state cleared. Governance is now inactive until a new flow starts.");
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

      const perTicket = new Map<string, { total: number; runs: number; phases: Array<{ phase: string; cost: number; model?: string }> }>();
      for (const e of cost.entries) {
        const key = e.ticketId;
        const existing = perTicket.get(key) ?? { total: 0, runs: 0, phases: [] };
        existing.total += e.costUsd;
        existing.runs += 1;
        existing.phases.push({ phase: e.phase, cost: e.costUsd, model: e.model });
        perTicket.set(key, existing);
      }

      const lines = [
        `**Cost for ${feature}**: $${cost.totalCostUsd.toFixed(4)}`,
        "",
        "```",
        ...Array.from(perTicket.entries())
          .sort((a, b) => b[1].total - a[1].total)
          .flatMap(([ticketId, data]) => [
            `${ticketId}  $${data.total.toFixed(4)}  (${data.runs} run${data.runs !== 1 ? "s" : ""})`,
            ...data.phases.map((p) => `  ${p.phase.padEnd(10)} ${p.model ?? "—"}`.padEnd(45) + `$${p.cost.toFixed(4)}`),
          ]),
        "",
        `Total tokens: ${(cost.entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0)).toLocaleString()}`,
      ];

      emitInfo(pi, lines.join("\n"));
    },
  });

  // ── /feature-ticket-mark-pending ─────────────────────────────────────────
  pi.registerCommand("feature-ticket-mark-pending", {
    description: "Re-activate a blocked/needs_fix/done ticket by setting it back to pending",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);

      // Only offer tickets that are not already pending/in_progress
      const unlockable = registry.tickets.filter(
        (t) => t.status === "blocked" || t.status === "needs_fix" || t.status === "done",
      );

      if (unlockable.length === 0) {
        emitInfo(pi, `All tickets for **${feature}** are already pending or in progress.`);
        return;
      }

      const labelToId = new Map<string, string>();
      const ticketLabels = unlockable.map((t) => {
        const badge =
          t.status === "blocked"
            ? `[🔒 ${t.status}]`
            : t.status === "needs_fix"
              ? `[🔧 ${t.status}]`
              : `[✅ ${t.status}]`;
        const reason = t.blockedReason ? ` — ${t.blockedReason}` : "";
        const label = `${t.id}  ${badge}${reason}`;
        labelToId.set(label, t.id);
        return label;
      });

      const selectedLabel = await ctx.ui.select(
        "Select ticket to re-activate:",
        ticketLabels,
      );
      if (!selectedLabel) return;

      const ticketId = labelToId.get(selectedLabel);
      if (!ticketId) return;

      const ticket = getTicket(registry, ticketId)!;
      const previousStatus = ticket.status;
      const previousReason = ticket.blockedReason;

      setTicketStatus(registry, ticketId, "pending", `Manually unblocked from ${previousStatus}`);
      await saveRegistry(specsRoot, feature, registry);

      ctx.ui.notify(
        `**${ticketId}** → **pending** (was ${previousStatus})`,
        "info",
      );
      emitInfo(
        pi,
        `✅ Ticket **${ticketId}** marked as **pending**.\n` +
          `Previous status: ${previousStatus}${previousReason ? ` (${previousReason})` : ""}`,
      );
    },
  });

  // ── /feature-validate ──────────────────────────────────────────────────────
  pi.registerCommand("feature-validate", {
    description: "Validate spec files, dependencies, and ticket structure",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx: CommandContext) => {
      if (blockIfGateClosed(ctx)) return;
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const validation = await validateFeature(specsRoot, feature);
      emitInfo(pi, renderValidation(validation));
    },
  });

  // ── /feature-flow-status ──────────────────────────────────────────────────
  pi.registerCommand("feature-flow-status", {
    description: "Show a concise feature-flow status summary",
    handler: async (_args) => {
      const panel = renderFeatureFlowStatusSummary(getRecentRuns(10), getActiveRuns());
      emitInfo(pi, panel);
    },
  });

  // ── /feature-flow-settings ───────────────────────────────────────────────
  pi.registerCommand("feature-flow-settings", {
    description: "Show feature-flow effective config and diagnostics",
    handler: async (_args, ctx: CommandContext) => {
      const store = createRuntimeConfigStore(ctx.cwd);
      new FeatureFlowSettingsComponent({
        config: store.getConfig(),
        gateState: store.getGateState(),
        onClose: () => { /* panel closed */ },
        onRender: (panel) => emitInfo(pi, panel),
      });
    },
  });
}

// ─── Preset command registration ─────────────────────────────────────────────────

type GovernancePhase = "PLANNER" | "TESTER" | "WORKER" | "REVIEWER" | "MANAGER" | "UNKNOWN";

const registeredPresetCommands = new Set<string>();

/**
 * Deep-merges preset overrides into a base config (shallow copy, nested merge for agents).
 * Returns a new config object without mutating the original.
 */
function applyPreset(
  base: FeatureFlowConfig,
  preset: CommandPreset,
): FeatureFlowConfig {
  return {
    ...base,
    tdd: preset.tdd ?? base.tdd,
    agents: {
      ...base.agents,
      ...Object.fromEntries(
        Object.entries(preset.agents ?? {}).map(([role, agentOverride]) => [
          role,
          { ...base.agents?.[role as FeatureAgentRole], ...agentOverride },
        ]),
      ),
    },
  };
}

/**
 * Register all command presets from config as slash commands.
 * Idempotent: skips commands already registered in this session.
 */
function registerPresetCommands(pi: ExtensionAPI, config: FeatureFlowConfig): void {
  const presets = config.commands ?? {};
  for (const [cmdName, preset] of Object.entries(presets)) {
    if (registeredPresetCommands.has(cmdName)) continue;
    registeredPresetCommands.add(cmdName);

    pi.registerCommand(cmdName, {
      description: preset.description ?? `Run feature flow with ${cmdName} preset`,
      handler: async (args, ctx: CommandContext) => {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
          return;
        }
        if (blockIfGateClosed(ctx)) return;

        const baseConfig = await loadConfig(ctx.cwd);
        const mergedConfig = applyPreset(baseConfig, preset);

        const specsRoot = resolveSpecsRoot(ctx.cwd, mergedConfig);
        const feature = await resolveFeatureSlug(args, specsRoot, "Choose feature", ctx);
        if (!feature) return;

        try {
          await runNextTicketFlowWithConfig(pi, feature, ctx, mergedConfig);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`${cmdName} error: ${message}`, "error");
          emitInfo(pi, `Error in ${cmdName}: ${message}`);
        }
      },
    });
  }
}

/**
 * Run next ticket with an overridden config (for preset commands).
 */
async function runNextTicketFlowWithConfig(
  pi: ExtensionAPI,
  feature: string,
  ctx: CommandContext,
  config: FeatureFlowConfig,
): Promise<void> {
  if (!(await validateBeforeExecution(pi, feature, resolveSpecsRoot(ctx.cwd, config), ctx))) return;
  const registry = await loadRegistry(resolveSpecsRoot(ctx.cwd, config), feature);
  const next = findNextAvailableTicket(registry);
  if (!next) {
    emitInfo(pi, `No pending tickets for **${feature}**.`);
    return;
  }
  emitInfo(pi, `Running **${next.id}** with preset config…`);
  startTicketRun(registry, next.id, "start");
  await saveRegistry(resolveSpecsRoot(ctx.cwd, config), feature, registry);

  // Merge profile on top of preset config (preset wins over profile).
  // Profile extraction reads the ticket file; errors are silent — profile not applied.
  const specsRoot = resolveSpecsRoot(ctx.cwd, config);
  const ticketPath = path.join(specsRoot, feature, "tickets", `${next.id}.md`);
  let effectiveConfig: FeatureFlowConfig = config;
  try {
    const ticketContent = await fsPromises.readFile(ticketPath, "utf8");
    const match = ticketContent.match(/^\s*-\s*[Pp]rofile:\s*(\S+)/m);
    const profileName = match ? match[1] : undefined;
    if (profileName && config.profiles?.[profileName]) {
      const profileAgents = config.profiles[profileName]!.agents ?? {};
      effectiveConfig = {
        ...config,
        agents: { ...config.agents },
      };
      for (const [role, agentOverride] of Object.entries(profileAgents)) {
        effectiveConfig.agents = effectiveConfig.agents ?? {};
        effectiveConfig.agents[role as FeatureAgentRole] = {
          ...effectiveConfig.agents?.[role as FeatureAgentRole],
          ...agentOverride,
        };
      }
    }
  } catch {
    // Profile not applied — use preset config as-is
  }

  await launchTicketExecution(pi, ctx, feature, next.id, ctx.cwd, specsRoot, "start", effectiveConfig);
}

type GovernanceContext = {
  phase: GovernancePhase;
  cwd: string;
  feature?: string;
  ticketId?: string;
  specsRoot?: string;
  allowedExactPaths: Set<string>;
  allowedDirectories: Set<string>;
  testerNotesPath?: string;
  testerHandoffPath?: string;
  reviewerNotesPath?: string;
  reviewerHandoffPath?: string;
  workerContextPath?: string;
  workerHandoffPath?: string;
  handoffLogPath?: string;
  featureMemoryPath?: string;
  managerHandoffPath?: string;
};

type RoleRuntimeContext = Pick<ExtensionContext, "modelRegistry" | "model" | "ui">;
type FlowRole = "planner" | "tester" | "worker" | "reviewer" | "manager";
type ExecutionRole = "worker" | "reviewer" | "manager";
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

function sumUsage(base?: Partial<UsageTotals>, next?: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: (base?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    outputTokens: (base?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
    cacheReadTokens: (base?.cacheReadTokens ?? 0) + (next?.cacheReadTokens ?? 0),
    cacheWriteTokens: (base?.cacheWriteTokens ?? 0) + (next?.cacheWriteTokens ?? 0),
    costUsd: (base?.costUsd ?? 0) + (next?.costUsd ?? 0),
  };
}

export async function evaluateGovernanceForToolCall(
  event: { toolName: string; input: unknown },
  pending: ReturnType<typeof getPendingExecution>,
): Promise<{ block: true; reason: string } | undefined> {
  // No active feature-flow execution => do not enforce governance.
  if (!pending) return undefined;

  const governance = await buildGovernanceContext(pending);

  // Allow external tool calls if configured for an active feature-flow session.
  if (governance.cwd) {
    const config = await loadConfig(governance.cwd);
    if (config.execution?.allowExternalToolCalls) return undefined;
  }

  if (governance.phase === "PLANNER") {
    const featureRoot = governance.specsRoot && governance.feature
      ? path.join(governance.specsRoot, governance.feature)
      : undefined;
    const skillsRoot = governance.cwd
      ? path.join(governance.cwd, "skills")
      : undefined;

    if (event.toolName === "bash") {
      return {
        block: true,
        reason: "Planner may not use bash. Respond BLOCKED and explain the real constraint.",
      };
    }

    if (featureRoot && (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit")) {
      const filePath = ((event.input as any)?.path ?? "") as string;
      const resolvedPath = resolveCandidatePath(governance.cwd, filePath);

      if (!isWithinPath(resolvedPath, featureRoot)) {
        const isRead = event.toolName === "read";
        // Read-only exception: allow skills directory for PLANNER.
        // Write/edit remain blocked regardless of location.
        if (isRead && skillsRoot && isWithinPath(resolvedPath, skillsRoot)) {
          return undefined;
        }
        const reason = isRead
          ? `Planner may only read files inside the active feature directory or the skills directory. Path: '${filePath}'. Respond BLOCKED instead of working around this restriction.`
          : `Planner may only write inside the active feature directory. Path: '${filePath}'. Respond BLOCKED instead of working around this restriction.`;
        return { block: true, reason };
      }
    }
  }

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
  context.testerHandoffPath = testerHandoffPath(context.specsRoot, context.feature, context.ticketId);
  context.reviewerNotesPath = reviewerNotesPath(context.specsRoot, context.feature, context.ticketId);
  context.reviewerHandoffPath = reviewerHandoffPath(context.specsRoot, context.feature, context.ticketId);
  context.workerContextPath = workerContextPath(context.specsRoot, context.feature, context.ticketId);
  context.workerHandoffPath = workerHandoffPath(context.specsRoot, context.feature, context.ticketId);
  context.handoffLogPath = handoffLogPath(context.specsRoot, context.feature, context.ticketId);
  context.featureMemoryPath = featureMemoryPath(context.specsRoot, context.feature);
  context.managerHandoffPath = managerHandoffPath(context.specsRoot, context.feature, context.ticketId);

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
    if (resolvedPath === governance.testerNotesPath || resolvedPath === governance.testerHandoffPath || resolvedPath === governance.handoffLogPath || isTestLikePath(resolvedPath)) return undefined;
    return {
      block: true,
      reason:
        `TESTER PHASE VIOLATION: Cannot write '${rawPath}'. During TESTER you may only write test files, ${path.basename(governance.testerNotesPath ?? "tester-notes")}, ${path.basename(governance.testerHandoffPath ?? "tester-handoff.json")}, and ${path.basename(governance.handoffLogPath ?? "handoff-log")}.`,
    };
  }

  if (governance.phase === "REVIEWER") {
    if (
      resolvedPath === governance.reviewerNotesPath
      || resolvedPath === governance.reviewerHandoffPath
      || resolvedPath === governance.handoffLogPath
      || isTestLikePath(resolvedPath)
      || exact
      || inAllowedDir
    ) return undefined;
    return {
      block: true,
      reason:
        `REVIEWER PHASE VIOLATION: Reviewer may only modify ticket-scoped implementation files, test files, reviewer notes at '${governance.reviewerNotesPath}', reviewer handoff JSON at '${governance.reviewerHandoffPath}', and the handoff log at '${governance.handoffLogPath}'. Allowed exact paths: ${formatAllowedPaths(governance.allowedExactPaths)}${governance.allowedDirectories.size > 0 ? ` | Allowed directories: ${formatAllowedPaths(governance.allowedDirectories)}` : ""}`,
    };
  }

  if (governance.phase === "MANAGER") {
    if (resolvedPath === governance.featureMemoryPath || resolvedPath === governance.workerContextPath || resolvedPath === governance.managerHandoffPath || resolvedPath === governance.handoffLogPath) return undefined;
    return {
      block: true,
      reason:
        `MANAGER PHASE VIOLATION: Manager may only write '${governance.featureMemoryPath}', '${governance.workerContextPath}', '${governance.managerHandoffPath}', and '${governance.handoffLogPath}'.`,
    };
  }

  if (governance.phase === "WORKER") {
    if (resolvedPath === governance.handoffLogPath || resolvedPath === governance.workerHandoffPath || exact || inAllowedDir) return undefined;
    return {
      block: true,
      reason:
        `WORKER PHASE VIOLATION: '${rawPath}' is outside the ticket-allowed file scope. Only paths explicitly listed in '- Files:' may be modified, plus the handoff log '${governance.handoffLogPath}' and worker handoff JSON '${governance.workerHandoffPath}'. Allowed exact paths: ${formatAllowedPaths(governance.allowedExactPaths)}${governance.allowedDirectories.size > 0 ? ` | Allowed directories: ${formatAllowedPaths(governance.allowedDirectories)}` : ""}`,
    };
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

function formatAllowedPaths(paths: Set<string>): string {
  const values = [...paths].map((p) => p.split(path.sep).join("/")).sort();
  return values.length > 0 ? values.join(", ") : "(none declared)";
}

function getPendingRole(pending: ReturnType<typeof getPendingExecution>): FlowRole | undefined {
  if (!pending) return undefined;
  if (pending.kind === "feature-plan") return "planner";
  if (pending.kind === "ticket-tester") return "tester";
  if (pending.kind === "ticket-execution") return pending.executionRole;
  return undefined;
}

function getPendingPhaseLabel(pending: ReturnType<typeof getPendingExecution>): string {
  if (!pending) return "";
  if (pending.kind === "feature-plan") return "PLAN";
  if (pending.kind === "ticket-tester") return "TESTER";
  if (pending.kind === "ticket-execution") return pending.executionRole.toUpperCase();
  return "UNKNOWN";
}

function formatModelLabel(model?: { provider?: string; id?: string } | null): string {
  if (!model?.id) return "default";
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function getConfiguredModelLabel(
  config: Awaited<ReturnType<typeof loadConfig>>,
  role: FlowRole | undefined,
  currentProvider?: string,
): string | undefined {
  if (!role) return undefined;
  const raw = config.agents?.[role as keyof NonNullable<FeatureFlowConfig["agents"]>]?.model;
  if (!raw) return undefined;
  const parsed = parseConfiguredModelRef(raw, currentProvider);
  return parsed ? `${parsed.provider}/${parsed.modelId}` : raw;
}

function buildFeatureFlowStatusLabel(
  pending: ReturnType<typeof getPendingExecution>,
  activeModelLabel: string,
  thinkingLevel?: string,
): string {
  if (!pending) return "";

  const phase = getPendingPhaseLabel(pending);
  const thinkingSegment = thinkingLevel && thinkingLevel !== "off" ? ` | thinking:${thinkingLevel}` : "";
  const modelSegment = `model:${activeModelLabel}${thinkingSegment}`;

  if (pending.kind === "feature-plan") {
    return `[${pending.feature} › ${phase} › ${modelSegment}]`;
  }

  return `[${pending.ticketId} › ${phase} › ${modelSegment}]`;
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
  role: FlowRole,
  profileName?: string,
): Promise<boolean> {
  if (!ctx) return true;

  // Merge profile overlay into config agents if a profile is specified
  const profileAgents = profileName && config.profiles?.[profileName]?.agents;
  const mergedAgents = profileAgents
    ? { ...config.agents, ...profileAgents }
    : config.agents;
  const roleConfig = mergedAgents?.[role as keyof typeof mergedAgents];
  if (!roleConfig) return true;

  // Resolve tier → concrete model (if applicable)
  const resolved = resolveModelForRole(config, role);

  // Determine effective model string for display and registry lookup
  const effectiveModel: string | undefined = resolved?.model ?? roleConfig.model;
  const effectiveThinking = resolved?.thinking ?? roleConfig.thinking ?? "medium";

  const thinkingLabel = effectiveThinking ? ` | thinking:${effectiveThinking}` : "";
  const currentModelLabel = formatModelLabel(ctx.model);
  const configuredModelLabel = getConfiguredModelLabel(config, role, ctx.model?.provider);

  const modelRef = parseConfiguredModelRef(effectiveModel, ctx.model?.provider);
  const tierNote = "";

  if (modelRef) {
    const targetModel = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
    if (!targetModel) {
      ctx.ui.notify(`feature-flow ${role}: configured model not found: ${effectiveModel}${tierNote}`, "error");
      return false;
    }

    if (!ctx.model || ctx.model.provider !== targetModel.provider || ctx.model.id !== targetModel.id) {
      const success = await pi.setModel(targetModel);
      if (!success) {
        ctx.ui.notify(`feature-flow ${role}: could not switch to ${effectiveModel}${tierNote} (missing API key?)`, "error");
        return false;
      }

      activeModelLabel = `${targetModel.provider}/${targetModel.id}`;
      ctx.ui.notify(
        `feature-flow ${role}: model switched ${currentModelLabel} → ${activeModelLabel}${thinkingLabel}${tierNote}`,
        "info",
      );
    } else {
      activeModelLabel = configuredModelLabel ?? currentModelLabel;
      ctx.ui.notify(`feature-flow ${role}: using model ${activeModelLabel}${thinkingLabel}${tierNote}`, "info");
    }
  } else {
    activeModelLabel = currentModelLabel;
    ctx.ui.notify(`feature-flow ${role}: using current model ${currentModelLabel}${thinkingLabel}${tierNote}`, "info");
  }

  if (effectiveThinking) {
    if (pi.getThinkingLevel() !== effectiveThinking) {
      thinkingOverrideActive = true;
    }
    pi.setThinkingLevel(effectiveThinking);
  }

  return true;
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
      // Commit before advancing to next ticket
      await commitDoneTicket(registry, ctx.cwd, specsRoot, feature, current.id, ctx);
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

/**
 * Create a git commit for a finished ticket, persist the hash in the registry,
 * and return the hash. If the commit fails, does NOT advance.
 * Returns undefined if the commit failed or there was nothing to commit.
 */
/**
 * Simplified ctx type for commitDoneTicket and preflightRepoClean
 */
type NotifyFn = { ui: { notify: (message: string, type?: "error" | "warning" | "info") => void } };

async function commitDoneTicket(
  registry: TicketRegistry,
  cwd: string,
  specsRoot: string,
  feature: string,
  ticketId: string,
  ctx: NotifyFn,
): Promise<string | undefined> {
  const ticket = getTicket(registry, ticketId);
  if (!ticket) return undefined;

  const msg = buildCommitMessage(feature, ticketId, ticket.title);
  const result = await commitSnapshot(cwd, msg);

  if (!result.ok) {
    ctx.ui.notify(`Commit failed for ${ticketId}: ${result.error}`, "warning");
    return undefined;
  }

  // Persist the commit hash in the registry
  setTicketCommitHash(registry, ticketId, result.commitHash ?? "unknown");
  await saveRegistry(specsRoot, feature, registry);

  ctx.ui.notify(`${ticketId} committed: ${result.commitHash}`, "info");
  return result.commitHash;
}

/**
 * Pre-flight check: abort with a visible notification if the git working tree
 * is not clean. Returns true if the repo is clean (ok to proceed).
 */
async function preflightRepoClean(cwd: string, ctx: NotifyFn): Promise<boolean> {
  try {
    const status = await checkRepoClean(cwd);
    if (status.clean) return true;

    const maxShow = 5;
    const fileList = status.dirtyFiles.slice(0, maxShow);
    const more = status.dirtyFiles.length > maxShow ? `\n... and ${status.dirtyFiles.length - maxShow} more` : "";
    ctx.ui.notify(
      `Repo is not clean. Commit, stash, or discard changes before starting a feature. Dirty files:\n${fileList.join("\n")}${more}`,
      "error",
    );
    return false;
  } catch (err: unknown) {
    // If git fails entirely (e.g. no git repo in test sessions), allow the flow
    // to proceed. The commit step will fail later if git isn't available.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("git status failed")) {
      // Not a git repo or git not installed — allow
      return true;
    }
    ctx.ui.notify(`Cannot check repo status: ${msg}`, "error");
    return false;
  }
}

// ─── Run history tracking helpers ────────────────────────────────────────────────

/**
 * Build a runId string from a pending execution state.
 * Format: "feature/plan" for planning, "feature/ticketId/phase" for ticket execution.
 */
function buildRunId(
  pending: ReturnType<typeof getPendingExecution>,
): string | undefined {
  if (!pending || !("feature" in pending)) return undefined;
  const feature = (pending as { feature: string }).feature;
  if (pending.kind === "feature-plan") return `${feature}/plan`;
  const ticketId = ("ticketId" in pending ? (pending as { ticketId: string }).ticketId : undefined);
  if (!ticketId) return undefined;
  const phase: Phase =
    pending.kind === "ticket-tester"
      ? "tester"
      : pending.kind === "ticket-execution"
        ? ((pending as { executionRole: string }).executionRole as Phase)
        : "worker";
  return `${feature}/${ticketId}/${phase}`;
}

/**
 * Track the start of a phase: call startRun and return the runId.
 * Failures are silent — never block the flow.
 */
function trackPhaseStart(pending: NonNullable<ReturnType<typeof getPendingExecution>>): string | undefined {
  const runId = buildRunId(pending);
  if (!runId) return undefined;

  const phase: Phase =
    pending?.kind === "ticket-tester"
      ? "tester"
      : pending?.kind === "ticket-execution"
        ? ((pending as { executionRole: string }).executionRole as Phase)
        : pending?.kind === "feature-plan"
          ? "planner"
          : "worker";

  try {
    const feature = "feature" in pending ? (pending as { feature: string }).feature : "";
    const ticketId = "ticketId" in pending ? (pending as { ticketId?: string }).ticketId : undefined;
    startRun(runId, {
      feature,
      ticketId: ticketId ?? "plan",
      phase,
    });
  } catch {
    // Silent
  }
  return runId;
}

/**
 * Track phase start right before pi.sendUserMessage in each launch function.
 */
function trackAndSend(pi: ExtensionAPI, runId: string | undefined, message: string): void {
  pi.sendUserMessage(message);
}

async function launchTicketExecution(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  effectiveConfig?: FeatureFlowConfig,
) {
  // Extract profile from ticket file
  const ticketPath = path.join(specsRoot, feature, "tickets", `${ticketId}.md`);
  let profileName: string | undefined;
  try {
    const ticketContent = await fsPromises.readFile(ticketPath, "utf8");
    const match = ticketContent.match(/^\s*-\s*[Pp]rofile:\s*(\S+)/m);
    profileName = match ? match[1] : undefined;
  } catch {
    // Ticket file not found — no profile
  }

  const config = effectiveConfig ?? (await loadConfig(cwd));
  const tddEnabled = resolveTddEnabled(config);

  if (tddEnabled) {
    await launchTesterPhase(pi, ctx, feature, ticketId, cwd, specsRoot, phase, profileName, config);
  } else {
    await launchWorkerChain(pi, ctx, feature, ticketId, cwd, specsRoot, phase, profileName, config);
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
  profileName?: string,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const testerModelOk = await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "tester", profileName);
  if (!testerModelOk) return;
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const notesPath = testerNotesPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);
  const testerJsonPath = testerHandoffPath(specsRoot, feature, ticketId);

  const message = [
    buildTesterPrompt(feature, ticketId, featureDir, ticketPath, notesPath, logPath, testerJsonPath, resolvedConfig),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const testerPending = { kind: "ticket-tester" as const, feature, ticketId, phase, profileName, cwd, specsRoot };
  setPendingExecution(testerPending);
  await persistCheckpoint(testerPending);
  trackPhaseStart(testerPending);
  if (ctx) updateFeatureFlowStatus(ctx, activeModelLabel ?? formatModelLabel(ctx.model), pi.getThinkingLevel());
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
  profileName?: string,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const workerModelOk = await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "worker", profileName);
  if (!workerModelOk) return;
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);

  const memPath = featureMemoryPath(specsRoot, feature);
  const memExists = await fsPromises.access(memPath).then(() => true).catch(() => false);

  const notesPath = testerNotesPath(specsRoot, feature, ticketId);
  const notesExist = await fsPromises.access(notesPath).then(() => true).catch(() => false);

  const ctxPath = workerContextPath(specsRoot, feature, ticketId);
  const ctxExists = await fsPromises.access(ctxPath).then(() => true).catch(() => false);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);
  const workerJsonPath = workerHandoffPath(specsRoot, feature, ticketId);

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
      workerJsonPath,
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
    profileName,
    cwd,
    specsRoot,
    accumulatedUsage: undefined,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  trackPhaseStart(execPending);
  if (ctx) updateFeatureFlowStatus(ctx, activeModelLabel ?? formatModelLabel(ctx.model), pi.getThinkingLevel());
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
  profileName: string | undefined,
  accumulatedUsage: UsageTotals,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const reviewerModelOk = await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "reviewer", profileName);
  if (!reviewerModelOk) return;

  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const memPath = featureMemoryPath(specsRoot, feature);
  const memExists = await fsPromises.access(memPath).then(() => true).catch(() => false);
  const reviewPath = reviewerNotesPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);
  const reviewerJsonPath = reviewerHandoffPath(specsRoot, feature, ticketId);

  const message = [
    buildReviewerPrompt(
      feature,
      ticketId,
      featureDir,
      ticketPath,
      memExists ? memPath : undefined,
      reviewPath,
      logPath,
      reviewerJsonPath,
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
    profileName,
    cwd,
    specsRoot,
    accumulatedUsage,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  trackPhaseStart(execPending);
  if (ctx) updateFeatureFlowStatus(ctx, activeModelLabel ?? formatModelLabel(ctx.model), pi.getThinkingLevel());
  pi.sendUserMessage(message);
}

async function launchManagerPhase(
  pi: ExtensionAPI,
  ctx: RoleRuntimeContext | undefined,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  profileName: string | undefined,
  accumulatedUsage: UsageTotals,
  config?: Awaited<ReturnType<typeof loadConfig>>,
) {
  const resolvedConfig = config ?? (await loadConfig(cwd));
  const managerModelOk = await applyRoleRuntimeConfig(pi, ctx, resolvedConfig, "manager", profileName);
  if (!managerModelOk) return;

  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const memPath = featureMemoryPath(specsRoot, feature);
  const reviewPath = reviewerNotesPath(specsRoot, feature, ticketId);
  const contextPath = workerContextPath(specsRoot, feature, ticketId);
  const logPath = handoffLogPath(specsRoot, feature, ticketId);
  const managerJsonPath = managerHandoffPath(specsRoot, feature, ticketId);

  const message = [
    buildManagerPrompt(feature, ticketId, featureDir, ticketPath, memPath, reviewPath, contextPath, logPath, managerJsonPath, resolvedConfig),
    "",
    "## Subagent guidance",
    ...buildSubagentGuidance(resolvedConfig, "execution"),
  ].join("\n");

  const execPending = {
    kind: "ticket-execution" as const,
    executionRole: "manager" as const,
    feature,
    ticketId,
    phase,
    profileName,
    cwd,
    specsRoot,
    accumulatedUsage,
  };
  setPendingExecution(execPending);
  await persistCheckpoint(execPending);
  if (ctx) updateFeatureFlowStatus(ctx, activeModelLabel ?? formatModelLabel(ctx.model), pi.getThinkingLevel());
  pi.sendUserMessage(message);
}
