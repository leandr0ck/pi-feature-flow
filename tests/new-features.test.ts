import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadCheckpoint,
  persistCheckpoint,
  clearCheckpoint,
  extractUsage,
} from "../src/feature-flow/state.js";
import { recordTicketCost, readFeatureCost } from "../src/registry.js";

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-new-features-"));
  return dir;
}

import { buildTicketExecutionPrompt } from "../src/feature-flow/prompts.js";

// ─── Checkpoint persistence ────────────────────────────────────────────────────

describe("checkpoint persistence", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("persists and loads a ticket-tester checkpoint", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "test-feature";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    const pending = {
      kind: "ticket-tester" as const,
      feature,
      ticketId: "STK-001",
      phase: "retry" as const,
      cwd: specsRoot,
      specsRoot,
    };

    await persistCheckpoint(pending);
    const loaded = await loadCheckpoint(specsRoot, feature);

    expect(loaded).toEqual(pending);
  });

  it("persists and loads a ticket-execution checkpoint", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "test-feature";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    const pending = {
      kind: "ticket-execution" as const,
      executionRole: "worker" as const,
      feature,
      ticketId: "STK-002",
      phase: "retry" as const,
      cwd: specsRoot,
      specsRoot,
    };

    await persistCheckpoint(pending);
    const loaded = await loadCheckpoint(specsRoot, feature);

    expect(loaded).toEqual(pending);
  });

  it("clears a checkpoint file", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "test-feature";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await persistCheckpoint({
      kind: "feature-plan" as const,
      feature,
      cwd: specsRoot,
      specsRoot,
    });

    await clearCheckpoint(specsRoot, feature);
    const loaded = await loadCheckpoint(specsRoot, feature);
    expect(loaded).toBeUndefined();
  });

  it("returns undefined when no checkpoint exists", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "no-checkpoint";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    expect(await loadCheckpoint(specsRoot, feature)).toBeUndefined();
  });

  it("overwrites an existing checkpoint", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "test-feature";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await persistCheckpoint({
      kind: "ticket-tester" as const,
      feature,
      ticketId: "STK-001",
      phase: "start" as const,
      cwd: specsRoot,
      specsRoot,
    });

    await persistCheckpoint({
      kind: "ticket-execution" as const,
      executionRole: "worker" as const,
      feature,
      ticketId: "STK-001",
      phase: "start" as const,
      cwd: specsRoot,
      specsRoot,
    });

    const loaded = await loadCheckpoint(specsRoot, feature);
    expect(loaded?.kind).toBe("ticket-execution");
  });
});

// ─── Usage extraction ────────────────────────────────────────────────────────

