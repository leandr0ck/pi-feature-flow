import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openPlanViewer, cancelPlanViewer } from "../src/viewers/plan-viewer-server.js";
import { createFeatureCompletions } from "../src/feature-flow/ui.js";
import { loadConfig, resolveSpecsRoot } from "../src/config.js";

async function readPlanMarkdown(cwd: string, feature: string): Promise<{ title: string; markdown: string }> {
  const config = await loadConfig(cwd);
  const specsRoot = resolveSpecsRoot(cwd, config);
  const featureDir = path.join(specsRoot, feature);
  const masterSpecPath = path.join(featureDir, "01-master-spec.md");
  const executionPlanPath = path.join(featureDir, "02-execution-plan.md");

  const [masterSpec, executionPlan] = await Promise.all([
    fs.readFile(masterSpecPath, "utf8").catch(() => ""),
    fs.readFile(executionPlanPath, "utf8").catch(() => ""),
  ]);

  if (executionPlan.trim()) {
    return {
      title: `${feature} execution plan`,
      markdown: executionPlan,
    };
  }

  if (masterSpec.trim()) {
    return {
      title: `${feature} master spec`,
      markdown: masterSpec,
    };
  }

  throw new Error(`No review document found for feature \"${feature}\". Expected 01-master-spec.md or 02-execution-plan.md`);
}

export default function featurePlanViewerExtension(pi: ExtensionAPI) {
  // /plan-viewer — open interactive plan review
  pi.registerCommand("plan-viewer", {
    description: "Open interactive plan viewer in browser",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args: string, ctx: { cwd?: string; ui: { notify: Function } }) => {
      const feature = args.trim() || "feature";

      try {
        const cwd = ctx.cwd || process.cwd();
        const { title, markdown } = await readPlanMarkdown(cwd, feature);

        ctx.ui.notify(`Opening plan viewer for ${feature}...`, "info");

        openPlanViewer({ feature, title, markdown })
          .then((result) => {
            if (result.action === "approve") {
              ctx.ui.notify(`Plan approved for ${feature}`, "success");
            } else if (result.action === "needs_fix") {
              ctx.ui.notify(`Plan needs fixes: ${result.comment}`, "warning");
            }
          })
          .catch((err: Error) => {
            ctx.ui.notify(`Plan viewer error: ${err.message}`, "error");
          });
      } catch (err) {
        ctx.ui.notify(`Could not open plan viewer: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // /cancel-plan-viewer — cancel any pending plan viewer
  pi.registerCommand("cancel-plan-viewer", {
    description: "Cancel pending plan viewer",
    handler: async (_args: string, ctx: { ui: { notify: Function } }) => {
      cancelPlanViewer();
      ctx.ui.notify("Plan viewer cancelled", "info");
    },
  });
}
