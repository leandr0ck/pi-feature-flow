import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openTicketViewer, cancelTicketViewer } from "../src/viewers/ticket-viewer-server.js";
import { loadRegistry } from "../src/registry.js";
import { resolveSpecsRoot } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createFeatureCompletions } from "../src/feature-flow/ui.js";

export default function featureTicketViewerExtension(pi: ExtensionAPI) {
  // /ticket-viewer — open interactive ticket viewer
  pi.registerCommand("ticket-viewer", {
    description: "Open interactive ticket viewer in browser",
    getArgumentCompletions: createFeatureCompletions,
    handler: async (args: string, ctx: { ui: { notify: Function } }) => {
      const feature = args.trim();
      if (!feature) {
        ctx.ui.notify("Usage: /ticket-viewer <feature>", "error");
        return;
      }

      const cwd = process.cwd();

      try {
        const config = await loadConfig(cwd);
        const specsRoot = resolveSpecsRoot(cwd, config);
        const registry = await loadRegistry(specsRoot, feature);

        ctx.ui.notify(`Opening ticket viewer for ${feature}...`, "info");

        const result = await openTicketViewer({ feature, registry });

        if (result.action === "execute") {
          ctx.ui.notify(`Selected ticket: ${result.ticketId}`, "info");
        } else if (result.action === "view") {
          ctx.ui.notify(`Viewing ticket: ${result.ticketId}`, "info");
        }
      } catch (err) {
        ctx.ui.notify(`Failed to open ticket viewer: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // /cancel-ticket-viewer — cancel any pending ticket viewer
  pi.registerCommand("cancel-ticket-viewer", {
    description: "Cancel pending ticket viewer",
    handler: async (_args: string, ctx: { ui: { notify: Function } }) => {
      cancelTicketViewer();
      ctx.ui.notify("Ticket viewer cancelled", "info");
    },
  });
}
