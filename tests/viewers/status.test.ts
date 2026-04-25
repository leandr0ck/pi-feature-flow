import { describe, it, expect } from "vitest";
import { renderFeatureFlowStatusSummary } from "../../src/ui/status.js";
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

describe("renderFeatureFlowStatusSummary", () => {
  it("renders a concise summary without table chrome", () => {
    const panel = renderFeatureFlowStatusSummary([], []);
    expect(panel).toContain("Feature Flow Status");
    expect(panel).toContain("Current: none");
    expect(panel).toContain("Last ticket: none");
    expect(panel).not.toContain("↑↓ select");
    expect(panel).not.toContain("q / Esc close");
  });

  it("shows the active run as current and the latest completed run as last ticket", () => {
    const active = [makeRun({ ticketId: "STK-010", status: "running", ts: 3000 })];
    const recent = [
      makeRun({ ticketId: "STK-009", status: "ok", outcome: "APPROVED", ts: 2000, duration: 120000 }),
      makeRun({ ticketId: "STK-008", status: "error", outcome: "BLOCKED", ts: 1000, error: "config invalid" }),
    ];

    const panel = renderFeatureFlowStatusSummary(recent, active);
    expect(panel).toContain("Current: app-auth / STK-010 / worker /");
    expect(panel).toContain("running");
    expect(panel).toContain("Last ticket: app-auth / STK-009 / worker /");
    expect(panel).toContain("ok");
    expect(panel).toContain("APPROVED");
    expect(panel).toContain("Active runs: 1");
    expect(panel).toContain("Recent runs: 2");
  });

  it("falls back to the latest recent run when there are no active runs", () => {
    const recent = [
      makeRun({ ticketId: "STK-007", ts: 10 }),
      makeRun({ ticketId: "STK-006", ts: 20 }),
    ];

    const panel = renderFeatureFlowStatusSummary(recent, []);
    expect(panel).toContain("Current: app-auth / STK-006 / worker /");
    expect(panel).toContain("Last ticket: app-auth / STK-006 / worker /");
  });
});