describe("extractUsage", () => {
  it("returns zero usage for messages without usage data", () => {
    const messages = [{ role: "assistant", content: "hello" }];
    const result = extractUsage(messages);
    expect(result.costUsd).toBe(0);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("sums usage across multiple assistant messages", () => {
    const messages = [
      { role: "user", content: "prompt" },
      { role: "assistant", content: "a", usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, cost: { total: 0.001 } } },
      { role: "assistant", content: "b", usage: { input: 200, output: 100, cacheRead: 40, cacheWrite: 20, cost: { total: 0.003 } } },
    ];
    const result = extractUsage(messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
    expect(result.cacheReadTokens).toBe(60);
    expect(result.cacheWriteTokens).toBe(30);
    expect(result.costUsd).toBe(0.004);
  });

  it("ignores non-assistant messages", () => {
    const messages = [
      { role: "user", content: "prompt", usage: { input: 9999, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
      { role: "tool", content: "result", usage: { input: 9999, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    ];
    const result = extractUsage(messages as Array<{ role: string; content?: unknown; usage?: unknown }>);
    expect(result.inputTokens).toBe(0);
  });
});

// ─── Cost tracking ────────────────────────────────────────────────────────────

describe("cost tracking", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("records and reads a single cost entry", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "cost-feature";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      costUsd: 0.005,
      model: "anthropic/claude-sonnet-4-20250514",
      recordedAt: new Date().toISOString(),
    });

    const cost = await readFeatureCost(specsRoot, feature);
    expect(cost).not.toBeNull();
    expect(cost!.totalCostUsd).toBe(0.005);
    expect(cost!.entries).toHaveLength(1);
    expect(cost!.entries[0]!.ticketId).toBe("STK-001");
    expect(cost!.entries[0]!.phase).toBe("worker");
  });

  it("accumulates cost across multiple entries", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "multi-cost";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.005, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-20250514",
    });
    await recordTicketCost(specsRoot, feature, "STK-002", "worker", 0, {
      inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.010, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const cost = await readFeatureCost(specsRoot, feature);
    expect(cost!.totalCostUsd).toBe(0.015);
    expect(cost!.entries).toHaveLength(2);
  });

  it("records tester cost separately from worker cost", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "tdd-cost";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await recordTicketCost(specsRoot, feature, "STK-001", "tester", 0, {
      inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.001, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-haiku-4-20250514",
    });
    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.010, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const cost = await readFeatureCost(specsRoot, feature);
    expect(cost!.totalCostUsd).toBe(0.011);
    const testerEntry = cost!.entries.find((e) => e.phase === "tester");
    const workerEntry = cost!.entries.find((e) => e.phase === "worker");
    expect(testerEntry).toBeDefined();
    expect(workerEntry).toBeDefined();
  });

  it("updates an existing entry when same ticket/phase/runIndex is recorded again", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "update-cost";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.005, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-20250514",
    });
    // Same ticket/phase/runIndex again (e.g. after correction)
    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 1200, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.006, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-opus-4-20250514",
    });

    const cost = await readFeatureCost(specsRoot, feature);
    expect(cost!.entries).toHaveLength(1);
    expect(cost!.totalCostUsd).toBe(0.006);
    expect(cost!.entries[0]!.inputTokens).toBe(1200);
    expect(cost!.entries[0]!.model).toBe("anthropic/claude-opus-4-20250514");
  });

  it("saves and retrieves the model field per entry", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "model-cost";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    await recordTicketCost(specsRoot, feature, "STK-001", "tester", 0, {
      inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.001, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-haiku-4-20250514",
    });
    await recordTicketCost(specsRoot, feature, "STK-001", "worker", 0, {
      inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.010, recordedAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-20250514",
    });

    const cost = await readFeatureCost(specsRoot, feature);
    expect(cost).not.toBeNull();
    expect(cost!.entries).toHaveLength(2);
    const byPhase = new Map(cost!.entries.map((e) => [e.phase, e]));
    expect(byPhase.get("tester")!.model).toBe("anthropic/claude-haiku-4-20250514");
    expect(byPhase.get("worker")!.model).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("returns null when no cost file exists", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const feature = "no-cost";
    await mkdir(path.join(specsRoot, feature), { recursive: true });

    expect(await readFeatureCost(specsRoot, feature)).toBeNull();
  });
});

// ─── Retry context prompt enrichment ──────────────────────────────────────────

describe("retry context in prompts", () => {
  it("includes workerContextPath in the prompt when phase is retry", () => {
    const prompt = buildTicketExecutionPrompt(
      "test-feature",
      "STK-001",
      "/tmp/test",
      "/tmp/test/tickets/STK-001.md",
      undefined,
      undefined,
      "/tmp/test/tickets/STK-001-worker-context.md",
      "/tmp/test/tickets/STK-001-handoff-log.md",
      { specsRoot: "./docs/technical-specs" },
      "retry",
      "/tmp/test/tickets/STK-001-worker-handoff.json",
    );
    expect(prompt).toContain("worker-context");
    expect(prompt).toContain("handoff-log");
    expect(prompt).toContain("RETRY");
    expect(prompt).toContain("read first");
    expect(prompt).toContain("worker-handoff.json");
  });

  it("does not include workerContextPath reference when phase is start", () => {
    const prompt = buildTicketExecutionPrompt(
      "test-feature",
      "STK-001",
      "/tmp/test",
      "/tmp/test/tickets/STK-001.md",
      undefined,
      undefined,
      "/tmp/test/tickets/STK-001-worker-context.md",
      "/tmp/test/tickets/STK-001-handoff-log.md",
      { specsRoot: "./docs/technical-specs" },
      "start",
      "/tmp/test/tickets/STK-001-worker-handoff.json",
    );
    expect(prompt).not.toContain("RETRY");
    expect(prompt).not.toContain("read this first");
  });
});
