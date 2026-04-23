import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  startRun,
  updateRun,
  finishRun,
  getRecentRuns,
  getActiveRuns,
  _resetForTesting,
  _setHistoryPath,
} from "../src/run-history.js";

const TEST_DIR = "/tmp/pi-ff-history-test";
const TEST_FILE = path.join(TEST_DIR, "feature-flow-history.jsonl");

async function rmHistory(): Promise<void> {
  try { await unlinkSync(TEST_FILE); } catch { /* ignore */ }
}

beforeEach(async () => {
  _resetForTesting();
  _setHistoryPath(TEST_FILE);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(TEST_DIR, { recursive: true });
  try { await unlinkSync(TEST_FILE); } catch { /* ignore */ }
});

afterEach(async () => {
  await rmHistory();
});

const baseEntry = {
  feature: "test-feature",
  ticketId: "STK-001",
  phase: "worker" as const,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("run-history", () => {
  describe("startRun", () => {
    it("returns a RunEntry with ts, phase_run: 0, and status: running", () => {
      const entry = startRun("tf/STK-001/worker", baseEntry);
      expect(entry.ts).toBeGreaterThan(0);
      expect(entry.phase_run).toBe(0);
      expect(entry.status).toBe("running");
      expect(entry.feature).toBe("test-feature");
    });

    it("increments phase_run on repeated calls for the same runId", () => {
      const e1 = startRun("tf/STK-001/worker", baseEntry);
      const e2 = startRun("tf/STK-001/worker", baseEntry);
      const e3 = startRun("tf/STK-001/worker", baseEntry);
      expect(e1.phase_run).toBe(0);
      expect(e2.phase_run).toBe(1);
      expect(e3.phase_run).toBe(2);
    });

    it("treats different phases as separate runIds", () => {
      const r1 = startRun("tf/STK-001/worker", { ...baseEntry, phase: "worker" });
      const r2 = startRun("tf/STK-001/reviewer", { ...baseEntry, phase: "reviewer" });
      expect(r1.phase_run).toBe(0);
      expect(r2.phase_run).toBe(0); // different phase — separate counter
    });

    it("merges optional fields into the entry", () => {
      const entry = startRun("tf/STK-001/worker", {
        ...baseEntry,
        model: "anthropic/claude-sonnet-4",
        thinking: "medium",
        skills: ["tdd"],
      });
      expect(entry.model).toBe("anthropic/claude-sonnet-4");
      expect(entry.thinking).toBe("medium");
      expect(entry.skills).toEqual(["tdd"]);
    });
  });

  describe("finishRun", () => {
    it("changes status and persists to JSONL", () => {
      const runId = "tf/STK-001/worker";
      startRun(runId, baseEntry);
      finishRun(runId, "ok");

      expect(getActiveRuns().find((r) => r.feature === "test-feature")).toBeUndefined();
      const recent = getRecentRuns(1);
      expect(recent).toHaveLength(1);
      expect(recent[0].status).toBe("ok");
      expect(recent[0].duration).toBeGreaterThanOrEqual(0);
    });

    it("records the error string when provided", () => {
      const runId = "tf/STK-001/worker";
      startRun(runId, baseEntry);
      finishRun(runId, "error", "model not found");
      const recent = getRecentRuns(1);
      expect(recent[0].error).toBe("model not found");
    });

    it("finishRun on unknown runId is a no-op", () => {
      expect(() => finishRun("unknown-run-id", "ok")).not.toThrow();
    });
  });

  describe("updateRun", () => {
    it("updates fields on an active run", () => {
      const runId = "tf/STK-001/worker";
      startRun(runId, baseEntry);
      updateRun(runId, {
        model: "openai/gpt-4o",
        thinking: "high",
        tokens: { input: 100, output: 200, cost: 0.01 },
      });
      const active = getActiveRuns();
      expect(active).toHaveLength(1);
      expect(active[0].model).toBe("openai/gpt-4o");
      expect(active[0].thinking).toBe("high");
      expect(active[0].tokens).toEqual({ input: 100, output: 200, cost: 0.01 });
    });

    it("updateRun on unknown runId is a no-op", () => {
      expect(() => updateRun("unknown", { model: "x" })).not.toThrow();
    });
  });

  describe("getRecentRuns", () => {
    it("returns entries sorted newest first", async () => {
      for (let i = 0; i < 3; i++) {
        const runId = `tf/STK-00${i}/worker`;
        startRun(runId, { ...baseEntry, ticketId: `STK-00${i}` });
        finishRun(runId, "ok");
        // Yield to event loop so Date.now() increments
        await new Promise((r) => setTimeout(r, 1));
      }
      const recent = getRecentRuns(10);
      expect(recent).toHaveLength(3);
      // Newest (STK-002) should be first; insert delays ensure ts increases
      expect(recent[0].ticketId).toBe("STK-002");
      expect(recent[1].ticketId).toBe("STK-001");
    });

    it("respects the limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        const runId = `tf/STK-00${i}/worker`;
        startRun(runId, { ...baseEntry, ticketId: `STK-00${i}` });
        finishRun(runId, "ok");
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(getRecentRuns(3)).toHaveLength(3);
    });

    it("returns empty array when no history file exists", () => {
      _setHistoryPath("/tmp/this-path-does-not-exist/history.jsonl");
      expect(getRecentRuns()).toEqual([]);
    });
  });

  describe("getActiveRuns", () => {
    it("returns only runs with status === running", () => {
      startRun("tf/STK-001/worker", { ...baseEntry, ticketId: "STK-001" });
      startRun("tf/STK-002/worker", { ...baseEntry, ticketId: "STK-002" });
      finishRun("tf/STK-001/worker", "ok"); // only STK-002 remains
      const active = getActiveRuns();
      expect(active).toHaveLength(1);
      expect(active[0].ticketId).toBe("STK-002");
    });

    it("returns empty array when no runs are active", () => {
      expect(getActiveRuns()).toEqual([]);
    });
  });

  describe("rotation", () => {
    it("rotates the file when it exceeds MAX_LINES (1000 lines)", async () => {
      // Write 1001 entries directly
      const lines: string[] = [];
      for (let i = 0; i < 1001; i++) {
        lines.push(JSON.stringify({
          feature: "tf",
          ticketId: `STK-${i}`,
          phase: "worker",
          phase_run: 0,
          ts: Date.now() - i,
          status: "ok",
        }));
      }
      await writeFileSync(TEST_FILE, lines.join("\n") + "\n", "utf8");

      // Trigger rotation by starting + finishing a run
      _setHistoryPath(TEST_FILE);
      startRun("tf/rotate/worker", { ...baseEntry, ticketId: "rotate" });
      finishRun("tf/rotate/worker", "ok");

      // After rotation: KEEP_LINES (800) existing + 1 new = ≤ 801 lines
      const raw = readFileSync(TEST_FILE, "utf8");
      const actualLines = raw.split("\n").filter(Boolean);
      expect(actualLines.length).toBeLessThanOrEqual(801);
    });
  });
});
