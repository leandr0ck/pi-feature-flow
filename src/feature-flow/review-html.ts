// Review viewer HTML generator.
// Lightweight, self-contained HTML with inline CSS/JS.

export type ReviewDocument = {
  label: string;
  path: string;
  content: string;
  previousContent?: string;
  changed?: boolean;
};

// Escape a value for safe embedding inside a <script> block.
// JSON.stringify does not escape < > & or backticks, which can break the script.
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\`")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  let inCodeBlock = false;
  let out = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      out += inCodeBlock ? "</pre>" : "<pre>";
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out += escapeHtml(line) + "\n";
      continue;
    }

    const escapedLine = escapeHtml(line).replace(/`([^`]+)`/g, "<code>$1</code>");

    if (/^###\s+/.test(line)) out += `<h3>${escapedLine.replace(/^###\s+/, "")}</h3>`;
    else if (/^##\s+/.test(line)) out += `<h2>${escapedLine.replace(/^##\s+/, "")}</h2>`;
    else if (/^#\s+/.test(line)) out += `<h1>${escapedLine.replace(/^#\s+/, "")}</h1>`;
    else if (/^>\s+/.test(line)) out += `<blockquote>${escapedLine.replace(/^>\s+/, "")}</blockquote>`;
    else if (/^---+$/.test(line)) out += "<hr>";
    else if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) out += `<li>${escapedLine.replace(/^([-*]|\d+\.)\s+/, "")}</li>`;
    else if (line.trim() === "") out += "<br>";
    else {
      const p = escapedLine
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>");
      out += `<p>${p}</p>`;
    }
  }

  return out;
}

export function generateReviewViewerHTML(opts: {
  feature: string;
  documents: ReviewDocument[];
  currentRevision: number;
  previousRevision?: number;
  currentStatus: string;
  port: number;
}): string {
  const { feature, documents, currentRevision, previousRevision, currentStatus, port } = opts;

  const payload = safeJsonForScript({ documents, currentStatus, currentRevision, previousRevision });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(feature)} — Feature Review</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --success: #3fb950;
    --warning: #d29922;
    --danger: #f85149;
    --line-add: rgba(63,185,80,0.16);
    --line-remove: rgba(248,81,73,0.14);
    --line-same: rgba(255,255,255,0.02);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    display: grid;
    grid-template-rows: auto auto 1fr auto;
  }
  .header, .toolbar, .footer { background: var(--panel); border-bottom: 1px solid var(--border); }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 20px; }
  .title { font-size: 18px; font-weight: 700; }
  .subtitle { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .badge {
    font-size: 12px; border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
    padding: 5px 10px; border-radius: 999px; font-family: var(--mono);
  }
  .badge.approved { color: var(--success); border-color: var(--success); }
  .badge.pending_review { color: var(--warning); border-color: var(--warning); }
  .badge.changes_requested { color: var(--warning); border-color: var(--warning); }

  .toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; overflow-x: auto; }
  .tabs { display: flex; gap: 8px; flex: 1; }
  .tab {
    background: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 12px; cursor: pointer; white-space: nowrap; font-size: 13px;
  }
  .tab.active { color: var(--text); border-color: var(--accent); background: rgba(88,166,255,0.08); }
  .tab .dot { display: inline-block; width: 7px; height: 7px; border-radius: 999px; margin-left: 8px; }
  .tab .dot.changed { background: var(--warning); }
  .tab .dot.same { background: #2ea043; }
  .view-toggle { display: flex; gap: 6px; }
  .toggle {
    border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); border-radius: 8px;
    padding: 7px 10px; cursor: pointer; font-size: 12px;
  }
  .toggle.active { color: var(--text); border-color: var(--accent); }

  .content { overflow: auto; padding: 16px; }
  .doc-meta { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
  .doc-title { font-size: 16px; font-weight: 700; }
  .doc-subtitle { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pill { font-size: 12px; border-radius: 999px; padding: 4px 10px; border: 1px solid var(--border); color: var(--muted); }
  .pill.changed { border-color: var(--warning); color: var(--warning); }
  .pill.same { border-color: #2ea043; color: #2ea043; }

  .markdown, .empty, .line-pane {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
  }
  .markdown h1, .markdown h2, .markdown h3 { margin: 0 0 10px; }
  .markdown h2, .markdown h3 { margin-top: 18px; color: var(--accent); }
  .markdown p, .markdown li, .markdown blockquote { color: var(--muted); }
  .markdown code { background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-family: var(--mono); }
  .markdown pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow: auto; font-family: var(--mono); }
  .markdown blockquote { border-left: 3px solid var(--accent); padding-left: 12px; margin-left: 0; }
  .markdown li { margin-bottom: 6px; }
  .empty { color: var(--muted); text-align: center; }

  .diff-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .pane-title { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 10px; }
  .line-pane { padding: 0; overflow: hidden; }
  .line-list { max-height: calc(100vh - 320px); overflow: auto; font-family: var(--mono); font-size: 12px; }
  .line {
    display: grid; grid-template-columns: 52px 1fr; gap: 12px; padding: 0 12px; border-top: 1px solid rgba(255,255,255,0.04);
    white-space: pre-wrap; word-break: break-word;
  }
  .line:first-child { border-top: none; }
  .line.no-change { background: var(--line-same); }
  .line.add { background: var(--line-add); }
  .line.remove { background: var(--line-remove); }
  .line-num { color: var(--muted); user-select: none; padding: 8px 0; }
  .line-text { padding: 8px 0; }

  .footer { border-top: 1px solid var(--border); border-bottom: none; padding: 14px 16px; }
  .footer-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .comment-box {
    width: 100%; min-height: 78px; resize: vertical; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px; padding: 12px; font: inherit;
  }
  .actions { display: flex; gap: 10px; margin-top: 12px; align-items: center; flex-wrap: wrap; }
  .btn {
    padding: 9px 14px; border-radius: 9px; border: 1px solid transparent; cursor: pointer; font-weight: 600;
    background: var(--panel-2); color: var(--text);
  }
  .btn.approve { background: var(--success); color: white; }
  .btn.request { background: rgba(210,153,34,.1); color: var(--warning); border-color: var(--warning); }
  .btn.close { margin-left: auto; border-color: var(--border); color: var(--muted); }
  .hint, .comment-note { font-size: 12px; color: var(--muted); }

  @media (max-width: 980px) {
    .diff-grid { grid-template-columns: 1fr; }
    .btn.close { margin-left: 0; }
  }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="title">${escapeHtml(feature)}</div>
    <div class="subtitle">Review docs before execution${previousRevision ? ` · comparing r${String(previousRevision).padStart(3, "0")} → r${String(currentRevision).padStart(3, "0")}` : " · first review"}</div>
  </div>
  <div class="meta">
    <span id="status-badge" class="badge ${escapeHtml(currentStatus)}"></span>
    <span class="badge">r${String(currentRevision).padStart(3, "0")}</span>
    ${previousRevision ? `<span class="badge">prev r${String(previousRevision).padStart(3, "0")}</span>` : ""}
  </div>
</div>
<div class="toolbar">
  <div class="tabs" id="tabs"></div>
  <div class="view-toggle">
    <button class="toggle" data-view="diff">Diff</button>
    <button class="toggle" data-view="current">Current</button>
    <button class="toggle" data-view="previous">Previous</button>
  </div>
</div>
<div class="content">
  <div class="doc-meta">
    <div>
      <div class="doc-title" id="doc-title"></div>
      <div class="doc-subtitle" id="doc-subtitle"></div>
    </div>
    <div id="change-pill" class="pill"></div>
  </div>
  <div id="doc-container"></div>
</div>
<div class="footer">
  <div class="footer-label">Your Feedback</div>
  <textarea id="comment-box" class="comment-box" placeholder="Optional comment about the spec, plan, or changed tickets..."></textarea>
  <div class="actions">
    <button class="btn approve" id="btn-approve" onclick="submitReview('approved')">Approve</button>
    <button class="btn request" onclick="submitReview('changes_requested')">Request Changes</button>
    <button class="btn close" onclick="submitReview('closed')">Close</button>
    <span id="hint-text" class="hint"></span>
  </div>
  <div class="comment-note" id="comment-note"></div>
</div>
<form id="review-form" method="POST" action="http://localhost:${port}/submit" style="display:none;">
  <input type="text" name="action" id="form-action">
  <textarea name="comment" id="form-comment"></textarea>
</form>
<script>
  const payload = ${payload};
  const documents = payload.documents || [];
  const currentStatus = payload.currentStatus;
  const previousRevision = payload.previousRevision;
  let activeIndex = 0;
  let activeView = previousRevision ? "diff" : "current";

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function badgeLabel(status) {
    switch (status) {
      case "pending_review": return "Pending Review";
      case "approved": return "Approved";
      case "changes_requested": return "Changes Requested";
      default: return status;
    }
  }

  function simpleMarkdown(md) {
    const lines = String(md || "").split("\n");
    let inCode = false;
    let out = "";
    for (const line of lines) {
      if (line.startsWith("\`\`\`")) {
        out += inCode ? "</pre>" : "<pre>";
        inCode = !inCode;
        continue;
      }
      if (inCode) { out += escapeHtml(line) + "\\n"; continue; }
      const escaped = escapeHtml(line).replace(/\`([^\`]+)\`/g, "<code>$1</code>");
      if (/^###\s+/.test(line)) out += '<h3>' + escaped.replace(/^###\s+/, '') + '</h3>';
      else if (/^##\s+/.test(line)) out += '<h2>' + escaped.replace(/^##\s+/, '') + '</h2>';
      else if (/^#\s+/.test(line)) out += '<h1>' + escaped.replace(/^#\s+/, '') + '</h1>';
      else if (/^>\s+/.test(line)) out += '<blockquote>' + escaped.replace(/^>\s+/, '') + '</blockquote>';
      else if (/^---+$/.test(line)) out += '<hr>';
      else if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) out += '<li>' + escaped.replace(/^([-*]|\d+\.)\s+/, '') + '</li>';
      else if (!line.trim()) out += '<br>';
      else out += '<p>' + escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>') + '</p>';
    }
    return out;
  }

  function buildLineHtml(content, otherContent, side) {
    const lines = String(content || "").split("\n");
    const otherLines = String(otherContent || "").split("\n");
    return lines.map((line, index) => {
      const different = line !== (otherLines[index] || "");
      const cls = different ? (side === "current" ? "add" : "remove") : "no-change";
      return '<div class="line ' + cls + '"><div class="line-num">' + (index + 1) + '</div><div class="line-text">' + (escapeHtml(line) || '&nbsp;') + '</div></div>';
    }).join("");
  }

  function renderTabs() {
    const tabs = document.getElementById("tabs");
    tabs.innerHTML = documents.map((doc, index) => {
      return '<button class="tab ' + (index === activeIndex ? 'active' : '') + '" data-index="' + index + '">' +
        escapeHtml(doc.label) +
        '<span class="dot ' + (doc.changed ? 'changed' : 'same') + '"></span>' +
        '</button>';
    }).join('');
    tabs.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        activeIndex = Number(button.getAttribute("data-index"));
        render();
      });
    });
  }

  function renderViewToggle() {
    document.querySelectorAll(".toggle").forEach((button) => {
      const view = button.getAttribute("data-view");
      button.classList.toggle("active", view === activeView);
      button.disabled = view === "previous" && !previousRevision;
      button.addEventListener("click", () => {
        if (view === "previous" && !previousRevision) return;
        activeView = view;
        render();
      });
    });
  }

  function render() {
    const doc = documents[activeIndex];
    if (!doc) return;

    renderTabs();
    renderViewToggle();

    document.getElementById("status-badge").textContent = badgeLabel(currentStatus);
    document.getElementById("doc-title").textContent = doc.label;
    document.getElementById("doc-subtitle").textContent = doc.path;

    const pill = document.getElementById("change-pill");
    pill.textContent = doc.changed ? "Changed in this revision" : "Unchanged vs previous";
    pill.className = 'pill ' + (doc.changed ? 'changed' : 'same');

    const container = document.getElementById("doc-container");
    const previous = doc.previousContent || "";
    const current = doc.content || "";

    if (activeView === "current") {
      container.innerHTML = '<div class="markdown">' + simpleMarkdown(current) + '</div>';
      return;
    }

    if (activeView === "previous") {
      container.innerHTML = previousRevision
        ? '<div class="markdown">' + simpleMarkdown(previous) + '</div>'
        : '<div class="empty">No previous revision available for this feature yet.</div>';
      return;
    }

    if (!previousRevision) {
      container.innerHTML = '<div class="empty">This is the first review for this feature, so there is no diff yet. Switch to Current to read the generated docs.</div>';
      return;
    }

    container.innerHTML = '<div class="diff-grid">' +
      '<div><div class="pane-title">Previous</div><div class="line-pane"><div class="line-list">' + buildLineHtml(previous, current, 'previous') + '</div></div></div>' +
      '<div><div class="pane-title">Current</div><div class="line-pane"><div class="line-list">' + buildLineHtml(current, previous, 'current') + '</div></div></div>' +
      '</div>';
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
  }

  if (currentStatus === "approved") {
    const btn = document.getElementById("btn-approve");
    btn.disabled = true;
    btn.textContent = "Already Approved";
    document.getElementById("hint-text").textContent = "This revision is already approved.";
  }

  render();
</script>
</body>
</html>`;
}
