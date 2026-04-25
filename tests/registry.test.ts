import { describe, expect, it } from "vitest";
import type { TicketRecord, TicketRegistry } from "../src/types.js";
import {
  findNextAvailableTicket,
  areDependenciesDone,
  startTicketRun,
  resolveTicketStatus,
  setTicketStatus,
  getTicket,
} from "../src/registry.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeTicket(id: string, overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    id,
    title: `${id} ticket`,
    path: `/tmp/${id}.md`,
    dependencies: [],
    status: "pending",
    updatedAt: new Date().toISOString(),
    runs: [],
    ...overrides,
  };
}

function makeRegistry(tickets: TicketRecord[]): TicketRegistry {
  return {
    feature: "test-feature",
    version: 1,
    updatedAt: new Date().toISOString(),
    tickets,
  };
}

// ─── findNextAvailableTicket ───────────────────────────────────────────────────

describe("findNextAvailableTicket", () => {
  it("returns the first pending ticket with no dependencies", () => {
    const registry = makeRegistry([
      makeTicket("STK-001"),
      makeTicket("STK-002"),
    ]);

    expect(findNextAvailableTicket(registry)?.id).toBe("STK-001");
  });

  it("skips a pending ticket whose dependency is not done", () => {
    const registry = makeRegistry([
      makeTicket("STK-001"),
      makeTicket("STK-002", { dependencies: ["STK-001"] }),
    ]);

    // STK-001 is pending (not done) → STK-002 is blocked by it
    expect(findNextAvailableTicket(registry)?.id).toBe("STK-001");
  });

  it("returns a dependent ticket once its dependency is done", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", { status: "done" }),
      makeTicket("STK-002", { dependencies: ["STK-001"] }),
    ]);

    expect(findNextAvailableTicket(registry)?.id).toBe("STK-002");
  });

  it("prefers needs_fix tickets over pending ones", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", { status: "pending" }),
      makeTicket("STK-002", { status: "needs_fix" }),
    ]);

    expect(findNextAvailableTicket(registry)?.id).toBe("STK-002");
  });

  it("returns undefined when all tickets are done", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", { status: "done" }),
      makeTicket("STK-002", { status: "done" }),
    ]);

    expect(findNextAvailableTicket(registry)).toBeUndefined();
  });

  it("returns undefined when all remaining tickets are blocked", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", { status: "blocked" }),
    ]);

    expect(findNextAvailableTicket(registry)).toBeUndefined();
  });

  it("skips a needs_fix ticket whose dependency is not done", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", { status: "pending" }),
      makeTicket("STK-002", { status: "needs_fix", dependencies: ["STK-001"] }),
    ]);

    // STK-002 is needs_fix but STK-001 must be done first
    expect(findNextAvailableTicket(registry)?.id).toBe("STK-001");
  });
});

// ─── areDependenciesDone ──────────────────────────────────────────────────────

describe("areDependenciesDone", () => {
  it("returns true for a ticket with no dependencies", () => {
    const ticket = makeTicket("STK-001");
    const registry = makeRegistry([ticket]);

    expect(areDependenciesDone(ticket, registry)).toBe(true);
  });

  it("returns true when all dependencies are done", () => {
    const dep = makeTicket("STK-001", { status: "done" });
    const ticket = makeTicket("STK-002", { dependencies: ["STK-001"] });
    const registry = makeRegistry([dep, ticket]);

    expect(areDependenciesDone(ticket, registry)).toBe(true);
  });

  it("returns false when a dependency is pending", () => {
    const dep = makeTicket("STK-001", { status: "pending" });
    const ticket = makeTicket("STK-002", { dependencies: ["STK-001"] });
    const registry = makeRegistry([dep, ticket]);

    expect(areDependenciesDone(ticket, registry)).toBe(false);
  });

  it("returns false when a dependency is in_progress", () => {
    const dep = makeTicket("STK-001", { status: "in_progress" });
    const ticket = makeTicket("STK-002", { dependencies: ["STK-001"] });
    const registry = makeRegistry([dep, ticket]);

    expect(areDependenciesDone(ticket, registry)).toBe(false);
  });
});

// ─── startTicketRun ───────────────────────────────────────────────────────────

