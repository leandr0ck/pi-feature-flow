import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FeatureReviewResult } from "../src/types.js";
import { emitInfo } from "../src/feature-flow/state.js";
import {
  formatReviewSummary,
  getFeatureReviewDocuments,
  markFeatureReviewed,
  parseReviewResult,
} from "../src/feature-flow/review.js";
import { generateReviewViewerHTML } from "../src/feature-flow/review-html.js";

type PendingReview = {
  feature: string;
  specsRoot: string;
  resolve: (result: FeatureReviewResult) => void;
  reject: (reason: unknown) => void;
  server: Server;
};

let pendingReview: PendingReview | undefined;

function cleanupServer(server: Server) {
  try {
    server.close();
  } catch {
    // ignore
  }
}

function openBrowser(url: string): void {
  try {
    const { execSync } = require("node:child_process");
    if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // ignore
  }
}

async function startReviewServer(
  feature: string,
  specsRoot: string,
): Promise<FeatureReviewResult> {
  return new Promise((resolve, reject) => {
    const PORT = 9876;
    let server: Server;

    const serverInstance = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/submit" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", async () => {
          const rawResult = parseReviewResult(body);
          let action: "approved" | "changes_requested" | "closed" = "closed";
          let comment: string | undefined;

          if ("action" in rawResult && typeof rawResult.action === "string") {
            const rawAction = rawResult.action as string;
            action = (rawAction === "approved" || rawAction === "changes_requested" || rawAction === "closed"
              ? rawAction
              : "closed") as "approved" | "changes_requested" | "closed";
            if (action === "changes_requested" && "comment" in rawResult && typeof (rawResult as Record<string, unknown>).comment === "string") {
              comment = String((rawResult as Record<string, unknown>).comment);
            } else if (action === "approved" && "comment" in rawResult && typeof (rawResult as Record<string, unknown>).comment === "string") {
              comment = String((rawResult as Record<string, unknown>).comment);
            }
          }

          try {
            await markFeatureReviewed(specsRoot, feature, action as "approve" | "request_changes" | "close", comment);
          } catch (_err) {
            // best-effort
          }

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html><body style="background:#0e1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;">
                <div style="font-size:32px;margin-bottom:12px;">${action === "approved" ? "✅" : action === "changes_requested" ? "🔁" : "👋"}</div>
                <p style="font-size:16px;">${action === "approved" ? "Feature approved!" : action === "changes_requested" ? "Changes requested" : "Review closed"}</p>
                <p style="color:#8b949e;font-size:13px;margin-top:8px;">You can close this tab.</p>
              </div>
            </html>
          `);

          const resolvedResult = action === "approved"
            ? ({ action: "approved" as const, ...(comment !== undefined ? { comment } : {}) })
            : action === "changes_requested"
              ? ({ action: "changes_requested" as const, comment: comment || "" })
              : ({ action: "closed" as const });
          resolve(resolvedResult);
          setTimeout(() => cleanupServer(server), 500);
        });
      }

      // Health check / root
      if (req.url === "/" || req.url === "") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='background:#0e1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;'><p style='color:#8b949e;'>Feature review server is running. <a href='/review' style='color:#58a6ff;'>Go to review</a>.</p></body></html>");
        return;
      }

      if (req.url?.startsWith("/review")) {
        getFeatureReviewDocuments(specsRoot, feature).then((docs) => {
          const html = generateReviewViewerHTML({
            feature,
            documents: docs,
            currentStatus: "pending_review",
            port: PORT,
          });

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        }).catch((err) => {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Error loading documents: ${err.message}`);
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server = serverInstance;

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(PORT, "127.0.0.1", () => {
      const url = `http://localhost:${PORT}/review`;
      openBrowser(url);
    });
  });
}

