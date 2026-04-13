import type { TicketRecord, TicketRegistry } from "../types.js";

export type TicketViewerResult =
  | { action: "execute"; ticketId: string }
  | { action: "view"; ticketId: string }
  | { action: "refresh" }
  | { action: "cancel" };

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusLabel(status: string): { text: string; class: string } {
  switch (status) {
    case "done":
      return { text: "Done", class: "done" };
    case "in_progress":
      return { text: "In Progress", class: "in_progress" };
    case "needs_fix":
      return { text: "Needs Fix", class: "needs_fix" };
    case "blocked":
      return { text: "Blocked", class: "blocked" };
    default:
      return { text: "Pending", class: "pending" };
  }
}

function canExecute(ticket: TicketRecord, registry: TicketRegistry): boolean {
  if (ticket.status === "in_progress" || ticket.status === "done") return false;
  return ticket.dependencies.every((dep) => {
    const found = registry.tickets.find((t) => t.id.toLowerCase() === dep.toLowerCase());
    return found?.status === "done";
  });
}

function buildTicketCardData(ticket: TicketRecord, registry: TicketRegistry) {
  const sl = statusLabel(ticket.status);
  const executable = canExecute(ticket, registry);
  const currentRun = ticket.runs.at(-1);
  const lastRun = currentRun
    ? `${currentRun.mode} → ${currentRun.outcome || "..."}`
    : "no runs yet";

  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    statusLabel: sl.text,
    statusClass: sl.class,
    profileName: ticket.profileName || "default",
    blockedReason: ticket.blockedReason,
    lastRun,
    executable,
    dependencies: ticket.dependencies,
  };
}

function renderReviewBadge(status?: string): string {
  if (status === "approved") return "Approved";
  if (status === "changes_requested") return "Changes Requested";
  return "Pending Review";
}

