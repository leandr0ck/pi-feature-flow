import { describe, it, expect } from "vitest";
import { renderSettingsPanel } from "../../src/ui/settings.js";

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    specsRoot: "./docs/technical-specs",
    tdd: false,
    execution: {
      autoStartFirstTicketAfterPlanning: true,
      autoAdvanceToNextTicket: true,
    },
    agents: {
      planner: {},
      tester: {},
      worker: {},
      reviewer: {},
      chief: {},
    },
    modelTiers: {},
    profiles: {},
    commands: {},
    ...overrides,
  };
}

function makeGate(diagnostics: any[] = []): any {
  return {
    blocked: diagnostics.some((d) => d.level === "error"),
    diagnostics,
    message: diagnostics.length === 0 ? "Config is valid." : `${diagnostics.length} issue(s)`,
  };
}

describe("renderSettingsPanel", () => {
  it("renders the ASCII frame", () => {
    const panel = renderSettingsPanel(makeConfig(), makeGate());
    expect(panel).toMatch(/^╔/);
    expect(panel).toMatch(/╝$/);
    expect(panel).toContain("Feature Flow Settings");
  });

  it("shows specsRoot and tdd values", () => {
    const cfg = makeConfig({ specsRoot: "./my-specs", tdd: true });
    const panel = renderSettingsPanel(cfg, makeGate());
    expect(panel).toContain("./my-specs");
    expect(panel).toContain("true");
  });

  it("shows all model tiers with model and thinking", () => {
    const cfg = makeConfig({
      modelTiers: {
        cheap: { model: "anthropic/claude-haiku-4", thinking: "off" },
        balanced: { model: "anthropic/claude-sonnet-4", thinking: "medium" },
      },
    });
    const panel = renderSettingsPanel(cfg, makeGate());
    expect(panel).toContain("cheap");
    expect(panel).toContain("anthropic/claude-haiku-4");
    expect(panel).toContain("thinking=off");
    expect(panel).toContain("balanced");
    expect(panel).toContain("anthropic/claude-sonnet-4");
  });

  it("shows '— none configured —' when modelTiers is empty", () => {
    const cfg = makeConfig();
    const panel = renderSettingsPanel(cfg, makeGate());
    expect(panel).toContain("— none configured —");
  });

  it("shows all five roles with their models", () => {
    const cfg = makeConfig({
      agents: {
        planner: { model: "balanced" },
        tester: { model: "cheap" },
        worker: { model: "balanced" },
        reviewer: { model: "max" },
        chief: { model: "cheap" },
      },
    });
    const panel = renderSettingsPanel(cfg, makeGate());
    expect(panel).toContain("planner");
    expect(panel).toContain("balanced");
    expect(panel).toContain("cheap");
    expect(panel).toContain("max");
  });

  it("shows ✓ for clean config (no diagnostics)", () => {
    const panel = renderSettingsPanel(makeConfig(), makeGate([]));
    expect(panel).toContain("✓ Config loaded successfully");
  });

  it("shows ⚠ for warning diagnostics", () => {
    const gate = makeGate([{ level: "warning", code: "unknown_key", path: "foo", message: "ignored" }]);
    const panel = renderSettingsPanel(makeConfig(), gate);
    expect(panel).toContain("⚠");
    expect(panel).toContain("unknown_key");
  });

  it("shows ✗ for error diagnostics", () => {
    const gate = makeGate([{ level: "error", code: "missing_required_command_key", path: "commands.ff-fast", message: "entryFlow missing" }]);
    const panel = renderSettingsPanel(makeConfig(), gate);
    expect(panel).toContain("✗");
    expect(panel).toContain("missing_required_command_key");
  });

  it("renders multiple diagnostics", () => {
    const gate = makeGate([
      { level: "error", code: "missing_required_command_key", path: "commands.x", message: "entryFlow missing" },
      { level: "warning", code: "unknown_key", path: "unknown", message: "ignored" },
    ]);
    const panel = renderSettingsPanel(makeConfig(), gate);
    expect(panel).toContain("✗");
    expect(panel).toContain("⚠");
    expect(panel).toContain("missing_required_command_key");
    expect(panel).toContain("unknown_key");
  });

  it("handles missing optional fields gracefully", () => {
    const cfg = makeConfig({ execution: undefined, agents: {} }) as any;
    const panel = renderSettingsPanel(cfg, makeGate());
    expect(panel).not.toContain("undefined");
    expect(panel).not.toContain("NaN");
  });
});
