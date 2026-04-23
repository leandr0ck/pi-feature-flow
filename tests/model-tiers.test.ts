import { describe, it, expect } from "vitest";
import { resolveModelForRole, type ResolvedRoleConfig } from "../src/model-tiers.js";

const MODEL_TIERS: Record<string, { model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }> = {
  cheap: { model: "anthropic/claude-haiku-4", thinking: "off" },
  balanced: { model: "anthropic/claude-sonnet-4", thinking: "medium" },
  max: { model: "openai/gpt-4.1", thinking: "high" },
};

const makeConfig = (overrides: {
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  modelTiers?: Record<string, { model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }>;
} = {}) => ({
  agents: {
    worker: {
      model: overrides.model,
      thinking: overrides.thinking,
    },
  },
  modelTiers: overrides.modelTiers ?? MODEL_TIERS,
});

describe("resolveModelForRole", () => {
  // ── Rule 1: concrete model (contains '/') ─────────────────────────────────

  it("returns concrete model as-is when model contains '/'", () => {
    const result = resolveModelForRole(makeConfig({ model: "openai/gpt-4o" }), "worker");
    expect(result).toEqual({ model: "openai/gpt-4o", source: "concrete" });
  });

  it("returns concrete model without thinking when not specified", () => {
    const result = resolveModelForRole(makeConfig({ model: "anthropic/claude-opus-3" }), "worker");
    expect(result!.model).toBe("anthropic/claude-opus-3");
    expect(result!.source).toBe("concrete");
    expect(result!.thinking).toBeUndefined();
  });

  // ── Rule 2: tier name resolution ─────────────────────────────────────────

  it("resolves 'cheap' tier to its model and thinking", () => {
    const result = resolveModelForRole(makeConfig({ model: "cheap" }), "worker");
    expect(result).toEqual({
      model: "anthropic/claude-haiku-4",
      thinking: "off",
      source: "tier",
    });
  });

  it("resolves 'balanced' tier correctly", () => {
    const result = resolveModelForRole(makeConfig({ model: "balanced" }), "worker");
    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4",
      thinking: "medium",
      source: "tier",
    });
  });

  it("resolves 'max' tier correctly", () => {
    const result = resolveModelForRole(makeConfig({ model: "max" }), "worker");
    expect(result).toEqual({
      model: "openai/gpt-4.1",
      thinking: "high",
      source: "tier",
    });
  });

  // ── Rule 3: tier name not found ──────────────────────────────────────────

  it("returns undefined when tier name does not exist in modelTiers", () => {
    const result = resolveModelForRole(makeConfig({ model: "ghost-tier" }), "worker");
    expect(result).toBeUndefined();
  });

  it("returns undefined when modelTiers is empty and tier name is used", () => {
    const result = resolveModelForRole(makeConfig({ model: "cheap", modelTiers: {} }), "worker");
    expect(result).toBeUndefined();
  });

  it("returns undefined when modelTiers is absent", () => {
    const cfg = { agents: { worker: { model: "cheap" } as any } } as any;
    const result = resolveModelForRole(cfg, "worker");
    expect(result).toBeUndefined();
  });

  // ── Thinking override ─────────────────────────────────────────────────────

  it("explicit thinking on agent overrides tier's thinking", () => {
    const result = resolveModelForRole(makeConfig({ model: "balanced", thinking: "high" }), "worker");
    expect(result!.model).toBe("anthropic/claude-sonnet-4"); // from tier
    expect(result!.thinking).toBe("high");                  // overridden by agent
    expect(result!.source).toBe("tier");
  });

  it("tier's thinking is used when agent has no explicit thinking", () => {
    const result = resolveModelForRole(makeConfig({ model: "max" }), "worker");
    expect(result!.thinking).toBe("high"); // from tier
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("returns undefined when role has no agent config", () => {
    const cfg = { agents: {} as any, modelTiers: MODEL_TIERS } as any;
    const result = resolveModelForRole(cfg, "worker");
    expect(result).toBeUndefined();
  });

  it("returns undefined when model is undefined", () => {
    const cfg = { agents: { worker: {} } } as any;
    const result = resolveModelForRole(cfg, "worker");
    expect(result).toBeUndefined();
  });

  it("works for any valid role (planner, tester, worker, reviewer, chief)", () => {
    for (const role of ["planner", "tester", "worker", "reviewer", "chief"] as const) {
      const cfg = {
        agents: { [role]: { model: "balanced" } },
        modelTiers: MODEL_TIERS,
      } as any;
      const result = resolveModelForRole(cfg, role);
      expect(result).toBeDefined();
      expect(result!.source).toBe("tier");
    }
  });

  it("concrete model without tier does not check modelTiers", () => {
    // Even if modelTiers is missing/empty, a concrete model path should return immediately
    const cfg = { agents: { worker: { model: "openai/gpt-4o" } } } as any;
    const result = resolveModelForRole(cfg, "worker");
    expect(result).toEqual({ model: "openai/gpt-4o", source: "concrete" });
  });
});
