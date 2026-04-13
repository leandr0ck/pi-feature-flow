import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openPlanViewer, cancelPlanViewer } from "../src/viewers/plan-viewer-server.js";
import { createFeatureCompletions } from "../src/feature-flow/ui.js";

export default function featurePlanViewerExtension(pi: ExtensionAPI) {
  // /plan-viewer — open interactive plan review
  pi.registerCommand("plan-viewer", {
    description: "Open interactive plan viewer in browser",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args: string, ctx: { ui: { notify: Function } }) => {
      const feature = args.trim() || "feature";
      const title = "Feature Plan";

      ctx.ui.notify(`Opening plan viewer for ${feature}...`, "info");

      openPlanViewer({ feature, title, markdown: "" })
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
