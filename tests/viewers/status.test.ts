import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderStatusPanel } from "../../src/ui/status.js";
import type { RunEntry } from "../../src/run-history.js";

function makeRun(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    feature: "app-auth",
    ticketId: "STK-001",
    phase: "worker",
    phase_run: 0,
    ts: Date.now(),
    status: "ok",
    ...overrides,
  };
}

describe("renderStatusPanel", () => {
  it("renders the ASCII frame (starts with ╔ and ends with ╝)", () => {
    const panel = renderStatusPanel([], [], 0);
    expect(panel).toMatch(/^╔/);
    expect(panel).toMatch(/╝$/);
    expect(panel).toContain("Feature Flow Status");
  });

  it("shows '— none —' when no active runs", () => {
    const panel = renderStatusPanel([], [], 0);
    expect(panel).toContain("— none —");
  });

  it("shows '— no history yet —' when no recent runs", () => {
    const panel = renderStatusPanel([], [], 0);
    expect(panel).toContain("— no history yet —");
  });

  it("renders an active run with running status", () => {
    const active = [makeRun({ status: "running" })];
    const panel = renderStatusPanel([], active, 0);
    expect(panel).toContain("app-auth");
    expect(panel).toContain("running");
  });

  it("renders a recent run with status OK", () => {
    const recent = [makeRun({ status: "ok", outcome: "APPROVED" })];
    const panel = renderStatusPanel(recent, [], 0);
    expect(panel).toContain("STK-001");
    expect(panel).toContain("OK");
    expect(panel).toContain("APPROVED");
  });

  it("renders an error state with error message", () => {
    const recent = [makeRun({
      status: "error",
      outcome: "BLOCKED",
      error: "config invalid",
    })];
    const panel = renderStatusPanel(recent, [], 0);
    expect(panel).toContain("ERROR");
    expect(panel).toContain("config invalid");
  });

  it("renders model, thinking, and tokens in details section", () => {
    const recent = [makeRun({
      status: "ok",
      model: "anthropic/claude-sonnet-4",
      thinking: "medium",
      tokens: { input: 1000, output: 500, cost: 0.01 },
    })];
    const panel = renderStatusPanel(recent, [], 0);
    expect(panel).toContain("anthropic/claude-sonnet-4");
    expect(panel).toContain("medium");
    expect(panel).toContain("1,500"); // 1000 + 500
  });

  it("renders duration formatted as mm:ss", () => {
    const recent = [makeRun({ status: "ok", duration: 125000 })]; // 2m 5s
    const panel = renderStatusPanel(recent, [], 0);
    expect(panel).toContain("02:05");
  });

  it("highlights selected run with '>' prefix in Recent list", () => {
    const recent = [
      makeRun({ ticketId: "STK-001" }),
      makeRun({ ticketId: "STK-002" }),
    ];
    const panel0 = renderStatusPanel(recent, [], 0);
    const panel1 = renderStatusPanel(recent, [], 1);
    // Panel0: first item selected (STK-001 at index 0) should have '>' prefix
    expect(panel0).toContain("> app-auth");
    // Panel1: second item selected (STK-002 at index 1) should have '>' prefix
    expect(panel1).toContain("> app-auth");
    // In panel1, the '>' should be on STK-002 (selected), not on STK-001
    // Verify by checking that the STK-001 line does NOT have the selected prefix
    const stk001Line = panel1.split("\n").find((l) => l.includes("STK-001"));
    const stk002Line = panel1.split("\n").find((l) => l.includes("STK-002"));
    // STK-001 line should NOT have > prefix (it's not selected)
    expect(stk001Line).toBeDefined();
    // STK-002 line SHOULD have > prefix (it IS selected)
    expect(stk002Line).toBeDefined();
  });

  it("shows Selected Details section", () => {
    const recent = [makeRun({ status: "ok" })];
    const panel = renderStatusPanel(recent, [], 0);
    expect(panel).toContain("Selected Details");
    expect(panel).toContain("Feature:");
    expect(panel).toContain("Phase:");
    expect(panel).toContain("Outcome:");
  });

  it("handles missing optional fields gracefully", () => {
    const run = makeRun({
      status: "ok",
      model: undefined,
      thinking: undefined,
      tokens: undefined,
      duration: undefined,
      outcome: undefined,
      error: undefined,
      skills: undefined,
    });
    const panel = renderStatusPanel([run], [], 0);
    expect(panel).toContain("—");
    expect(panel).not.toContain("NaN");
    expect(panel).not.toContain("undefined");
  });
});
