import chalk from "chalk";
import { Container, Text, Box } from "@mariozechner/pi-tui";
import type { FeatureFlowConfig } from "../types.js";
import type { ConfigGateState } from "../config-validation.js";
import type { Phase } from "../run-history.js";

interface SettingsConfig {
  specsRoot: string;
  tdd?: boolean;
  execution?: { autoStartFirstTicketAfterPlanning?: boolean; autoAdvanceToNextTicket?: boolean };
  agents?: Partial<Record<Phase, { model?: string; thinking?: string }>>;
  modelTiers?: Record<string, { model: string; thinking?: string }>;
}

// ─── Panel constants ─────────────────────────────────────────────────────────

const W = 58;
const BORDER_COLOR_FN = (text: string) => chalk.bgGray(text);
const DIM_FN = (text: string) => chalk.dim(text);
const SUCCESS_FN = (text: string) => chalk.green(text);
const ERROR_FN = (text: string) => chalk.red(text);
const WARNING_FN = (text: string) => chalk.yellow(text);
const ACCENT_FN = (text: string) => chalk.cyan(text);

// ─── Truncation helper (avoids ANSI bleed) ──────────────────────────────────

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate text to maxWidth, preserving ANSI styling through the ellipsis.
 * Unlike pi-tui's truncateToWidth which adds \x1b[0m before ellipsis (breaking backgrounds),
 * this implementation tracks active ANSI styles and re-applies them.
 */
