import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  loadConfig,
  resolveAuthoringSkills,
  resolveSpecsRoot,
  resolveTddEnabled,
} from "../src/config.js";
import {
  areDependenciesDone,
  findNextAvailableTicket,
  getTicket,
  loadRegistry,
  resolveTicketStatus,
  saveRegistry,
  startTicketRun,
} from "../src/registry.js";
import { renderStatus, renderValidation } from "../src/render.js";
import {
  maybeContinuePlanning,
  resolveFeatureSlug,
  validateBeforeExecution,
} from "../src/feature-flow/guards.js";
import {
  buildFeaturePlanningPrompt,
  buildFeatureRevisionPrompt,
  buildSubagentGuidance,
  resolveProfileForFeature,
} from "../src/feature-flow/prompts.js";
import {
  deriveFeatureSlug,
  ensureUniqueFeatureSlug,
  scaffoldFeature,
} from "../src/feature-flow/scaffold.js";
import {
  emitInfo,
  getPendingExecution,
  outcomeLabel,
  parseOutcome,
  setPendingExecution,
} from "../src/feature-flow/state.js";
import { createFeatureCompletions } from "../src/feature-flow/ui.js";
import {
  canExecuteFeature,
  formatReviewSummary,
  getFeatureReviewDocuments,
  markReviewPending,
} from "../src/feature-flow/review.js";
import { openFeatureReview } from "./feature-review-viewer.js";
import { validateFeature } from "../src/validation.js";

type CommandContext = {
  cwd: string;
  isIdle: () => boolean;
  ui: {
    notify: Function;
    select: Function;
    input: Function;
  };
};

type FeatureFlowContext = {
  cwd?: string;
  ui: {
    notify: Function;
  };
};

