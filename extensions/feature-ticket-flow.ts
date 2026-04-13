import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveSpecsRoot } from "../src/config";
import {
  areDependenciesDone,
  findNextAvailableTicket,
  getTicket,
  listFeatureSlugs,
  loadRegistry,
  markTicket,
  saveRegistry,
} from "../src/registry";
import { renderStatus } from "../src/render";

export default function featureTicketFlow(pi: ExtensionAPI) {
  pi.registerCommand("start-feature", {
    description: "Initialize feature execution flow, show status, and start the next available ticket",
    getArgumentCompletions: async (prefix: string) => {
      const { specsRoot } = await getResolvedConfig(process.cwd());
      const features = await listFeatureSlugs(specsRoot);
      const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Wait until it finishes before starting a feature.", "warning");
        return;
      }

      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      emitInfo(pi, renderStatus(registry));

      const choice = await ctx.ui.select(`Feature ${feature}`, ["Start or resume next ticket", "Show status only", "Cancel"]);
      if (!choice || choice === "Cancel" || choice === "Show status only") return;

      await runNextTicketFlow(pi, feature, ctx);
    },
  });

  pi.registerCommand("next-ticket", {
    description: "Pick the next planned feature ticket automatically and execute the configured runner",
    getArgumentCompletions: async (prefix: string) => {
      const { specsRoot } = await getResolvedConfig(process.cwd());
      const features = await listFeatureSlugs(specsRoot);
      const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Wait until it finishes before asking for the next ticket.", "warning");
        return;
      }

      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;

      await runNextTicketFlow(pi, feature, ctx);
    },
  });

  pi.registerCommand("ticket-done", {
    description: "Mark the current in-progress ticket as done without typing the ticket id",
    getArgumentCompletions: async (prefix: string) => {
      const { specsRoot } = await getResolvedConfig(process.cwd());
      const features = await listFeatureSlugs(specsRoot);
      const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
      return items.length > 0 ? items : null;
    },
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

      markTicket(registry, current.id, "done");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      emitInfo(pi, `Marked ${current.id} as done for ${feature}.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} marked done`, ["Start next ticket", "Show feature status", "Stop here"]);
      if (nextChoice === "Start next ticket") {
        await runNextTicketFlow(pi, feature, ctx);
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
    getArgumentCompletions: async (prefix: string) => {
      const { specsRoot } = await getResolvedConfig(process.cwd());
      const features = await listFeatureSlugs(specsRoot);
      const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
      return items.length > 0 ? items : null;
    },
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
      markTicket(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
      emitInfo(pi, `Marked ${current.id} as blocked for ${feature}.`);

      const nextChoice = await ctx.ui.select(`Ticket ${current.id} marked blocked`, ["Try next available ticket", "Show feature status", "Stop here"]);
      if (nextChoice === "Try next available ticket") {
        await runNextTicketFlow(pi, feature, ctx);
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
    getArgumentCompletions: async (prefix: string) => {
      const { specsRoot } = await getResolvedConfig(process.cwd());
      const features = await listFeatureSlugs(specsRoot);
      const items = features.filter((slug) => slug.startsWith(prefix.trim())).map((slug) => ({ value: slug, label: slug }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const resolved = await getResolvedConfig(ctx.cwd);
      const feature = await resolveFeatureSlug(args, resolved.specsRoot, resolved.config.featureSelectorTitle, ctx);
      if (!feature) return;
      const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
      emitInfo(pi, renderStatus(registry));
    },
  });
}

async function getResolvedConfig(cwd: string) {
  const config = await loadConfig(cwd);
  const specsRoot = resolveSpecsRoot(cwd, config);
  return { config, specsRoot };
}

async function runNextTicketFlow(pi: ExtensionAPI, feature: string, ctx: any) {
  const resolved = await getResolvedConfig(ctx.cwd);
  const registry = await loadRegistry(resolved.specsRoot, feature, resolved.config);
  const current = registry.tickets.find((ticket) => ticket.status === "in_progress");

  if (current) {
    const choice = await ctx.ui.select(`Feature ${feature} already has a ticket in progress`, [
      `Resume ${current.id}`,
      `Mark ${current.id} done and start next`,
      `Mark ${current.id} blocked and start next`,
      "Cancel",
    ]);

    if (!choice || choice === "Cancel") return;
    if (choice.startsWith("Resume ")) {
      await launchTicketExecution(pi, feature, current.id, resolved.config);
      return;
    }
    if (choice.startsWith("Mark") && choice.includes("done")) {
      markTicket(registry, current.id, "done");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
    }
    if (choice.startsWith("Mark") && choice.includes("blocked")) {
      const reason = await ctx.ui.input(`Why is ${current.id} blocked?`, "dependency, bug, missing info...");
      markTicket(registry, current.id, "blocked", reason || "Blocked by user");
      await saveRegistry(resolved.specsRoot, feature, resolved.config, registry);
    }
  }

  const refreshed = await loadRegistry(resolved.specsRoot, feature, resolved.config);
  const next = findNextAvailableTicket(refreshed);
  if (!next) {
    const blockedPending = refreshed.tickets.filter((ticket) => ticket.status === "pending" && !areDependenciesDone(ticket, refreshed));
    if (blockedPending.length > 0) {
      const lines = blockedPending.slice(0, 10).map((ticket) => {
        const missing = ticket.dependencies.filter((dep) => getTicket(refreshed, dep)?.status !== "done");
        return `- ${ticket.id} waiting for ${missing.join(", ")}`;
      });
      emitInfo(pi, `No tickets are ready to run for ${feature}.\n\nBlocked pending tickets:\n${lines.join("\n")}`);
      return;
    }

    emitInfo(pi, `No pending tickets remain for ${feature}.`);
    return;
  }

  markTicket(refreshed, next.id, "in_progress");
  await saveRegistry(resolved.specsRoot, feature, resolved.config, refreshed);
  emitInfo(pi, `Starting ${next.id} — ${next.title}`);
  await launchTicketExecution(pi, feature, next.id, resolved.config);
}

async function launchTicketExecution(pi: ExtensionAPI, feature: string, ticketId: string, config: Awaited<ReturnType<typeof loadConfig>>) {
  const message = buildExecutionMessage(feature, ticketId, config);
  pi.sendUserMessage(message);
}

function buildExecutionMessage(feature: string, ticketId: string, config: Awaited<ReturnType<typeof loadConfig>>) {
  if (config.executionPromptTemplate) {
    return config.executionPromptTemplate
      .replaceAll("{target}", config.executionTarget)
      .replaceAll("{feature}", feature)
      .replaceAll("{ticket}", ticketId)
      .replaceAll("{status_request}", config.executionStatusRequest);
  }

  if (config.executionMode === "command-message") {
    return `/${config.executionTarget} feature=${feature}; ticket=${ticketId}`;
  }

  if (config.executionMode === "custom-message") {
    return [`feature=${feature}`, `ticket=${ticketId}`, config.executionStatusRequest].join("\n");
  }

  return [
    `Use the project chain "${config.executionTarget}" now.`,
    `Input: feature=${feature}; ticket=${ticketId}`,
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

function emitInfo(pi: ExtensionAPI, text: string) {
  pi.sendMessage({ customType: "feature-ticket-flow", content: text, display: true });
}