export function generateTicketViewerHTML(opts: {
  feature: string;
  registry: TicketRegistry;
  port: number;
}): string {
  const { feature, registry, port } = opts;

  const ticketCards = registry.tickets.map((t) => buildTicketCardData(t, registry));
  const reviewStatus = registry.review?.status || "pending_review";

  // Pre-render static values
  const titleEscaped = escapeHtml(feature);
  const ticketCount = registry.tickets.length;
  const reviewBadge = renderReviewBadge(reviewStatus);
  const reviewBadgeClass = reviewStatus.replace("_", "-");

  const statsHtml = [
    `<div class="stat done"><div class="stat-value">${registry.tickets.filter((t) => t.status === "done").length}</div><div class="stat-label">Done</div></div>`,
    `<div class="stat in_progress"><div class="stat-value">${registry.tickets.filter((t) => t.status === "in_progress").length}</div><div class="stat-label">In Progress</div></div>`,
    `<div class="stat blocked"><div class="stat-value">${registry.tickets.filter((t) => t.status === "blocked").length}</div><div class="stat-label">Blocked</div></div>`,
    `<div class="stat needs_fix"><div class="stat-value">${registry.tickets.filter((t) => t.status === "needs_fix").length}</div><div class="stat-label">Needs Fix</div></div>`,
    `<div class="stat pending"><div class="stat-value">${registry.tickets.filter((t) => t.status === "pending").length}</div><div class="stat-label">Pending</div></div>`,
  ].join("");

  // Build state for client-side JS (safe JSON)
  const stateJson = JSON.stringify({
    feature: feature,
    port: port,
    tickets: ticketCards,
  }).replace(/</g, "<\\<");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titleEscaped} — Tickets</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --success: #3fb950;
    --warning: #d29922;
    --danger: #f85149;
    --accent: #58a6ff;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    display: flex;
    flex-direction: column;
  }

  .header {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .header-left .title { font-size: 20px; font-weight: 700; }
  .header-left .subtitle { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }

  .review-badge {
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-family: var(--mono);
    font-weight: 600;
  }

  .review-badge.pending-review {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid var(--warning);
  }

  .review-badge.approved {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid var(--success);
  }

  .review-badge.changes-requested {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid var(--warning);
  }

  .stats { display: flex; gap: 12px; flex-wrap: wrap; }

  .stat {
    padding: 8px 14px;
    background: var(--panel2);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-align: center;
  }

  .stat-value { font-size: 18px; font-weight: 700; }
  .stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat.done .stat-value { color: var(--success); }
  .stat.in_progress .stat-value { color: var(--accent); }
  .stat.blocked .stat-value, .stat.needs_fix .stat-value { color: var(--warning); }
  .stat.pending .stat-value { color: var(--muted); }

  .toolbar {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .toolbar button {
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    font-family: var(--font);
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toolbar button:hover {
    background: var(--bg);
    border-color: var(--accent);
  }

  .toolbar button.primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .toolbar button.primary:hover {
    background: #79b8ff;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px;
  }

  .tickets-grid { display: grid; gap: 12px; max-width: 1100px; }

  .ticket-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    transition: all 0.15s;
  }

  .ticket-card:hover { border-color: var(--accent); }
  .ticket-card.executable { border-color: var(--success); box-shadow: 0 0 0 1px rgba(63, 185, 80, 0.1); }
  .ticket-card.executable:hover { background: rgba(63, 185, 80, 0.05); }
  .ticket-card.in_progress { border-color: var(--accent); background: rgba(88, 166, 255, 0.05); }
  .ticket-card.needs_fix, .ticket-card.blocked { border-color: var(--warning); }
  .ticket-card.done { opacity: 0.7; }

  .ticket-id {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 700;
    color: var(--accent);
    min-width: 90px;
  }

  .ticket-content { flex: 1; min-width: 0; }
  .ticket-title { font-weight: 600; margin-bottom: 6px; }
  .ticket-meta { font-size: 12px; color: var(--muted); display: flex; gap: 16px; flex-wrap: wrap; }
  .ticket-meta-item { display: flex; align-items: center; gap: 4px; }

  .ticket-status {
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    font-family: var(--mono);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .ticket-status.pending {
    background: var(--panel2);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .ticket-status.in_progress {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    border: 1px solid var(--accent);
  }

  .ticket-status.done {
    background: rgba(63, 185, 80, 0.15);
    color: var(--success);
    border: 1px solid var(--success);
  }

  .ticket-status.needs_fix,
  .ticket-status.blocked {
    background: rgba(210, 153, 34, 0.15);
    color: var(--warning);
    border: 1px solid var(--warning);
  }

  .ticket-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
    align-items: center;
  }

  .ticket-actions button {
    background: var(--panel2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .ticket-actions button:hover { border-color: var(--accent); }

  .ticket-actions button.execute {
    background: var(--success);
    color: #000;
    border-color: var(--success);
    font-weight: 600;
  }

  .ticket-actions button.execute:hover { background: #4dca6e; }
  .ticket-actions button:disabled { opacity: 0.4; cursor: not-allowed; }

  .blocked-reason {
    font-size: 12px;
    color: var(--warning);
    background: rgba(210, 153, 34, 0.1);
    padding: 4px 8px;
    border-radius: 4px;
    margin-top: 6px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 12px;
    margin-top: 24px;
  }

  .section-title:first-child { margin-top: 0; }

  .footer {
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .footer .hint { font-size: 12px; color: var(--muted); }

  .footer button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 16px;
    cursor: pointer;
  }

  .footer button:hover { background: var(--panel2); color: var(--text); }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .content { animation: fadeIn 0.2s ease-out; }
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <div class="title">${titleEscaped} — Tickets</div>
    <div class="subtitle">${ticketCount} tickets</div>
  </div>
  <div class="header-right">
    <div class="review-badge ${reviewBadgeClass}">${reviewBadge}</div>
    <div class="stats">${statsHtml}</div>
  </div>
</div>

<div class="toolbar">
  <button class="primary" id="btnExecuteNext">Execute Next Available</button>
  <button onclick="refreshTickets()">Refresh</button>
  <button onclick="closeViewer()">Close</button>
</div>

<div class="content" id="content"></div>

<div class="footer">
  <span class="hint">Click "Execute" to run a ticket</span>
  <button onclick="closeViewer()">Close</button>
</div>

<script>
var state = ${stateJson};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function canExecute(ticket) {
  if (ticket.status === "in_progress" || ticket.status === "done") return false;
  return ticket.dependencies.every(function(dep) {
    var found = null;
    for (var i = 0; i < state.tickets.length; i++) {
      if (state.tickets[i].id.toLowerCase() === dep.toLowerCase()) {
        found = state.tickets[i];
        break;
      }
    }
    return found && found.status === "done";
  });
}

function statusIcon(status) {
  switch (status) {
    case "done": return "Done";
    case "in_progress": return "In Progress";
    case "needs_fix": return "Needs Fix";
    case "blocked": return "Blocked";
    default: return "Pending";
  }
}

function renderTickets() {
  var container = document.getElementById("content");
  var tickets = state.tickets;

  var groups = {
    in_progress: [],
    needs_fix: [],
    blocked: [],
    pending: [],
    done: []
  };

  for (var i = 0; i < tickets.length; i++) {
    var t = tickets[i];
    if (groups[t.status]) {
      groups[t.status].push(t);
    }
  }

  var html = "";
  var groupNames = [
    { key: "in_progress", label: "In Progress" },
    { key: "needs_fix", label: "Needs Fix" },
    { key: "blocked", label: "Blocked" },
    { key: "pending", label: "Pending" },
    { key: "done", label: "Done" }
  ];

  for (var g = 0; g < groupNames.length; g++) {
    var group = groups[groupNames[g].key];
    if (group.length === 0) continue;

    html += '<div class="section-title">' + groupNames[g].label + '</div>';
    html += '<div class="tickets-grid">';

    for (var j = 0; j < group.length; j++) {
      var ticket = group[j];
      var executable = canExecute(ticket);
      var execClass = executable ? "executable" : "";
      var disabledAttr = executable ? "" : " disabled";

      html += '<div class="ticket-card ' + ticket.status + ' ' + execClass + '">';
      html += '<div class="ticket-id">' + escapeHtml(ticket.id) + '</div>';
      html += '<div class="ticket-content">';
      html += '<div class="ticket-title">' + escapeHtml(ticket.title) + '</div>';
      html += '<div class="ticket-meta">';
      html += '<span class="ticket-meta-item">' + escapeHtml(ticket.profileName || "default") + '</span>';
      html += '<span class="ticket-meta-item">' + escapeHtml(ticket.lastRun) + '</span>';
      if (ticket.dependencies.length > 0) {
        html += '<span class="ticket-meta-item">Requires: ' + escapeHtml(ticket.dependencies.join(", ")) + '</span>';
      }
      html += '</div>';
      if (ticket.blockedReason) {
        html += '<div class="blocked-reason">' + escapeHtml(ticket.blockedReason) + '</div>';
      }
      html += '</div>';
      html += '<div class="ticket-status ' + ticket.statusClass + '">' + statusIcon(ticket.status) + '</div>';
      html += '<div class="ticket-actions">';
      html += '<button class="execute"' + disabledAttr + ' onclick="executeTicket(\'' + ticket.id + '\')">Execute</button>';
      html += '<button onclick="viewTicket(\'' + ticket.id + '\')">View</button>';
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
  }

  if (!html) {
    html = '<div class="empty-state"><div>No tickets found</div></div>';
  }

  container.innerHTML = html;
}

function executeTicket(ticketId) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", "http://localhost:" + state.port + "/action", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      window.close();
    }
  };
  xhr.send(JSON.stringify({ action: "execute", ticketId: ticketId }));
}

function viewTicket(ticketId) {
  var xhr = new XMLHttpRequest();
  xhr.open("POST", "http://localhost:" + state.port + "/action", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      window.close();
    }
  };
  xhr.send(JSON.stringify({ action: "view", ticketId: ticketId }));
}

function executeNextAvailable() {
  var tickets = state.tickets;
  var next = null;

  for (var i = 0; i < tickets.length; i++) {
    if (tickets[i].status === "needs_fix" && canExecute(tickets[i])) {
      next = tickets[i];
      break;
    }
  }

  if (!next) {
    for (var j = 0; j < tickets.length; j++) {
      if (tickets[j].status === "pending" && canExecute(tickets[j])) {
        next = tickets[j];
        break;
      }
    }
  }

  if (next) {
    executeTicket(next.id);
  } else {
    alert("No executable tickets available. All tickets are either done, blocked, or waiting for dependencies.");
  }
}

function refreshTickets() {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "http://localhost:" + state.port + "/registry", true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4 && xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      state.tickets = data.tickets.map(function(t) {
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          profileName: t.profileName,
          blockedReason: t.blockedReason,
          dependencies: t.dependencies,
          lastRun: t.runs && t.runs.length > 0
            ? t.runs[t.runs.length - 1].mode + " -> " + (t.runs[t.runs.length - 1].outcome || "...")
            : "no runs yet"
        };
      });
      renderTickets();
    }
  };
  xhr.send();
}

function closeViewer() {
  window.close();
}

document.getElementById("btnExecuteNext").addEventListener("click", executeNextAvailable);
renderTickets();
</script>
</body>
</html>`;
}
