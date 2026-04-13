import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FeatureReviewResult } from "../src/types.js";
import { emitInfo } from "../src/feature-flow/state.js";
import {
  ensureFeatureReviewSnapshot,
  formatReviewSummary,
  getFeatureReviewBundle,
  getFeatureReviewDocuments,
  markFeatureReviewed,
  parseReviewResult,
} from "../src/feature-flow/review.js";
import { loadRegistry } from "../src/registry.js";
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

function scheduleCleanup(server: Server, delayMs: number) {
  setTimeout(() => cleanupServer(server), delayMs);
}

async function buildExecutionStatus(specsRoot: string, feature: string) {
  const registry = await loadRegistry(specsRoot, feature);
  const current = registry.tickets.find((ticket) => ticket.status === "in_progress");
  const counts = {
    done: registry.tickets.filter((ticket) => ticket.status === "done").length,
    inProgress: registry.tickets.filter((ticket) => ticket.status === "in_progress").length,
    pending: registry.tickets.filter((ticket) => ticket.status === "pending").length,
    needsFix: registry.tickets.filter((ticket) => ticket.status === "needs_fix").length,
    blocked: registry.tickets.filter((ticket) => ticket.status === "blocked").length,
    total: registry.tickets.length,
  };

  return {
    feature,
    reviewStatus: registry.review?.status || "pending_review",
    counts,
    currentTicket: current
      ? {
          id: current.id,
          title: current.title,
          profileName: current.profileName,
        }
      : null,
    completed: counts.total > 0 && counts.done === counts.total,
    halted: counts.blocked > 0 || counts.needsFix > 0,
    tickets: registry.tickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      profileName: ticket.profileName,
      blockedReason: ticket.blockedReason,
    })),
  };
}

