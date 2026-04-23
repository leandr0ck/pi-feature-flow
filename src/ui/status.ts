import chalk from "chalk";
import { Container, Text, Spacer, Box, type Component } from "@mariozechner/pi-tui";
import type { RunEntry, Phase, RunStatus } from "../run-history.js";
import { getRecentRuns, getActiveRuns } from "../run-history.js";

// ─── Panel constants ───────────────────────────────────────────────────────────

const W = 58; // panel width
const BORDER_COLOR_FN = (text: string) => chalk.bgGray(text);
const DIM_FN = (text: string) => chalk.dim(text);
const ACCENT_FN = (text: string) => chalk.cyan(text);
const SUCCESS_FN = (text: string) => chalk.green(text);
const ERROR_FN = (text: string) => chalk.red(text);
const WARNING_FN = (text: string) => chalk.yellow(text);
const SELECTED_FN = (text: string) => chalk.bold(chalk.bgBlue(text));

// ─── Truncation helper (avoids ANSI bleed like pi-subagents) ──────────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate text to maxWidth, preserving ANSI styling through the ellipsis.
 * Unlike pi-tui's truncateToWidth which adds \x1b[0m before ellipsis (breaking backgrounds),
 * this implementation tracks active ANSI styles and re-applies them.
 */
function truncLine(text: string, maxWidth: number): string {
  const visible = (s: string): number => {
    // Strip ANSI codes for width calculation
    return s.replace(/\x1b\[[0-9;]*m/g, "").length;
  };

  if (visible(text) <= maxWidth) return text;

  const targetWidth = maxWidth - 1;
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;

      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = [];
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }

    let end = i;
    while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
      end++;
    }

    const textPortion = text.slice(i, end);
    for (const seg of segmenter.segment(textPortion)) {
      const grapheme = seg.segment;
      const graphemeWidth = visible(grapheme);

      if (currentWidth + graphemeWidth > targetWidth) {
        return result + activeStyles.join("") + "…";
      }

      result += grapheme;
      currentWidth += graphemeWidth;
    }
    i = end;
  }

  return result + activeStyles.join("") + "…";
}

// ─── Pure rendering helpers ───────────────────────────────────────────────────

function phaseLabel(phase: Phase): string {
  return phase.padEnd(8);
}

