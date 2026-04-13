import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, resolveAuthoringSkills, resolveTddEnabled } from "../config.js";
import { listFeatureSlugs, loadRegistry } from "../registry.js";
import { renderValidation } from "../render.js";
import { validateFeature } from "../validation.js";
import { buildPlanningContinuationPrompt } from "./prompts.js";
import { emitInfo, setPendingExecution } from "./state.js";
import { pathExists } from "./scaffold.js";

export async function maybeContinuePlanning(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
  ctx: { cwd?: string; ui: { notify: Function } },
): Promise<boolean> {
  const featureDir = path.join(specsRoot, feature);
  const masterSpecPath = path.join(featureDir, "01-master-spec.md");
  const technicalDesignPath = path.join(featureDir, "04-technical-design.md");
  const ticketsDir = path.join(featureDir, "tickets");

  if (!(await pathExists(masterSpecPath))) return false;

  let ticketFiles: string[] = [];
  try {
    ticketFiles = (await fs.readdir(ticketsDir)).filter((file) => file.endsWith(".md"));
  } catch {
    ticketFiles = [];
  }

  if (ticketFiles.length > 0) return false;

  if (!(await pathExists(technicalDesignPath))) {
    ctx.ui.notify(
      `Feature ${feature} still needs 04-technical-design.md before refinement and ticket generation can continue.`,
      "warning",
    );
    emitInfo(
      pi,
      [
        `Feature ${feature} is not ready for execution.`,
        "",
        "No tickets were found.",
        "Add `04-technical-design.md` to continue planning for technically complex work.",
        "After adding it, run `/start-feature <feature>` again.",
      ].join("\n"),
    );
    return true;
  }

  const config = await loadConfig(ctx.cwd || process.cwd());
  const authoringSkills = resolveAuthoringSkills(config);
  const tddEnabled = resolveTddEnabled(config);
  const availableProfiles = Object.keys(config.profiles || { default: {} });

  setPendingExecution({ kind: "feature-plan", feature, cwd: ctx.cwd || process.cwd(), specsRoot });
  ctx.ui.notify(`Technical design detected for ${feature}. Continuing planning...`, "info");
  pi.sendUserMessage(buildPlanningContinuationPrompt(feature, specsRoot, authoringSkills, tddEnabled, availableProfiles));
  return true;
}

export async function validateBeforeExecution(
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

export async function resolveFeatureSlug(
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
