import chalk from "chalk";
import type { RunEntry } from "../run-history.js";

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `00:${String(s).padStart(2, "0")}`;
}

function runSummary(run: RunEntry): string {
  const outcome = run.outcome ? ` -> ${run.outcome}` : "";
  const duration = run.duration !== undefined ? ` (${formatDuration(run.duration)})` : "";
  const state = run.status === "running" ? chalk.yellow("running") : run.status === "ok" ? chalk.green("ok") : chalk.red("error");
  return `${run.feature} / ${run.ticketId} / ${run.phase} / ${state}${outcome}${duration}`;
}

function latestRun(runs: RunEntry[]): RunEntry | undefined {
  return [...runs].sort((a, b) => b.ts - a.ts)[0];
}

/**
 * Render a concise feature-flow status summary.
 * Shows the current active ticket/run and the latest completed ticket/run.
 */
export function renderFeatureFlowStatusSummary(recent: RunEntry[], active: RunEntry[]): string {
  const current = latestRun(active) ?? latestRun(recent);
  const latest = latestRun(recent);

  const lines = [
    chalk.bold(chalk.cyan("Feature Flow Status")),
    `Current: ${current ? runSummary(current) : "none"}`,
    `Last ticket: ${latest ? runSummary(latest) : "none"}`,
    `Active runs: ${active.length}`,
    `Recent runs: ${recent.length}`,
  ];

  return lines.join("\n");
}
