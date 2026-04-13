// Review viewer HTML generator.
// The HTML page is self-contained: CSS + JS inlined.
// No external dependencies.

export type ReviewDocument = {
  label: string;
  path: string;
  content: string;
};

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJs(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  let inCodeBlock = false;
  let out = "";

  for (const line of lines) {
    // Fenced code blocks
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        out += "<pre>";
        inCodeBlock = true;
      } else {
        out += "</pre>";
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) {
      out += escapeHtml(line) + "\n";
      continue;
    }

    // Inline code
    const escapedLine = escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>");

    if (line.match(/^### /)) {
      out += "<h2>" + escapedLine.replace(/^### /, "") + "</h2>";
    } else if (line.match(/^## /)) {
      out += "<h2>" + escapedLine.replace(/^## /, "") + "</h2>";
    } else if (line.match(/^# /)) {
      out += "<h1>" + escapedLine.replace(/^# /, "") + "</h1>";
    } else if (line.startsWith("> ")) {
      out += "<blockquote>" + escapedLine.replace(/^> /, "") + "</blockquote>";
    } else if (line.match(/^---+$/)) {
      out += "<hr>";
    } else if (line.match(/^[-*] /)) {
      out += "<li>" + escapedLine.replace(/^[-*] /, "") + "</li>";
    } else if (line.match(/^\d+\. /)) {
      out += "<li>" + escapedLine.replace(/^\d+\. /, "") + "</li>";
    } else if (line.startsWith("|")) {
      const cells = line.split("|").filter((c) => c.trim()).map((c) => c.trim());
      if (cells.some((c) => c.match(/^-+$/))) {
        out += "</tbody></table>";
      } else if (!out.endsWith("<tbody>")) {
        out += "<table><thead><tr>";
        cells.forEach((c) => { out += `<th>${c}</th>`; });
        out += "</tr></thead><tbody>";
      } else {
        out += "<tr>";
        cells.forEach((c) => { out += `<td>${c}</td>`; });
        out += "</tr>";
      }
    } else if (line.trim() === "") {
      out += "<br>";
    } else {
      const p = escapedLine
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
      out += `<p>${p}</p>`;
    }
  }

  return out;
}

function jsScript(documents: ReviewDocument[], currentStatus: string, port: number): string {
  const escapedDocs = JSON.stringify(documents).replace(/<\//g, "<\\\\/");
  const escapedStatus = JSON.stringify(currentStatus).replace(/<\//g, "<\\\\/");

  return `  const documents = ${escapedDocs};
  const currentStatus = ${escapedStatus};

  // ── Badge helpers ────────────────────────────────────────────────
  function badgeLabel(status) {
    switch (status) {
      case "pending_review": return "Pending Review";
      case "approved": return "Approved";
      case "changes_requested": return "Changes Requested";
      default: return status;
    }
  }
  function badgeClass(status) {
    switch (status) {
      case "approved": return "status-badge status-approved";
      case "changes_requested": return "status-badge status-changes";
      default: return "status-badge status-pending";
    }
  }

  // Apply badge
  const badge = document.getElementById("status-badge");
  badge.className = badgeClass(currentStatus);
  badge.textContent = badgeLabel(currentStatus);

  // Disable approve if already approved
  if (currentStatus === "approved") {
    const btn = document.getElementById("btn-approve");
    btn.disabled = true;
    btn.style.opacity = "0.5";
    btn.textContent = "Already Approved";
    document.getElementById("hint-text").textContent = "This feature has already been approved.";
  }

  // ── Render tabs & panels ────────────────────────────────────────
  const tabsBar = document.getElementById("tabs-bar");
  const docPanels = document.getElementById("doc-panels");

  documents.forEach((doc, i) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (i === 0 ? " active" : "");
    tab.textContent = doc.label;
    tab.onclick = () => activateTab(i);
    tabsBar.appendChild(tab);

    const panel = document.createElement("div");
    panel.className = "doc-panel" + (i === 0 ? " active" : "");
    panel.innerHTML = renderMarkdown(doc.content);
    docPanels.appendChild(panel);
  });

  function activateTab(index) {
    document.querySelectorAll(".tab").forEach((t, i) => {
      t.classList.toggle("active", i === index);
    });
    document.querySelectorAll(".doc-panel").forEach((p, i) => {
      p.classList.toggle("active", i === index);
    });
  }

  function submitReview(action) {
    const comment = document.getElementById("comment-box").value.trim();
    if (action === "changes_requested" && !comment) {
      document.getElementById("comment-note").textContent = "Please add feedback before requesting changes.";
      return;
    }
    document.getElementById("form-action").value = action;
    document.getElementById("form-comment").value = comment;
    document.getElementById("review-form").submit();
  }`;
}

export function generateReviewViewerHTML(opts: {
  feature: string;
  documents: ReviewDocument[];
  currentStatus: string;
  port: number;
}): string {
  const { feature, documents, currentStatus, port } = opts;

  const js = jsScript(documents, currentStatus, port);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(feature)} — Feature Review</title>
<style>
  :root {
    --bg: #0e1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --text-dim: #484f58;
    --accent: #58a6ff;
    --accent-hover: #79b8ff;
    --success: #3fb950;
    --success-bg: rgba(63, 185, 80, 0.12);
    --warning: #d29922;
    --warning-bg: rgba(210, 153, 34, 0.12);
    --error: #f85149;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: "SF Mono", "Fira Code", Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.6;
    display: flex;
    flex-direction: column;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  .header-icon {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: var(--surface2);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }
  .header-info { flex: 1; }
  .header-title { font-size: 17px; font-weight: 600; }
  .header-subtitle { font-size: 13px; color: var(--text-muted); margin-top: 2px; }
  .status-badge {
    font-size: 12px;
    font-weight: 600;
    padding: 4px 12px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: var(--mono);
  }
  .status-pending { background: var(--surface2); color: var(--warning); border: 1px solid var(--warning); }
  .status-approved { background: var(--success-bg); color: var(--success); border: 1px solid var(--success); }
  .status-changes { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning); }

  .tabs {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    padding: 0 24px;
    flex-shrink: 0;
    overflow-x: auto;
  }
  .tab {
    padding: 10px 20px;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
    user-select: none;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }

  .content-area {
    flex: 1;
    overflow-y: auto;
    padding: 28px 32px;
  }
  .doc-panel { display: none; }
  .doc-panel.active { display: block; }
  .doc-panel pre {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: calc(100vh - 340px);
    overflow-y: auto;
  }
  .doc-panel h1 { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
  .doc-panel h2 { font-size: 16px; font-weight: 600; margin-top: 24px; margin-bottom: 8px; color: var(--accent); }
  .doc-panel p { margin-bottom: 10px; color: var(--text-muted); }
  .doc-panel ul, .doc-panel ol { padding-left: 20px; margin-bottom: 10px; }
  .doc-panel li { margin-bottom: 4px; color: var(--text-muted); }
  .doc-panel code {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent);
  }
  .doc-panel blockquote {
    border-left: 3px solid var(--accent);
    padding-left: 16px;
    margin: 12px 0;
    color: var(--text-muted);
    font-style: italic;
  }
  .doc-panel hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  .doc-panel table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  .doc-panel th, .doc-panel td { border: 1px solid var(--border); padding: 8px 12px; font-size: 13px; }
  .doc-panel th { background: var(--surface2); font-weight: 600; }
  .doc-panel td { color: var(--text-muted); }

  .footer {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 16px 24px;
    flex-shrink: 0;
  }
  .footer-label { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; font-weight: 500; }
  .comment-box {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    font-family: var(--font);
    font-size: 14px;
    color: var(--text);
    resize: vertical;
    min-height: 72px;
    max-height: 160px;
    outline: none;
    transition: border-color 0.15s;
  }
  .comment-box::placeholder { color: var(--text-dim); }
  .comment-box:focus { border-color: var(--accent); }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
    align-items: center;
    flex-wrap: wrap;
  }
  .btn {
    padding: 8px 20px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s, transform 0.1s;
    font-family: var(--font);
  }
  .btn:hover { opacity: 0.88; }
  .btn:active { transform: scale(0.97); }
  .btn-approve { background: var(--success); color: #fff; }
  .btn-request-changes { background: var(--warning-bg); color: var(--warning); border-color: var(--warning); }
  .btn-cancel { background: var(--surface2); color: var(--text-muted); border-color: var(--border); margin-left: auto; }
  .hint { font-size: 12px; color: var(--text-dim); margin-left: 12px; }
  .comment-note { font-size: 12px; color: var(--text-muted); margin-top: 6px; margin-left: 12px; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .content-area { animation: fadeIn 0.2s ease-out; }
  .footer { animation: fadeIn 0.25s ease-out 0.05s both; }
</style>
</head>
<body>

<div class="header">
  <div class="header-icon">📋</div>
  <div class="header-info">
    <div class="header-title">${escapeHtml(feature)}</div>
    <div class="header-subtitle">Feature Spec &amp; Plan Review</div>
  </div>
  <span id="status-badge" class="status-badge status-pending">Pending Review</span>
</div>

<div class="tabs" id="tabs-bar"></div>

<div class="content-area" id="content-area">
  <div id="doc-panels"></div>
</div>

<div class="footer">
  <div class="footer-label">Your Feedback</div>
  <textarea
    id="comment-box"
    class="comment-box"
    placeholder="Optional comment about the spec or plan (e.g. missing requirements, unclear acceptance criteria, missing design details...)"
  ></textarea>
  <div class="actions">
    <button class="btn btn-approve" id="btn-approve" onclick="submitReview('approved')">Approve</button>
    <button class="btn btn-request-changes" id="btn-request-changes" onclick="submitReview('changes_requested')">Request Changes</button>
    <button class="btn btn-cancel" id="btn-cancel" onclick="submitReview('closed')">Close</button>
    <span id="hint-text" class="hint"></span>
  </div>
  <div class="comment-note" id="comment-note"></div>
</div>

<form id="review-form" method="POST" action="http://localhost:${port}/submit" style="display:none;">
  <input type="text" name="action" id="form-action">
  <textarea name="comment" id="form-comment"></textarea>
</form>

<script>
${js}
</script>

</body>
</html>`;
}