describe("startTicketRun", () => {
  it("marks the target ticket as in_progress and adds a run entry", () => {
    const registry = makeRegistry([makeTicket("STK-001")]);

    startTicketRun(registry, "STK-001", "start");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("in_progress");
    expect(ticket.runs).toHaveLength(1);
    expect(ticket.runs[0]!.mode).toBe("start");
    expect(ticket.runs[0]!.finishedAt).toBeUndefined();
  });

  it("sets startedAt on first run and preserves it on subsequent runs", () => {
    const registry = makeRegistry([makeTicket("STK-001")]);

    startTicketRun(registry, "STK-001", "start");
    const firstStartedAt = getTicket(registry, "STK-001")!.startedAt;

    // Simulate a retry
    resolveTicketStatus(registry, "STK-001", "needs_fix");
    startTicketRun(registry, "STK-001", "retry");

    expect(getTicket(registry, "STK-001")!.startedAt).toBe(firstStartedAt);
  });

  it("resets any other in_progress ticket back to pending when a new run starts", () => {
    const registry = makeRegistry([
      makeTicket("STK-001"),
      makeTicket("STK-002"),
    ]);

    startTicketRun(registry, "STK-001", "start");
    startTicketRun(registry, "STK-002", "start");

    expect(getTicket(registry, "STK-001")!.status).toBe("pending");
    expect(getTicket(registry, "STK-002")!.status).toBe("in_progress");
  });

  it("throws when ticketId is not found", () => {
    const registry = makeRegistry([makeTicket("STK-001")]);

    expect(() => startTicketRun(registry, "STK-999", "start")).toThrow("STK-999");
  });
});

// ─── resolveTicketStatus ──────────────────────────────────────────────────────

describe("resolveTicketStatus", () => {
  it("sets status to done and records completedAt", () => {
    const registry = makeRegistry([makeTicket("STK-001", { status: "in_progress" })]);

    resolveTicketStatus(registry, "STK-001", "done");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("done");
    expect(ticket.completedAt).toBeDefined();
  });

  it("sets status to blocked with a reason and clears completedAt", () => {
    const registry = makeRegistry([makeTicket("STK-001", { status: "in_progress", completedAt: new Date().toISOString() })]);

    resolveTicketStatus(registry, "STK-001", "blocked", "External dependency");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("blocked");
    expect(ticket.blockedReason).toBe("External dependency");
    expect(ticket.completedAt).toBeUndefined();
  });

  it("sets status to needs_fix and clears completedAt", () => {
    const registry = makeRegistry([makeTicket("STK-001", { status: "in_progress" })]);

    resolveTicketStatus(registry, "STK-001", "needs_fix", "Tests failing");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("needs_fix");
    expect(ticket.completedAt).toBeUndefined();
  });

  it("closes the open run when status is resolved", () => {
    const registry = makeRegistry([makeTicket("STK-001")]);
    startTicketRun(registry, "STK-001", "start");

    resolveTicketStatus(registry, "STK-001", "done");

    const run = getTicket(registry, "STK-001")!.runs[0]!;
    expect(run.finishedAt).toBeDefined();
    expect(run.outcome).toBe("done");
  });

  it("throws when ticketId is not found", () => {
    const registry = makeRegistry([]);

    expect(() => resolveTicketStatus(registry, "STK-999", "done")).toThrow("STK-999");
  });
});

// ─── setTicketStatus ───────────────────────────────────────────────────────────

describe("setTicketStatus", () => {
  it("sets status to pending, clears blockedReason and completedAt, and leaves open runs without an outcome", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", {
        status: "blocked",
        blockedReason: "Missing dependency",
        completedAt: new Date().toISOString(),
        runs: [{ startedAt: new Date().toISOString(), mode: "start" }],
      }),
    ]);

    setTicketStatus(registry, "STK-001", "pending");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("pending");
    expect(ticket.blockedReason).toBeUndefined();
    expect(ticket.completedAt).toBeUndefined();
    expect(ticket.runs[0]!.finishedAt).toBeDefined();
    expect(ticket.runs[0]!.outcome).toBeUndefined();
  });

  it("sets status to blocked with a reason", () => {
    const registry = makeRegistry([makeTicket("STK-001", { status: "pending" })]);

    setTicketStatus(registry, "STK-001", "blocked", "API not available");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("blocked");
    expect(ticket.blockedReason).toBe("API not available");
  });

  it("sets status to done, clears blockedReason, and records completedAt", () => {
    const registry = makeRegistry([makeTicket("STK-001", { status: "in_progress", blockedReason: "Old reason" })]);

    setTicketStatus(registry, "STK-001", "done");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.status).toBe("done");
    expect(ticket.blockedReason).toBeUndefined();
    expect(ticket.completedAt).toBeDefined();
  });

  it("closes any open run with the status as outcome", () => {
    const registry = makeRegistry([
      makeTicket("STK-001", {
        status: "in_progress",
        runs: [{ startedAt: new Date().toISOString(), mode: "start" }],
      }),
    ]);

    setTicketStatus(registry, "STK-001", "blocked");

    const ticket = getTicket(registry, "STK-001")!;
    expect(ticket.runs[0]!.finishedAt).toBeDefined();
    expect(ticket.runs[0]!.outcome).toBe("blocked");
  });

  it("throws when ticketId is not found", () => {
    const registry = makeRegistry([]);

    expect(() => setTicketStatus(registry, "STK-999", "pending")).toThrow("STK-999");
  });
});