function statusLabel(status: RunStatus): string {
  switch (status) {
    case "running": return chalk.yellow("running");
    case "ok":       return SUCCESS_FN("OK    ");
    case "error":    return ERROR_FN("ERROR ");
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "  —  ";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `  00:${String(s).padStart(2, "0")}`;
}

function formatTokens(tokens?: { input: number; output: number; cost: number }): string {
  if (!tokens) return "  —  ";
  return `${(tokens.input + tokens.output).toLocaleString()}`;
}

function formatOutcome(outcome?: string): string {
  if (!outcome) return "—";
  return outcome;
}

function renderRunLine(run: RunEntry, selected: boolean): string {
  const sel = selected ? SELECTED_FN("> ") : DIM_FN("  ");
  const feat = truncLine(run.feature, 12);
  const tid  = truncLine(run.ticketId, 8);
  const phas = phaseLabel(run.phase);
  const stat = statusLabel(run.status);
  const dur  = formatDuration(run.duration);
  return `${sel}${feat}  ${tid}  ${phas}  ${stat}  ${dur}`;
}

function renderDetails(run: RunEntry): string[] {
  const W_INNER = W - 4;
  const lines: string[] = [];

  function row(label: string, value: string): void {
    const paddedValue = value.padEnd(W_INNER - 20);
    lines.push(`  ${DIM_FN(label.padEnd(16))}  ${paddedValue}`);
  }

  row("Feature:", run.feature);
  row("Ticket:", run.ticketId);
  row("Phase:", run.phase);
  row("Model:", run.model ?? "—");
  row("Thinking:", run.thinking ?? "—");
  if (run.skills?.length) row("Skills:", run.skills.join(", "));
  row("Tokens:", formatTokens(run.tokens));
  row("Time:", formatDuration(run.duration));
  row("Outcome:", formatOutcome(run.outcome));
  if (run.error) row("Error:", truncLine(run.error, W_INNER - 20));
  if (run.status === "running") row("Status:", WARNING_FN("running…"));

  return lines;
}

// ─── Full panel renderer using pi-tui components ───────────────────────────────

/**
 * Render the full status panel as an ASCII string using pi-tui Container.
 * Returns the complete multi-line panel ready for display.
 */
export function renderStatusPanel(
  recent: RunEntry[],
  active: RunEntry[],
  selectedIndex: number,
): string {
  const container = new Container();

  // Header
  const headerBox = new Box(0, 0, BORDER_COLOR_FN);
  headerBox.addChild(new Text(chalk.bold(chalk.cyan("╔")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╗")), 0, 0));
  container.addChild(headerBox);

  const titleText = "  Feature Flow Status        ↑↓ select  |  q / Esc close";
  const titleBox = new Box(1, 0, BORDER_COLOR_FN);
  titleBox.addChild(new Text(titleText, 0, 0));
  container.addChild(titleBox);

  const thBox = new Box(0, 0, BORDER_COLOR_FN);
  thBox.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(thBox);

  // Active runs section
  const activeLabel = "  Active";
  const activeBox = new Box(1, 0, BORDER_COLOR_FN);
  activeBox.addChild(new Text(DIM_FN(activeLabel), 0, 0));
  container.addChild(activeBox);

  if (active.length === 0) {
    const emptyBox = new Box(1, 0, BORDER_COLOR_FN);
    emptyBox.addChild(new Text(DIM_FN("  — none —"), 0, 0));
    container.addChild(emptyBox);
  } else {
    for (const run of active) {
      const line = `${run.feature}  ${run.ticketId}  ${run.phase}  ${WARNING_FN("[running " + formatDuration() + "]")}`;
      const lineBox = new Box(1, 0, BORDER_COLOR_FN);
      lineBox.addChild(new Text(truncLine(line, W - 4), 0, 0));
      container.addChild(lineBox);
    }
  }

  // Section divider
  const th2Box = new Box(0, 0, BORDER_COLOR_FN);
  th2Box.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(th2Box);

  // Recent runs section
  const recentLabel = "  Recent";
  const recentBox = new Box(1, 0, BORDER_COLOR_FN);
  recentBox.addChild(new Text(DIM_FN(recentLabel), 0, 0));
  container.addChild(recentBox);

  if (recent.length === 0) {
    const emptyBox = new Box(1, 0, BORDER_COLOR_FN);
    emptyBox.addChild(new Text(DIM_FN("  — no history yet —"), 0, 0));
    container.addChild(emptyBox);
  } else {
    for (let i = 0; i < recent.length; i++) {
      const line = renderRunLine(recent[i], i === selectedIndex);
      const lineBox = new Box(1, 0, BORDER_COLOR_FN);
      lineBox.addChild(new Text(line, 0, 0));
      container.addChild(lineBox);
    }
  }

  // Section divider
  const th3Box = new Box(0, 0, BORDER_COLOR_FN);
  th3Box.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(th3Box);

  // Selected details section
  const detailsLabel = "  Selected Details:";
  const detailsBox = new Box(1, 0, BORDER_COLOR_FN);
  detailsBox.addChild(new Text(DIM_FN(detailsLabel), 0, 0));
  container.addChild(detailsBox);

  if (recent.length > 0 && selectedIndex < recent.length) {
    for (const detail of renderDetails(recent[selectedIndex])) {
      const detailBox = new Box(1, 0, BORDER_COLOR_FN);
      detailBox.addChild(new Text(detail, 0, 0));
      container.addChild(detailBox);
    }
  } else if (active.length > 0) {
    for (const detail of renderDetails(active[0])) {
      const detailBox = new Box(1, 0, BORDER_COLOR_FN);
      detailBox.addChild(new Text(detail, 0, 0));
      container.addChild(detailBox);
    }
  } else {
    const emptyBox = new Box(1, 0, BORDER_COLOR_FN);
    emptyBox.addChild(new Text(DIM_FN("  —"), 0, 0));
    container.addChild(emptyBox);
  }

  // Footer
  const footerBox = new Box(0, 0, BORDER_COLOR_FN);
  footerBox.addChild(new Text(chalk.bold(chalk.cyan("╚")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╝")), 0, 0));
  container.addChild(footerBox);

  return container.render(W).join("\n");
}

// ─── Interactive component ─────────────────────────────────────────────────────

type CloseCallback = () => void;
type KeyHandler = (key: string) => void;

/**
 * Interactive status component that polls run history and renders the panel.
 * Uses pi-tui components for rendering.
 */
export class FeatureFlowStatusComponent {
  private recent: RunEntry[] = [];
  private active: RunEntry[] = [];
  private selectedIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private onClose: CloseCallback;
  private keyHandler: KeyHandler;

  constructor(opts: { onClose: CloseCallback; onRender: (panel: string) => void }) {
    this.onClose = opts.onClose;
    this.keyHandler = opts.onRender;
  }

  /** Start polling and rendering. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.refresh();
    this.interval = setInterval(() => this.refresh(), 2000);
  }

  /** Stop polling. Call when the panel is dismissed. */
  stop(): void {
    this.running = false;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Handle a keyboard event. Call with the key name. */
  handleKey(key: string): void {
    if (key === "ArrowUp" || key === "↑") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.render();
    } else if (key === "ArrowDown" || key === "↓") {
      this.selectedIndex = Math.min(this.recent.length - 1, this.selectedIndex + 1);
      this.render();
    } else if (key === "q" || key === "Escape") {
      this.stop();
      this.onClose();
    }
  }

  private refresh(): void {
    this.active = getActiveRuns();
    const freshRecent = getRecentRuns(10);
    // Keep selectedIndex in bounds
    if (this.selectedIndex >= freshRecent.length) {
      this.selectedIndex = Math.max(0, freshRecent.length - 1);
    }
    this.recent = freshRecent;
    this.render();
  }

  private render(): void {
    this.keyHandler(renderStatusPanel(this.recent, this.active, this.selectedIndex));
  }
}
