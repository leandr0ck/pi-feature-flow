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
import type { ExecutionChainStep, FeatureTicketFlowConfig, TicketRecord, TicketRunMode, TicketStatus } from "../src/types.js";
import { validateFeature } from "../src/validation.js";

type PendingExecution = {
  feature: string;
  ticketId: string;
  phase: "start" | "resume" | "retry";
  cwd: string;
  specsRoot: string;
  config: FeatureTicketFlowConfig;
};

type ParsedOutcome = {
  status: Extract<TicketStatus, "done" | "blocked" | "needs_fix">;
  note?: string;
};

export default function featureTicketFlow(pi: ExtensionAPI) {
  let pendingExecution: PendingExecution | undefined;

  pi.on("agent_end", async (event, ctx) => {
    const pending = pendingExecution;
    if (!pending || !pending.config.statusParsing.enabled) return;
    pendingExecution = undefined;

    const parsed = parseOutcome(event.messages, pending.config);
    if (!parsed) return;

    try {
      const registry = await loadRegistry(pending.specsRoot, pending.feature, pending.config);
      if (!getTicket(registry, pending.ticketId)) return;

      resolveTicketStatus(registry, pending.ticketId, parsed.status, parsed.note);
      await saveRegistry(pending.specsRoot, pending.feature, pending.config, registry);

      const label = parsed.status === "done" ? "APPROVED" : parsed.status === "blocked" ? "BLOCKED" : "NEEDS-FIX";
      emitInfo(pi, `Auto-updated ${pending.ticketId} for ${pending.feature} from agent result: ${label}${parsed.note ? `\n${parsed.note}` : ""}`);
      ctx.ui.notify(`Ticket ${pending.ticketId}: ${label}`, parsed.status === "blocked" ? "warning" : "info");
    } catch (error: any) {
      ctx.ui.notify(`Could not auto-update ticket status: ${error?.message || String(error)}`, "error");
    }
  });

  pi.registerCommand("init-feature", {
    description: "Scaffold a feature folder with required spec files, tickets directory, and starter ticket",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /init-feature <slug>", "error");
        return;
      }

      const resolved = await getResolvedConfig(ctx.cwd);
      const created = await scaffoldFeature(resolved.specsRoot, slug, resolved.config);
      emitInfo(pi, `Initialized feature ${slug}.\n${created.map((entry) => `- ${entry}`).join("\n")}`);

      const validation = await validateFeature(resolved.specsRoot, slug, resolved.config);
      emitInfo(pi, renderValidation(validation));
    },
  });

  pi.registerCommand("start-feature", {
    description: "Initialize feature execution flow, show status, and start the next available ticket",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Wait until it finishes before starting a feature.", "warning");
        return;
      }

      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;
      if (!(await validateBeforeExecution(pi, feature, resolved.specsRoot, resolved.config, ctx))) return;

      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      emitInfo(pi, renderStatus(registry));

      const choice = await ctx.ui.select(`Feature ${feature}`, ["Start or resume next ticket", "Show status only", "Cancel"]);
      if (!choice || choice === "Cancel" || choice === "Show status only") return;

      await runNextTicketFlow(pi, feature, ctx, (pendingExecutionRef) => {
        pendingExecution = pendingExecutionRef;
      });
    },
  });

  pi.registerCommand("next-ticket", {
    description: "Pick the next planned feature ticket automatically and execute the configured runner",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Wait until it finishes before asking for the next ticket.", "warning");
        return;
      }

      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      await runNextTicketFlow(pi, feature, ctx, (pendingExecutionRef) => {
        pendingExecution = pendingExecutionRef;
      });
    },
  });

  pi.registerCommand("ticket-done", {
    description: "Mark the current in-progress ticket as done without typing the ticket id",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket is currently in progress for ${feature}.`);
        return;
      }

      resolveTicketStatus(registry, current.id, "done");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      emitInfo(pi, `Marked ${current.id} as done for ${feature}.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} marked done`, ["Start next ticket", "Show feature status", "Stop here"]);
      if (nextChoice === "Start next ticket") {
        await runNextTicketFlow(pi, feature, ctx, (pendingExecutionRef) => {
          pendingExecution = pendingExecutionRef;
        });
        return;
      }
      if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(resolved.specsRoot, feature, resolved.config);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-blocked", {
    description: "Mark the current in-progress ticket as blocked without typing the ticket id",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket is currently in progress for ${feature}.`);
        return;
      }

      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "dependency, bug, missing info...");
      resolveTicketStatus(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      emitInfo(pi, `Marked ${current.id} as blocked for ${feature}.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} marked blocked`, ["Try next available ticket", "Show feature status", "Stop here"]);
      if (nextChoice === "Try next available ticket") {
        await runNextTicketFlow(pi, feature, ctx, (pendingExecutionRef) => {
          pendingExecution = pendingExecutionRef;
        });
        return;
      }
      if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(resolved.specsRoot, feature, resolved.config);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-needs-fix", {
    description: "Mark the current in-progress ticket as needs-fix and optionally retry it",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
      if (!current) {
        emitInfo(pi, `No ticket is currently in progress for ${feature}.`);
        return;
      }

      const note = await ctx.ui.input(`What still needs fixing in ${current.id}?`, "tests failing, edge cases, follow-up...");
      resolveTicketStatus(registry, current.id, "needs_fix", note || "Needs more work");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      emitInfo(pi, `Marked ${current.id} as needs-fix for ${feature}.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} marked needs-fix`, ["Retry now", "Show feature status", "Stop here"]);
      if (nextChoice === "Retry now") {
        startTicketRun(registry, current.id, "retry");
        await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
        await launchTicketExecution(pi, feature, current.id, resolved.config, ctx.cwd, resolved.specsRoot, "retry", (pendingExecutionRef) => {
          pendingExecution = pendingExecutionRef;
        });
        return;
      }
      if (nextChoice === "Show feature status") {
        const refreshed = await loadRegistry(resolved.specsRoot, feature, resolved.config);
        emitInfo(pi, renderStatus(refreshed));
      }
    },
  });

  pi.registerCommand("ticket-status", {
    description: "Show feature ticket progress from the registry",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;
      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      emitInfo(pi, renderStatus(registry));
    },
  });

  pi.registerCommand("ticket-validate", {
    description: "Validate required spec files, dependency graph, and ticket structure for a feature",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      const validation = await validateFeature(resolved.specsRoot, feature, resolved.config);
      emitInfo(pi, renderValidation(validation));
    },
  });
}