function generateExecutionStatusHTML(feature: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${feature} — Implementation Running</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1f2630; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --success: #3fb950; --warning: #d29922; --danger: #f85149; --accent: #58a6ff;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--font); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 40px; }
  .hero, .panel { background: var(--panel); border:1px solid var(--border); border-radius: 14px; }
  .hero { padding: 20px; margin-bottom: 18px; }
  .title { font-size: 22px; font-weight: 700; }
  .subtitle { margin-top: 6px; color: var(--muted); }
  .badges { display:flex; gap:8px; flex-wrap:wrap; margin-top: 14px; }
  .badge { padding:6px 10px; border-radius:999px; border:1px solid var(--border); background:var(--panel2); color:var(--muted); font-size:12px; }
  .grid { display:grid; grid-template-columns: repeat(5, 1fr); gap:12px; margin-bottom: 18px; }
  .stat { padding: 14px; text-align:center; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .panel { padding: 16px; margin-bottom: 16px; }
  .section-title { font-size: 14px; font-weight: 700; margin-bottom: 12px; }
  .current { padding: 14px; border:1px solid var(--border); border-radius: 10px; background: var(--panel2); }
  .muted { color: var(--muted); }
  .tickets { display:grid; gap: 8px; }
  .ticket { display:flex; justify-content:space-between; gap:12px; padding: 10px 12px; border:1px solid var(--border); border-radius: 10px; background: var(--panel2); }
  .ticket-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .status { padding: 4px 8px; border-radius: 999px; font-size: 12px; border:1px solid var(--border); white-space: nowrap; }
  .done { color: var(--success); border-color: var(--success); }
  .in_progress { color: var(--accent); border-color: var(--accent); }
  .pending { color: var(--muted); }
  .needs_fix, .blocked { color: var(--warning); border-color: var(--warning); }
  .footer-note { color: var(--muted); font-size: 12px; margin-top: 8px; }
  @media (max-width: 860px) { .grid { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="title">${feature}</div>
      <div class="subtitle">Plan approved. Implementation started automatically.</div>
      <div class="badges" id="badges"></div>
      <div class="footer-note">This page refreshes automatically while Pi works ticket by ticket.</div>
    </div>

    <div class="grid" id="stats"></div>

    <div class="panel">
      <div class="section-title">Current ticket</div>
      <div id="current-ticket" class="current muted">Waiting for execution to start…</div>
    </div>

    <div class="panel">
      <div class="section-title">Tickets</div>
      <div id="tickets" class="tickets"></div>
    </div>
  </div>
<script>
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function statusLabel(value) {
    return value === 'in_progress' ? 'in progress' : value.replace('_', ' ');
  }
  async function refresh() {
    const res = await fetch('/status', { cache: 'no-store' });
    const data = await res.json();

    document.getElementById('badges').innerHTML = [
      '<span class="badge">review: ' + escapeHtml(data.reviewStatus) + '</span>',
      data.completed ? '<span class="badge">all tickets done</span>' : '',
      data.halted ? '<span class="badge">attention needed</span>' : ''
    ].join('');

    const stats = [
      ['Done', data.counts.done],
      ['In Progress', data.counts.inProgress],
      ['Pending', data.counts.pending],
      ['Needs Fix', data.counts.needsFix],
      ['Blocked', data.counts.blocked],
    ];
    document.getElementById('stats').innerHTML = stats.map(([label, value]) =>
      '<div class="panel stat"><div class="stat-value">' + value + '</div><div class="stat-label">' + label + '</div></div>'
    ).join('');

    const current = data.currentTicket;
    document.getElementById('current-ticket').innerHTML = current
      ? '<div><strong>' + escapeHtml(current.id) + '</strong> — ' + escapeHtml(current.title) + '</div>' +
        '<div class="ticket-meta">' + (current.profileName ? 'profile: ' + escapeHtml(current.profileName) : 'active now') + '</div>'
      : (data.completed
          ? 'Implementation finished successfully.'
          : data.halted
            ? 'Execution stopped because a ticket is blocked or needs fix.'
            : 'No ticket currently running.');

    document.getElementById('tickets').innerHTML = data.tickets.map((ticket) =>
      '<div class="ticket">' +
        '<div><div><strong>' + escapeHtml(ticket.id) + '</strong> — ' + escapeHtml(ticket.title) + '</div>' +
        '<div class="ticket-meta">' +
          (ticket.profileName ? 'profile: ' + escapeHtml(ticket.profileName) : 'no profile') +
          (ticket.blockedReason ? ' · ' + escapeHtml(ticket.blockedReason) : '') +
        '</div></div>' +
        '<span class="status ' + escapeHtml(ticket.status) + '">' + escapeHtml(statusLabel(ticket.status)) + '</span>' +
      '</div>'
    ).join('');
  }
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
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
          if (action === "approved") {
            res.end(generateExecutionStatusHTML(feature));
            scheduleCleanup(server, 1000 * 60 * 10);
          } else {
            res.end(`
              <html><body style="background:#0e1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                  <div style="font-size:32px;margin-bottom:12px;">${action === "changes_requested" ? "🔁" : "👋"}</div>
                  <p style="font-size:16px;">${action === "changes_requested" ? "Changes requested" : "Review closed"}</p>
                  <p style="color:#8b949e;font-size:13px;margin-top:8px;">You can close this tab.</p>
                </div>
              </body></html>
            `);
            scheduleCleanup(server, 500);
          }

          const resolvedResult = action === "approved"
            ? ({ action: "approved" as const, ...(comment !== undefined ? { comment } : {}) })
            : action === "changes_requested"
              ? ({ action: "changes_requested" as const, comment: comment || "" })
              : ({ action: "closed" as const });
          resolve(resolvedResult);
        });
      }

      // Health check / root
      if (req.url === "/" || req.url === "") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body style='background:#0e1117;color:#e6edf3;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;'><p style='color:#8b949e;'>Feature review server is running. <a href='/review' style='color:#58a6ff;'>Go to review</a>.</p></body></html>");
        return;
      }

      if (req.url === "/status") {
        buildExecutionStatus(specsRoot, feature).then((status) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(status));
        }).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      if (req.url?.startsWith("/review")) {
        Promise.all([
          getFeatureReviewBundle(specsRoot, feature),
          loadRegistry(specsRoot, feature).catch(() => undefined),
        ]).then(([bundle, registry]) => {
          const html = generateReviewViewerHTML({
            feature,
            documents: bundle.currentDocs,
            currentRevision: bundle.currentRevision,
            previousRevision: bundle.previousRevision,
            currentStatus: registry?.review?.status || "pending_review",
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

      await ensureFeatureReviewSnapshot(specsRoot, trimmed);
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
  ctx: { cwd?: string; ui: { notify: Function; input: Function; select?: Function } },
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
    "Run `/revise-feature ${feature} <feedback>` to apply the feedback with the agent, then review again.",
  ].join("\n"));

  if (typeof ctx.ui.select === "function") {
    const choice = await ctx.ui.select(`Changes requested for ${feature}`, [
      "Revise docs now",
      "Stop here",
    ]);
    if (choice === "Revise docs now") {
      emitInfo(pi, `Next step: run \`/revise-feature ${feature} ${comment}\``);
    }
  }
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