export function registerFeatureReviewViewer(pi: ExtensionAPI) {
  // ── /review-feature command ──────────────────────────────────────────
  pi.registerCommand("review-feature", {
    description: "Open the feature review viewer in the browser",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Wait until it finishes.", "warning");
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /review-feature <feature-slug>", "error");
        return;
      }

      const config = await import("../src/config.js").then((m) => m.loadConfig(ctx.cwd));
      const specsRoot = (await import("../src/config.js").then((m) => m.resolveSpecsRoot(ctx.cwd, config)));

      const docs = await getFeatureReviewDocuments(specsRoot, trimmed);
      if (docs.length === 0) {
        ctx.ui.notify(`No review documents found for feature "${trimmed}".`, "error");
        return;
      }

      ctx.ui.notify(`Opening review viewer for "${trimmed}"...`, "info");
      emitInfo(pi, `Opening review viewer for **${trimmed}** in browser.`);

      const result = await startReviewServer(trimmed, specsRoot);

      if (result.action === "approved") {
        ctx.ui.notify(`✅ Feature "${trimmed}" approved! Tickets are now executable.`, "info");
        emitInfo(pi, `Feature **${trimmed}** approved.`);
      } else if (result.action === "changes_requested") {
        ctx.ui.notify(`🔁 Changes requested for "${trimmed}". Feedback saved.`, "info");
        emitInfo(pi, [
          `Feature **${trimmed}**: changes requested.`,
          "",
          `Feedback: ${result.comment}`,
          "",
          "After updating the docs, run `/review-feature ${trimmed}` again.",
        ].join("\n"));
      } else {
        ctx.ui.notify(`Review closed for "${trimmed}" without action.`, "info");
        emitInfo(pi, `Review closed for **${trimmed}**. Run \`/review-feature ${trimmed}\` to re-open.`);
      }
    },
  });

  // ── /approve-feature command ─────────────────────────────────────────
  pi.registerCommand("approve-feature", {
    description: "Approve a feature directly without opening the viewer",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /approve-feature <feature-slug>", "error");
        return;
      }

      const config = await import("../src/config.js").then((m) => m.loadConfig(ctx.cwd));
      const specsRoot = (await import("../src/config.js").then((m) => m.resolveSpecsRoot(ctx.cwd, config)));

      const registry = await import("../src/registry.js").then((m) => m.loadRegistry(specsRoot, trimmed));
      await markFeatureReviewed(specsRoot, trimmed, "approve");

      ctx.ui.notify(`✅ Feature "${trimmed}" approved!`, "info");
      emitInfo(pi, [
        `Feature **${trimmed}** approved.`,
        "",
        formatReviewSummary(registry),
        "",
        "Tickets are now executable. Run `/start-feature ${trimmed}` or `/next-ticket ${trimmed}`.",
      ].join("\n"));
    },
  });

  // ── /request-feature-changes command ─────────────────────────────────
  pi.registerCommand("request-feature-changes", {
    description: "Request changes on a feature (leaves it in changes_requested state)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /request-feature-changes <feature-slug> [comment]", "error");
        return;
      }

      const parts = trimmed.split(/\s+/);
      const feature = parts[0];
      const comment = parts.slice(1).join(" ") || undefined;

      if (!comment) {
        const inputComment = await ctx.ui.input("What changes are needed?", "Describe what needs to be updated in the spec or plan...");
        if (!inputComment) {
          ctx.ui.notify("Comment required for changes request.", "warning");
          return;
        }
        await requestChangesWithComment(ctx, pi, feature, inputComment);
      } else {
        await requestChangesWithComment(ctx, pi, feature, comment);
      }
    },
  });
}

async function requestChangesWithComment(
  ctx: { cwd?: string; ui: { notify: Function; input: Function } },
  pi: ExtensionAPI,
  feature: string,
  comment: string,
) {
  const config = await import("../src/config.js").then((m) => m.loadConfig(ctx.cwd || process.cwd()));
  const specsRoot = (await import("../src/config.js").then((m) => m.resolveSpecsRoot(ctx.cwd || process.cwd(), config)));

  await markFeatureReviewed(specsRoot, feature, "request_changes", comment);

  ctx.ui.notify(`🔁 Changes requested for "${feature}".`, "info");
  emitInfo(pi, [
    `Feature **${feature}**: changes requested.`,
    "",
    `Feedback: ${comment}`,
    "",
    "After updating the docs, run `/review-feature ${feature}` again to re-review.",
  ].join("\n"));
}

export async function openFeatureReview(
  pi: ExtensionAPI,
  feature: string,
  specsRoot: string,
): Promise<FeatureReviewResult | null> {
  try {
    const docs = await getFeatureReviewDocuments(specsRoot, feature);
    if (docs.length === 0) return null;

    const result = await startReviewServer(feature, specsRoot);
    return result;
  } catch {
    return null;
  }
}

export default function featureReviewViewer(pi: ExtensionAPI) {
  registerFeatureReviewViewer(pi);
}