async function getResolvedConfig(cwd: string) {
  const config = await loadConfig(cwd);
  const specsRoot = resolveSpecsRoot(cwd, config);
  return { config, specsRoot };
}

async function runNextTicketFlow(pi: ExtensionAPI, feature: string, ctx: any, setPending: (pending: PendingExecution) => void) {
  const resolved = await getResolvedConfig(ctx.cwd);
  if (!(await validateBeforeExecution(pi, feature, resolved.specsRoot, resolved.config, ctx))) return;

  const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
  const current = registry.tickets.find((ticket) => ticket.status === "in_progress");

  if (current) {
    const choice = await ctx.ui.select(`Feature ${feature} already has a ticket in progress`, [
      `Resume ${current.id}`,
      `Mark ${current.id} done and start next`,
      `Mark ${current.id} needs-fix and retry later`,
      `Mark ${current.id} blocked and start next`,
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return;
    if (choice.startsWith("Resume ")) {
      startTicketRun(registry, current.id, "resume");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      await launchTicketExecution(pi, feature, current.id, resolved.config, ctx.cwd, resolved.specsRoot, "resume", setPending);
      return;
    }
    if (choice.includes("done")) {
      resolveTicketStatus(registry, current.id, "done");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
    }
    if (choice.includes("needs-fix")) {
      const note = await ctx.ui.input(`What still needs fixing in ${current.id}?`, "tests failing, edge cases, follow-up...");
      resolveTicketStatus(registry, current.id, "needs_fix", note || "Needs more work");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
    }
    if (choice.includes("blocked")) {
      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "dependency, bug, missing info...");
      resolveTicketStatus(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
    }
  }

  const refreshed = await loadRegistry(resolved.specsRoot, feature, resolved.config);
  const next = findNextAvailableTicket(refreshed);
  if (!next) {
    const blockedPending = refreshed.tickets.filter((ticket) => (ticket.status === "pending" || ticket.status === "needs_fix") && !areDependenciesDone(ticket, refreshed));
    if (blockedPending.length > 0) {
      const lines = blockedPending.slice(0, 10).map((ticket) => {
        const missing = ticket.dependencies.filter((dep) => getTicket(refreshed, dep)?.status !== "done");
        return `- ${ticket.id} waiting for ${missing.join(", ")}`;
      });
      emitInfo(pi, `No tickets are ready to run for ${feature}.\n\nBlocked pending tickets:\n${lines.join("\n")}`);
      return;
    }

    emitInfo(pi, `No pending or retryable tickets remain for ${feature}.`);
    return;
  }

  const mode: TicketRunMode = next.status === "needs_fix" ? "retry" : "start";
  startTicketRun(refreshed, next.id, mode);
  await saveRegistry(resolved.specsRoot, feature, resolved.config, refreshed);
  emitInfo(pi, `Starting ${next.id} — ${next.title}`);
  await launchTicketExecution(pi, feature, next.id, resolved.config, ctx.cwd, resolved.specsRoot, mode === "retry" ? "retry" : "start", setPending);
}

async function launchTicketExecution(
  pi: ExtensionAPI,
  feature: string,
  ticketId: string,
  config: FeatureTicketFlowConfig,
  cwd: string,
  specsRoot: string,
  phase: "start" | "resume" | "retry",
  setPending: (pending: PendingExecution) => void,
) {
  const message = buildExecutionMessage(feature, ticketId, config, phase);
  const pending: PendingExecution = { feature, ticketId, phase, cwd, specsRoot, config };
  if (setPending) setPending(pending);
  pi.sendUserMessage(message);
}

function buildExecutionMessage(feature: string, ticketId: string, config: FeatureTicketFlowConfig, phase: "start" | "resume" | "retry") {
  const chainJson = JSON.stringify(
    (config.executionChain || []).map((step) => ({
      agent: step.agent,
      task: applyTemplate(step.task, feature, ticketId, config, phase, buildSubagentChainJson(config.executionChain || [], feature, ticketId, config, phase)),
    } satisfies ExecutionChainStep)),
    null,
    2,
  );

  const template = config.executionPromptTemplates?.[phase] || config.executionPromptTemplate;
  if (template) {
    return applyTemplate(template, feature, ticketId, config, phase, chainJson);
  }

  if (config.executionMode === "command-message") {
    return `/${config.executionTarget} feature=${feature}; ticket=${ticketId}`;
  }

  if (config.executionMode === "custom-message") {
    return [`feature=${feature}`, `ticket=${ticketId}`, config.executionStatusRequest].join("\n");
  }

  if (config.executionMode === "subagent-chain") {
    return [
      "Use the subagent tool now with this exact chain configuration:",
      chainJson,
      `Context: feature=${feature}; ticket=${ticketId}`,
      "Execute only that ticket.",
      config.executionStatusRequest,
    ].join("\n");
  }

  return [
    `Use the project chain \"${config.executionTarget}\" now.`,
    `Input: feature=${feature}; ticket=${ticketId}`,
    `Phase: ${phase}`,
    "Execute only that ticket.",
    config.executionStatusRequest,
  ].join("\n");
}

async function resolveFeatureSlug(args: string, specsRoot: string, title: string, ctx: any): Promise<string | undefined> {
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
  return getResolvedConfig(process.cwd()).then(async ({ specsRoot }) => {
    const features = await listFeatureSlugs(specsRoot);
    const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
    return items.length > 0 ? items : null;
  });
}

async function validateBeforeExecution(pi: ExtensionAPI, feature: string, specsRoot: string, config: FeatureTicketFlowConfig, ctx: any) {
  const validation = await validateFeature(specsRoot, feature, config);
  if (validation.valid) return true;

  emitInfo(pi, renderValidation(validation));
  ctx.ui.notify(`Feature ${feature} failed validation. Run /ticket-validate ${feature} for details.`, "warning");
  return false;
}

function applyTemplate(
  template: string,
  feature: string,
  ticketId: string,
  config: FeatureTicketFlowConfig,
  phase: "start" | "resume" | "retry",
  chainJson: string,
  reason = "",
) {
  return template
    .replaceAll("{target}", config.executionTarget)
    .replaceAll("{feature}", feature)
    .replaceAll("{ticket}", ticketId)
    .replaceAll("{status_request}", config.executionStatusRequest)
    .replaceAll("{phase}", phase)
    .replaceAll("{reason}", reason)
    .replaceAll("{chain_json}", chainJson);
}

function buildSubagentChainJson(
  steps: ExecutionChainStep[],
  feature: string,
  ticketId: string,
  config: FeatureTicketFlowConfig,
  phase: "start" | "resume" | "retry",
) {
  return JSON.stringify(
    steps.map((step) => ({
      agent: step.agent,
      task: applyTemplate(step.task, feature, ticketId, config, phase, ""),
    })),
    null,
    2,
  );
}

function parseOutcome(messages: any[], config: FeatureTicketFlowConfig): ParsedOutcome | undefined {
  const assistantTexts = messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => (message.content || []).filter((part: any) => part.type === "text").map((part: any) => part.text as string))
    .slice(-config.statusParsing.maxMessagesToInspect)
    .reverse();

  for (const text of assistantTexts) {
    const blocked = findKeywordLine(text, config.statusParsing.blocked);
    if (blocked) return { status: "blocked", note: blocked };

    const needsFix = findKeywordLine(text, config.statusParsing.needsFix);
    if (needsFix) return { status: "needs_fix", note: needsFix };

    const approved = findKeywordLine(text, config.statusParsing.approved);
    if (approved) return { status: "done", note: approved };
  }

  return undefined;
}

function findKeywordLine(text: string, keywords: string[]) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const keyword of keywords) {
    const regex = new RegExp(`(^|\\b)${escapeRegExp(keyword)}(\\b|$)`, "i");
    const exactLine = lines.find((line) => regex.test(line));
    if (exactLine) return exactLine;
    if (regex.test(text)) return keyword;
  }
  return undefined;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function scaffoldFeature(specsRoot: string, feature: string, config: FeatureTicketFlowConfig) {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, config.ticketsDirName);
  await fs.mkdir(ticketsDir, { recursive: true });

  const created: string[] = [];
  for (const requiredFile of config.requiredSpecFiles) {
    const absolutePath = path.join(featureDir, requiredFile);
    if (await pathExists(absolutePath)) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, scaffoldFileTemplate(requiredFile, feature), "utf8");
    created.push(path.relative(specsRoot, absolutePath));
  }

  if (config.scaffold.createStarterTicket) {
    const starterTicketPath = path.join(ticketsDir, `${config.scaffold.starterTicketId}.md`);
    if (!(await pathExists(starterTicketPath))) {
      await fs.writeFile(
        starterTicketPath,
        `# ${config.scaffold.starterTicketId} — ${config.scaffold.starterTicketTitle}\n\n## Goal\nDescribe the first thin slice for ${feature}.\n\n- Requires: none\n\n## Acceptance Criteria\n- Define one verifiable outcome for this first ticket.\n`,
        "utf8",
      );
      created.push(path.relative(specsRoot, starterTicketPath));
    }
  }

  return created;
}

function scaffoldFileTemplate(fileName: string, feature: string) {
  if (fileName.startsWith("01-")) {
    return `# ${feature} master spec\n\n## Goal\nDescribe the feature goal.\n\n## Context\nWhy this feature exists and what constraints matter.\n\n## Acceptance Criteria\n- Add machine-testable acceptance criteria here.\n`;
  }

  if (fileName.startsWith("02-")) {
    return `# ${feature} execution plan\n\n## Planned Tickets\n- ${feature}: break the work into tickets under ./tickets\n\n## Notes\n- Keep ticket scope small and dependency-aware.\n`;
  }

  return `# ${feature}\n\nAdd content for ${fileName}.\n`;
}

async function pathExists(targetPath: string) {
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