export default function featureTicketFlow(pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const pending = getPendingExecution();
    if (!pending) return;

    setPendingExecution(undefined);
    const parsed = parseOutcome(event.messages);
    if (!parsed) return;

    try {
      if (pending.kind === "feature-plan" || pending.kind === "feature-revision") {
        const isRevision = pending.kind === "feature-revision";
        const label = outcomeLabel(parsed.status);
        emitInfo(pi, `${isRevision ? "Feature revision" : "Feature planning"} for ${pending.feature}: ${label}${parsed.note ? `\n${parsed.note}` : ""}`);

        if (parsed.status !== "done") {
          ctx.ui.notify(
            `${isRevision ? "Feature revision" : "Feature planning"} for ${pending.feature}: ${label}`,
            parsed.status === "blocked" ? "warning" : "info",
          );
          return;
        }

        const validation = await validateFeature(pending.specsRoot, pending.feature);
        emitInfo(pi, renderValidation(validation));
        if (!validation.valid) {
          ctx.ui.notify(`Feature ${pending.feature} was ${isRevision ? "revised" : "planned"} but failed validation.`, "warning");
          return;
        }

        // Do NOT load the ticket registry or create ticket records here.
        // Only show spec/plan docs for review — tickets are created AFTER user approval.
        const docs = await getFeatureReviewDocuments(pending.specsRoot, pending.feature);

        ctx.ui.notify(`Feature ${pending.feature} ${isRevision ? "revised" : "planned"}. Opening review viewer...`, "info");
        emitInfo(pi, [
          `Feature ${isRevision ? "revision" : "planning"} for **${pending.feature}**: APPROVED`,
          "",
          isRevision
            ? "The spec package was updated from review feedback and is ready for another pass."
            : "The spec and execution plan are ready for your review.",
          docs.length > 0
            ? `Documents ready: ${docs.map((d) => d.label).join(", ")}`
            : "No documents found.",
          "",
          "Opening review viewer in browser...",
        ].join("\n"));

        const result = await openFeatureReview(pi, pending.feature, pending.specsRoot);

        if (result?.action === "approved") {
          // NOW create the ticket registry — only after user approval.
          const registry = await loadRegistry(pending.specsRoot, pending.feature);
          markReviewPending(pending.specsRoot, pending.feature, registry);
          registry.review!.status = "approved";
          registry.review!.reviewedAt = new Date().toISOString();
          registry.review!.lastAction = "approve";
          await saveRegistry(pending.specsRoot, pending.feature, registry);
          emitInfo(pi, [
            `Feature **${pending.feature}** approved.`,
            "",
            `Tickets registered: ${registry.tickets.length}`,
            "",
            "Starting implementation automatically ticket by ticket.",
            "",
            renderStatus(registry),
          ].join("\n"));
          ctx.ui.notify(`Feature ${pending.feature} approved. ${registry.tickets.length} tickets registered. Starting implementation...`, "info");
          await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot);
        } else if (result?.action === "changes_requested") {
          emitInfo(pi, [
            `Feature **${pending.feature}**: changes requested.`,
            "",
            `Feedback: ${result.comment}`,
            "",
            "You can revise the docs now or later.",
          ].join("\n"));
          const choice = await ctx.ui.select(`Feature ${pending.feature} needs changes`, [
            "Revise docs now",
            "Leave for manual revision",
          ]);
          if (choice === "Revise docs now") {
            await reviseFeatureFromFeedback(pi, pending.feature, pending.specsRoot, pending.cwd, result.comment);
          }
        } else {
          emitInfo(pi, [
            `Feature **${pending.feature}** is pending review.`,
            "",
            `Run \`/review-feature ${pending.feature}\` to open the viewer.`,
            "Run \`/approve-feature ${pending.feature}\` for quick approval.",
            "Run \`/request-feature-changes ${pending.feature} <comment>\` to request changes.",
            "Run \`/revise-feature ${pending.feature} <feedback>\` to apply review feedback with the agent.",
          ].join("\n"));
        }
        return;
      }

      const registry = await loadRegistry(pending.specsRoot, pending.feature);
      const ticket = getTicket(registry, pending.ticketId);
      if (!ticket) return;

      resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
      await saveRegistry(pending.specsRoot, pending.feature, registry);

      const label = outcomeLabel(parsed.status);
      emitInfo(pi, `Auto-updated ${pending.ticketId} for ${pending.feature}: ${label}${parsed.note ? `\n${parsed.note}` : ""}`);
      ctx.ui.notify(`Ticket ${pending.ticketId}: ${label}`, parsed.status === "blocked" ? "warning" : "info");

      if (parsed.status === "done") {
        await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not auto-update ticket: ${message}`, "error");
    }
  });

  pi.registerCommand("feature", {
    description: "Create a feature from a natural-language description and start the workflow",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /feature <describe the functionality>", "error");
        return;
      }

      await startFeatureFromDescription(pi, description, ctx);
    },
  });

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
      const created = await scaffoldFeature(specsRoot, slug, true);
      emitInfo(pi, `Initialized ${slug}.\n${created.map((entry) => `- ${entry}`).join("\n")}`);

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

      if (await maybeContinuePlanning(pi, feature, specsRoot, ctx)) return;
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

      if (await maybeContinuePlanning(pi, feature, specsRoot, ctx)) return;
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

  pi.registerCommand("ticket-blocked", {
    description: "Mark the current in-progress ticket as blocked",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
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
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
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
        await launchTicketExecution(pi, feature, current.id, ctx.cwd, specsRoot, "retry", current.profileName, registry.profileName);
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

  pi.registerCommand("revise-feature", {
    description: "Revise planned feature docs from review feedback and reopen review",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const trimmed = args.trim();
      const [featureArg, ...feedbackParts] = trimmed ? trimmed.split(/\s+/) : [];
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const feature = await resolveFeatureSlug(featureArg || "", specsRoot, "Choose feature", ctx);
      if (!feature) return;

      let feedback = feedbackParts.join(" ").trim();
      if (!feedback) {
        feedback = await ctx.ui.input(
          `What should change in ${feature}?`,
          "Describe the review feedback to apply to the docs and tickets...",
        ) || "";
      }

      if (!feedback.trim()) {
        ctx.ui.notify("Feedback is required to revise a feature.", "warning");
        return;
      }

      await reviseFeatureFromFeedback(pi, feature, specsRoot, ctx.cwd, feedback.trim());
    },
  });

  pi.registerCommand("feature-profile", {
    description: "Show or set the execution profile for a feature",
    getArgumentCompletions: async (prefix: string) => {
      const config = await loadConfig(process.cwd());
      const profiles = Object.keys(config.profiles || {});
      const parts = prefix.trim().split(/\s+/);
      if (parts.length === 1) {
        return createFeatureCompletions(parts[0]);
      }
      const matched = profiles
        .filter((profile) => profile.startsWith(parts[1]))
        .map((profile) => ({ value: `${parts[0]} ${profile}`, label: profile }));
      return matched.length > 0 ? matched : null;
    },
    handler: async (args, ctx) => {
      const config = await loadConfig(ctx.cwd);
      const specsRoot = resolveSpecsRoot(ctx.cwd, config);
      const parts = args.trim().split(/\s+/);
      const featureArg = parts[0];
      const profileArg = parts[1];

      const feature = await resolveFeatureSlug(featureArg, specsRoot, "Choose feature", ctx);
      if (!feature) return;

      const registry = await loadRegistry(specsRoot, feature);
      const current = registry.profileName || "(none — tickets must declare - Profile:, otherwise default profile is used as fallback)";

      if (!profileArg) {
        emitInfo(
          pi,
          [
            `Current profile for **${feature}**: ${current}`,
            "",
            "Available profiles:",
            ...Object.keys(config.profiles || { default: {} }).map((profile) => `  - ${profile}`),
            "",
            `Usage: /feature-profile ${feature} <profile>`,
          ].join("\n"),
        );
        return;
      }

      const validProfiles = Object.keys(config.profiles || {});
      if (!validProfiles.includes(profileArg)) {
        ctx.ui.notify(`Unknown profile "${profileArg}". Available: ${validProfiles.join(", ")}`, "error");
        return;
      }

      registry.profileName = profileArg;
      await saveRegistry(specsRoot, feature, registry);

      emitInfo(pi, `Profile for **${feature}** set to **${profileArg}**.`);
      ctx.ui.notify(`Profile for ${feature} updated to ${profileArg}.`, "info");
    },
  });
}

async function runNextTicketFlow(pi: ExtensionAPI, feature: string, ctx: CommandContext) {
  const config = await loadConfig(ctx.cwd);
  const specsRoot = resolveSpecsRoot(ctx.cwd, config);
  if (!(await validateBeforeExecution(pi, feature, specsRoot, ctx))) return;

  const registry = await loadRegistry(specsRoot, feature);

  // Gate: feature must be approved before executing tickets
  if (!canExecuteFeature(registry)) {
    const reviewStatus = registry.review?.status ?? "not_reviewed";
    emitInfo(pi, [
      `Feature **${feature}** requires approval before ticket execution.`,
      "",
      `Review status: ${reviewStatus}`,
      "",
      formatReviewSummary(registry),
      "",
      `Run \`/review-feature ${feature}\` to review and approve,`,
      `or \`/approve-feature ${feature}\` for quick approval.`,
    ].join("\n"));
    ctx.ui.notify(`Feature ${feature} requires approval before execution. Run /review-feature ${feature}.`, "warning");
    return;
  }
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
      await launchTicketExecution(pi, feature, current.id, ctx.cwd, specsRoot, "resume", current.profileName, registry.profileName);
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

  await startPreparedNextTicket(pi, feature, ctx.cwd, specsRoot);
}

