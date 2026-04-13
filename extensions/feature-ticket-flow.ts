import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, renderAgentPreferences, resolveAuthoringSkills, resolveExecutionProfile, resolveExecutionProfileByName, resolveSpecsRoot, resolveTddEnabled } from "../src/config.js";
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

let pendingExecution:
  | {
      kind: "feature-plan";
      feature: string;
      cwd: string;
      specsRoot: string;
    }
  | {
      kind: "ticket-execution";
      feature: string;
      ticketId: string;
      phase: "start" | "resume" | "retry";
      cwd: string;
      specsRoot: string;
    }
  | undefined;

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
      if (pending.kind === "feature-plan") {
        const label = parsed.status === "done" ? "APPROVED" : parsed.status === "blocked" ? "BLOCKED" : "NEEDS-FIX";
        emitInfo(pi, `Feature planning for ${pending.feature}: ${label}${parsed.note ? `\n${parsed.note}` : ""}`);

        if (parsed.status !== "done") {
          ctx.ui.notify(`Feature planning for ${pending.feature}: ${label}`, parsed.status === "blocked" ? "warning" : "info");
          return;
        }

        const validation = await validateFeature(pending.specsRoot, pending.feature);
        emitInfo(pi, renderValidation(validation));
        if (!validation.valid) {
          ctx.ui.notify(`Feature ${pending.feature} was planned but failed validation.`, "warning");
          return;
        }

        await loadRegistry(pending.specsRoot, pending.feature);

        ctx.ui.notify(`Feature ${pending.feature} planned. Starting first ticket...`, "info");
        await startPreparedNextTicket(pi, pending.feature, pending.cwd, pending.specsRoot);
        return;
      }

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
        .filter((p) => p.startsWith(parts[1]))
        .map((p) => ({ value: `${parts[0]} ${p}`, label: p }));
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
        const profileLines = [
          `Current profile for **${feature}**: ${current}`,
          "",
          "Available profiles:",
          ...Object.keys(config.profiles || { default: {} }).map((p) => `  - ${p}`),
          "",
          `Usage: /feature-profile ${feature} <profile>`,
        ];
        emitInfo(pi, profileLines.join("\n"));
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
  const resolvedProfile = resolveProfileForFeature(config, ticketProfileName, featureProfileName);
  const { name: profileName, profile } = resolvedProfile;
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

  pendingExecution = { kind: "ticket-execution", feature, ticketId, phase, cwd, specsRoot };
  pi.sendUserMessage(message);
}

type FeatureFlowContext = {
  cwd?: string;
  ui: {
    notify: Function;
  };
};

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
  const created = await scaffoldFeature(specsRoot, feature);
  const authoringSkills = resolveAuthoringSkills(config);
  const tddEnabled = resolveTddEnabled(config);

  emitInfo(pi, `Initialized ${feature}.\n${created.map((p) => `- ${p}`).join("\n")}`);
  ctx.ui.notify(`Created feature ${feature}. Planning spec and tickets...`, "info");

  pendingExecution = { kind: "feature-plan", feature, cwd, specsRoot };
  pi.sendUserMessage(buildFeaturePlanningPrompt(feature, specsRoot, trimmed, config, authoringSkills, tddEnabled));
  return true;
}