function truncLine(text: string, maxWidth: number): string {
  const visible = (s: string): number => {
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

// ─── Pure renderer using pi-tui components ──────────────────────────────────

function renderDiagnosticRow(
  level: "error" | "warning",
  code: string,
  message: string,
): string[] {
  const icon = level === "error" ? ERROR_FN("✗") : WARNING_FN("⚠");
  const innerW = W - 8;
  return [
    `  ${icon}  ${truncLine(code, 30)}  ${truncLine(message, innerW - 34)}`,
  ];
}

/**
 * Render the settings panel as an ASCII string using pi-tui Container.
 * Read-only — no polling, no keyboard interaction.
 */
export function renderSettingsPanel(
  config: SettingsConfig,
  gateState: ConfigGateState,
): string {
  const container = new Container();

  // Header
  const headerBox = new Box(0, 0, BORDER_COLOR_FN);
  headerBox.addChild(new Text(chalk.bold(chalk.cyan("╔")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╗")), 0, 0));
  container.addChild(headerBox);

  const titleText = "  Feature Flow Settings            q / Esc close";
  const titleBox = new Box(1, 0, BORDER_COLOR_FN);
  titleBox.addChild(new Text(titleText, 0, 0));
  container.addChild(titleBox);

  const thBox = new Box(0, 0, BORDER_COLOR_FN);
  thBox.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(thBox);

  // Config section
  const configLabel = `  Config: .pi/feature-flow.json`;
  const configBox = new Box(1, 0, BORDER_COLOR_FN);
  configBox.addChild(new Text(DIM_FN(configLabel), 0, 0));
  container.addChild(configBox);

  const specsRootValue = `  specsRoot:  ${config.specsRoot}`;
  const specsBox = new Box(1, 0, BORDER_COLOR_FN);
  specsBox.addChild(new Text(truncLine(specsRootValue, W - 4), 0, 0));
  container.addChild(specsBox);

  const tddValue = `  tdd:        ${config.tdd ?? false}`;
  const tddBox = new Box(1, 0, BORDER_COLOR_FN);
  tddBox.addChild(new Text(truncLine(tddValue, W - 4), 0, 0));
  container.addChild(tddBox);

  if (config.execution) {
    const autoStartValue = `  autoStart:  ${config.execution.autoStartFirstTicketAfterPlanning ?? true}`;
    const autoStartBox = new Box(1, 0, BORDER_COLOR_FN);
    autoStartBox.addChild(new Text(truncLine(autoStartValue, W - 4), 0, 0));
    container.addChild(autoStartBox);

    const autoAdvanceValue = `  autoAdvance: ${config.execution.autoAdvanceToNextTicket ?? true}`;
    const autoAdvanceBox = new Box(1, 0, BORDER_COLOR_FN);
    autoAdvanceBox.addChild(new Text(truncLine(autoAdvanceValue, W - 4), 0, 0));
    container.addChild(autoAdvanceBox);
  }

  // Section divider
  const th2Box = new Box(0, 0, BORDER_COLOR_FN);
  th2Box.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(th2Box);

  // Model tiers section
  const tiersLabel = "  Model Tiers";
  const tiersBox = new Box(1, 0, BORDER_COLOR_FN);
  tiersBox.addChild(new Text(DIM_FN(tiersLabel), 0, 0));
  container.addChild(tiersBox);

  const tiers = config.modelTiers ?? {};
  if (Object.keys(tiers).length === 0) {
    const emptyBox = new Box(1, 0, BORDER_COLOR_FN);
    emptyBox.addChild(new Text(DIM_FN("  — none configured —"), 0, 0));
    container.addChild(emptyBox);
  } else {
    for (const [name, tier] of Object.entries(tiers as Record<string, { model: string; thinking?: string }>)) {
      const thinking = tier.thinking ? ` thinking=${tier.thinking}` : "";
      const tierLine = `${tier.model}${thinking}`;
      const nameW = 10;
      const inner = W - nameW - 4;
      const tierValue = `  ${name.padEnd(nameW)} ${tierLine}`.padEnd(inner + nameW + 3);
      const tierBox = new Box(1, 0, BORDER_COLOR_FN);
      tierBox.addChild(new Text(truncLine(tierValue, W - 4), 0, 0));
      container.addChild(tierBox);
    }
  }

  // Section divider
  const th3Box = new Box(0, 0, BORDER_COLOR_FN);
  th3Box.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(th3Box);

  // Role → Model section
  const roleLabel = "  Role → Model";
  const roleBox = new Box(1, 0, BORDER_COLOR_FN);
  roleBox.addChild(new Text(DIM_FN(roleLabel), 0, 0));
  container.addChild(roleBox);

  const roles: Phase[] = ["planner", "tester", "worker", "reviewer", "chief"];
  for (const role of roles) {
    const agent = config.agents?.[role];
    if (!agent) continue;
    const model = agent.model ?? "—";
    const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
    const roleValue = `  ${role.padEnd(8)}  ${model}${thinking}`;
    const roleBoxItem = new Box(1, 0, BORDER_COLOR_FN);
    roleBoxItem.addChild(new Text(truncLine(roleValue, W - 4), 0, 0));
    container.addChild(roleBoxItem);
  }

  // Section divider
  const th4Box = new Box(0, 0, BORDER_COLOR_FN);
  th4Box.addChild(new Text(chalk.bold(chalk.cyan("╠")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╣")), 0, 0));
  container.addChild(th4Box);

  // Diagnostics section
  const diagLabel = "  Diagnostics";
  const diagBox = new Box(1, 0, BORDER_COLOR_FN);
  diagBox.addChild(new Text(DIM_FN(diagLabel), 0, 0));
  container.addChild(diagBox);

  if (gateState.diagnostics.length === 0) {
    const successBox = new Box(1, 0, BORDER_COLOR_FN);
    successBox.addChild(new Text(SUCCESS_FN("  ✓ Config loaded successfully"), 0, 0));
    container.addChild(successBox);
  } else {
    for (const diag of gateState.diagnostics) {
      for (const line of renderDiagnosticRow(diag.level, diag.code, diag.message)) {
        const diagLineBox = new Box(1, 0, BORDER_COLOR_FN);
        diagLineBox.addChild(new Text(line, 0, 0));
        container.addChild(diagLineBox);
      }
    }
  }

  // Footer
  const footerBox = new Box(0, 0, BORDER_COLOR_FN);
  footerBox.addChild(new Text(chalk.bold(chalk.cyan("╚")) + "═".repeat(W - 2) + chalk.bold(chalk.cyan("╝")), 0, 0));
  container.addChild(footerBox);

  return container.render(W).join("\n");
}

// ─── Interactive component ────────────────────────────────────────────────────

type CloseCallback = () => void;

/**
 * Read-only settings component. Renders once, listens for close key.
 * Uses pi-tui components for rendering.
 */
export class FeatureFlowSettingsComponent {
  private onClose: CloseCallback | undefined;

  constructor(
    opts: {
      config: SettingsConfig;
      gateState: ConfigGateState;
      onClose: CloseCallback;
      onRender: (panel: string) => void;
    },
  ) {
    this.onClose = opts.onClose;
    const panel = renderSettingsPanel(opts.config, opts.gateState);
    opts.onRender(panel);
  }

  handleKey(key: string): void {
    if (key === "q" || key === "Escape") {
      this.onClose?.();
    }
  }
}