async function startPreparedNextTicket(pi: ExtensionAPI, feature: string, cwd: string, specsRoot: string) {
  const refreshed = await loadRegistry(specsRoot, feature);
  const next = findNextAvailableTicket(refreshed);

  if (!next) {
    const blockedPending = refreshed.tickets.filter((ticket) =>
      (ticket.status === "pending" || ticket.status === "needs_fix") && !areDependenciesDone(ticket, refreshed),
    );
    if (blockedPending.length > 0) {
      const lines = blockedPending.slice(0, 10).map((ticket) => {
        const missing = ticket.dependencies.filter((dependency) => getTicket(refreshed, dependency)?.status !== "done");
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
  await launchTicketExecution(pi, feature, next.id, cwd, specsRoot, mode, next.profileName, refreshed.profileName);
}

async function launchTicketExecution(
  pi: ExtensionAPI,
  feature: string,
  ticketId: string,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  ticketProfileName?: string,
  featureProfileName?: string,
) {
  const featureDir = path.join(specsRoot, feature);
  const ticketPath = path.join(featureDir, "tickets", `${ticketId}.md`);
  const masterSpecPath = path.join(featureDir, "01-master-spec.md");
  const executionPlanPath = path.join(featureDir, "02-execution-plan.md");
  const config = await loadConfig(cwd);
  const { name: profileName, profile } = resolveProfileForFeature(config, ticketProfileName, featureProfileName);
  const tddEnabled = resolveTddEnabled(config);

  const message = [
    `Run the bundled agent-driven ticket workflow for feature \"${feature}\" and ticket \"${ticketId}\".`,
    `Phase: ${phase}`,
    `Execution profile: ${profileName}`,
    "Prefer the bundled `feature-execution` skill if it is available.",
    ...buildSubagentGuidance(profile, "execution"),
    "Execute only this ticket. Do not rewrite unrelated tickets.",
    "Read these files first:",
    `- ${masterSpecPath}`,
    `- ${executionPlanPath}`,
    `- ${ticketPath}`,
    "Execution rules:",
    "- Implement the smallest vertical slice that satisfies the ticket.",
    ...(tddEnabled
      ? [
          "- TDD is enabled for this project. Prefer red-green-refactor for this ticket.",
          "- Write or update the relevant failing test(s) first when feasible, then implement the minimum code to make them pass.",
          "- Prefer the available `tdd-guide` skill if it exists.",
        ]
      : []),
    "- Update code, tests, and docs only as needed for this ticket.",
    "- If you discover required follow-up work, record it in the ticket or execution plan without expanding scope.",
    "- Run targeted verification where possible.",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");

  setPendingExecution({ kind: "ticket-execution", feature, ticketId, phase, cwd, specsRoot });
  pi.sendUserMessage(message);
}

async function reviseFeatureFromFeedback(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
  cwd: string,
  feedback: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  const authoringSkills = resolveAuthoringSkills(config);
  const tddEnabled = resolveTddEnabled(config);
  const availableProfiles = Object.keys(config.profiles || { default: {} });

  emitInfo(pi, [
    `Revising feature **${feature}** from review feedback.`,
    "",
    `Feedback: ${feedback}`,
  ].join("\n"));

  setPendingExecution({ kind: "feature-revision", feature, cwd, specsRoot, feedback });
  pi.sendUserMessage(buildFeatureRevisionPrompt(feature, specsRoot, feedback, authoringSkills, tddEnabled, availableProfiles));
}

async function startFeatureFromDescription(
  pi: ExtensionAPI,
  description: string,
  ctx: FeatureFlowContext,
): Promise<boolean> {
  const trimmed = description.trim();
  if (!trimmed) return false;

  const cwd = ctx.cwd || process.cwd();
  const config = await loadConfig(cwd);
  const specsRoot = resolveSpecsRoot(cwd, config);
  const baseSlug = deriveFeatureSlug(trimmed);
  const feature = await ensureUniqueFeatureSlug(specsRoot, baseSlug);
  const created = await scaffoldFeature(specsRoot, feature, false);
  const authoringSkills = resolveAuthoringSkills(config);
  const tddEnabled = resolveTddEnabled(config);

  emitInfo(pi, `Initialized ${feature}.\n${created.map((entry) => `- ${entry}`).join("\n")}`);
  ctx.ui.notify(`Created feature ${feature}. Planning spec and tickets...`, "info");

  setPendingExecution({ kind: "feature-plan", feature, cwd, specsRoot });
  pi.sendUserMessage(buildFeaturePlanningPrompt(feature, specsRoot, trimmed, config, authoringSkills, tddEnabled));
  return true;
}
