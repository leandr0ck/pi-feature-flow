import { describe, expect, it } from "vitest";
import type { TicketRecord, TicketRegistry } from "../src/types.js";
import { renderFeatureStatusSummary } from "../src/render.js";

function makeTicket(id: string, overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id,
    title: `${id} ticket`,
    path: `/tmp/${id}.md`,
    dependencies: [],
    status: "pending",
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    runs: [],
    ...overrides,
  };
}

function makeRegistry(tickets: TicketRecord[]): TicketRegistry {
  return {
    feature: "demo-feature",
    version: 1,
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    tickets,
  };
}

describe("renderFeatureStatusSummary", () => {
  it("renders the most recently updated ticket with compact counts", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", {
        status: "done",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTicket("STK-002", {
        status: "blocked",
        blockedReason: "Manual fix required",
        updatedAt: "2026-01-02T00:00:00.000Z",
        runs: [{ startedAt: "2026-01-02T00:00:00.000Z", mode: "retry", outcome: "blocked" }],
      }),
    ]);

    const output = renderFeatureStatusSummary(registry);

    expect(output).toContain("Feature: demo-feature");
    expect(output).toContain("Last ticket: STK-002 — STK-002 ticket");
    expect(output).toContain("Status: blocked");
    expect(output).toContain("Reason: Manual fix required");
    expect(output).toContain("Last run: retry -> blocked");
    expect(output).toContain("Counts: done=1 | in_progress=0 | needs_fix=0 | pending=0 | blocked=1");
    expect(output).toContain("Next actionable: none");
  });

  it("shows the next actionable ticket, prioritizing needs_fix over pending", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", {
        status: "done",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeTicket("STK-002", {
        status: "pending",
        dependencies: ["STK-001"],
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeTicket("STK-003", {
        status: "needs_fix",
        dependencies: ["STK-001"],
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
    ]);

    const output = renderFeatureStatusSummary(registry);
    expect(output).toContain("Next actionable: STK-003 — STK-003 ticket (needs_fix)");
  });

  it("handles an empty registry gracefully", () => {
    const output = renderFeatureStatusSummary(makeRegistry([]));
    expect(output).toContain("Feature: demo-feature");
    expect(output).toContain("No tickets found.");
  });
});
