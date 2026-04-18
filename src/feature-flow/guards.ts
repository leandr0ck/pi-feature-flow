import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listFeatureSlugs, loadRegistry } from "../registry.js";
import { renderValidation } from "../render.js";
import { validateFeature } from "../validation.js";
import { emitInfo } from "./state.js";

export async function validateBeforeExecution(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
  ctx: { cwd?: string; ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void } },
): Promise<boolean> {
  const validation = await validateFeature(specsRoot, feature);
  if (!validation.valid) {
    emitInfo(pi, renderValidation(validation));
    ctx.ui.notify(
      `Feature ${feature} failed validation. Run /ticket-validate ${feature} for details.`,
      "warning",
    );
    return false;
  }
  return true;
}

export async function resolveFeatureSlug(
  args: string,
  specsRoot: string,
  title: string,
  ctx: { ui: { notify: (msg: string, type?: "error" | "warning" | "info") => void; select: Function } },
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