function buildFeaturePlanningPrompt(
  feature: string,
  specsRoot: string,
  description: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  authoringSkills: ReturnType<typeof resolveAuthoringSkills>,
  tddEnabled: boolean,
): string {
  const featureDir = path.join(specsRoot, feature);
  const availableProfiles = Object.keys(config.profiles || { default: {} });
  return [
    `Run the bundled agent-driven feature intake workflow for feature "${feature}".`,
    `Feature directory: ${featureDir}`,
    "User request:",
    description,
    "",
    "Primary goal:",
    "- Turn the user's description into a complete feature package with a master spec, execution plan, and implementation tickets.",
    "",
    "Required outputs:",
    `- ${path.join(featureDir, "01-master-spec.md")}`,
    `- ${path.join(featureDir, "02-execution-plan.md")}`,
    `- ticket files under ${path.join(featureDir, "tickets")}`,
    "",
    "Workflow guidance:",
    "- Prefer the bundled `feature-planning` and `feature-execution` skills if they are available.",
    `- Authoring skill defaults (override per project via authoringSkills in config):`,
    `  - productRequirementsSkill: "${authoringSkills.productRequirementsSkill}"`,
    `  - requirementsRefinementSkill: "${authoringSkills.requirementsRefinementSkill}"`,
    `  - technicalDesignSkill: "${authoringSkills.technicalDesignSkill}"`,
    "",
    `- TDD enabled: ${tddEnabled ? "true" : "false"}`,
    "",
    "Skill routing by feature complexity:",
    "- Simple feature → use productRequirementsSkill.",
    "- Medium feature → use productRequirementsSkill + requirementsRefinementSkill.",
    "- Complex system → use productRequirementsSkill + requirementsRefinementSkill + technicalDesignSkill.",
    "",
    "Treat `01-master-spec.md` as the principal document: PRD Lite for simple work, PRD-first master spec for medium/complex work.",
    "",
    "Planning rules:",
    "- Classify the request as simple, medium, or complex before writing specs.",
    "- Write a concise but actionable master spec.",
    "- Keep the master spec product-readable first; move deep implementation detail into technical notes or derived technical sections when needed.",
    "- Write an execution plan with clear sequencing and risks.",
    ...(tddEnabled
      ? [
          "- Because TDD is enabled, include test expectations in the execution plan and tickets where relevant.",
          "- Prefer tickets that keep the red-green-refactor loop small and local to each slice.",
        ]
      : []),
    "- Create small, dependency-aware tickets as thin vertical slices.",
    "- Every ticket must include a `- Requires:` line.",
    "- Every ticket must include a `- Profile:` line with exactly one execution profile name.",
    `- Allowed ticket profiles: ${availableProfiles.join(", ")}`,
    "- Use STK-001, STK-002, ... ticket ids.",
    "- Keep all generated files inside the feature directory only.",
    "",
    "Do not implement application code yet unless the planning workflow truly requires a tiny probe. Focus on producing the feature package.",
    "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  ].join("\n");
}


function resolveProfileForFeature(
  config: Awaited<ReturnType<typeof loadConfig>>,
  ticketProfileName?: string,
  featureProfileName?: string,
): ReturnType<typeof resolveExecutionProfile> {
  if (ticketProfileName && config.profiles?.[ticketProfileName]) {
    return resolveExecutionProfileByName(config, ticketProfileName);
  }
  if (featureProfileName && config.profiles?.[featureProfileName]) {
    return resolveExecutionProfileByName(config, featureProfileName);
  }
  return resolveExecutionProfileByName(config, config.defaultProfile || "default");
}

function buildSubagentGuidance(
  profile: ReturnType<typeof resolveExecutionProfile>["profile"],
  phase: "planning" | "execution",
): string[] {
  const preferences = renderAgentPreferences(profile);
  if (profile.preferSubagents === false) {
    return [
      "- This profile disables subagent delegation. Work directly with read/write/edit/bash.",
      ...(preferences.length > 0 ? ["- Preferred agent settings for equivalent direct execution:", ...preferences] : []),
    ];
  }

  return [
    "- If the `subagent` tool is available from the bundled pi-subagents dependency, prefer subagent delegation.",
    `- Preferred ${phase} chain order: planner -> worker -> reviewer.`,
    ...(preferences.length > 0 ? ["- Use these configured agent/model preferences when delegating:", ...preferences] : []),
    "- If subagents are unavailable, do the work directly with read/write/edit/bash.",
  ];
}

function deriveFeatureSlug(description: string): string {
  const stopWords = new Set([
    "a", "an", "and", "the", "for", "with", "that", "this", "from", "into", "your", "our", "user", "users",
    "need", "needs", "want", "wants", "build", "create", "implement", "add", "support", "feature", "flow",
    "quiero", "necesito", "crear", "agregar", "implementar", "para", "con", "una", "uno", "que", "los", "las",
  ]);

  const tokens = description
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !stopWords.has(token));

  const core = (tokens.length > 0 ? tokens : description.toLowerCase().split(/\s+/).filter(Boolean))
    .slice(0, 6)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return core || `feature-${new Date().toISOString().slice(0, 10)}`;
}

async function ensureUniqueFeatureSlug(specsRoot: string, baseSlug: string): Promise<string> {
  let candidate = baseSlug;
  let index = 2;
  while (await pathExists(path.join(specsRoot, candidate))) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }
  return candidate;
}

// ─── Validation ───────────────────────────────────────────────────────────────

async function validateBeforeExecution(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
  ctx: { cwd?: string; ui: { notify: Function } },
): Promise<boolean> {
  const validation = await validateFeature(specsRoot, feature);
  if (!validation.valid) {
    emitInfo(pi, renderValidation(validation));
    ctx.ui.notify(`Feature ${feature} failed validation. Run /ticket-validate ${feature} for details.`, "warning");
    return false;
  }

  const config = await loadConfig(ctx.cwd || process.cwd());
  const validProfiles = new Set(Object.keys(config.profiles || { default: {} }));
  const registry = await loadRegistry(specsRoot, feature);
  const invalidProfiles = registry.tickets.filter((ticket) => ticket.profileName && !validProfiles.has(ticket.profileName));

  if (invalidProfiles.length > 0) {
    const details = invalidProfiles.map((ticket) => `- ${ticket.id}: unknown profile ${ticket.profileName}`).join("\n");
    emitInfo(pi, `Feature: ${feature}\nValidation: failed\n\nErrors:\n${details}`);
    ctx.ui.notify(`Feature ${feature} has tickets with unknown profiles.`, "warning");
    return false;
  }

  return true;
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
      `# ${starterId} — Initial implementation slice\n\n## Goal\nDescribe the first thin slice for ${feature}.\n\n- Profile: default\n- Requires: none\n\n## Acceptance Criteria\n- Define one verifiable outcome for this first ticket.\n`,
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
