import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/config-validation.js";

describe("config-validation", () => {
  describe("valid config", () => {
    it("returns zero diagnostics for a minimal valid config", () => {
      const result = validateConfig({});
      expect(result.diagnostics).toHaveLength(0);
      expect(result.gateState.blocked).toBe(false);
      expect(result.gateState.message).toBe("Config is valid.");
    });

    it("returns zero diagnostics for a fully populated valid config", () => {
      const result = validateConfig({
        specsRoot: "./docs/technical-specs",
        tdd: false,
        execution: { autoStartFirstTicketAfterPlanning: true, autoAdvanceToNextTicket: true },
        agents: { planner: {}, worker: { model: "anthropic/claude-sonnet-4" } },
      });
      expect(result.diagnostics).toHaveLength(0);
      expect(result.gateState.blocked).toBe(false);
    });

    it("treats null/undefined as valid (no user config)", () => {
      expect(validateConfig(null).gateState.blocked).toBe(false);
      expect(validateConfig(undefined).gateState.blocked).toBe(false);
    });
  });

  describe("invalid inputs", () => {
    it("tolerates non-plain-object input without throwing", () => {
      expect(() => validateConfig("not an object" as unknown)).not.toThrow();
      const result = validateConfig("not an object" as unknown);
      expect(result.gateState.blocked).toBe(false);
    });
  });

  describe("unknown keys", () => {
    it("returns a warning for an unknown top-level key", () => {
      const result = validateConfig({ unknownKey: "value" });
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0].code).toBe("unknown_key");
      expect(result.diagnostics[0].level).toBe("warning");
      expect(result.diagnostics[0].path).toBe("unknownKey");
    });

    it("returns warnings for multiple unknown keys", () => {
      const result = validateConfig({ foo: 1, bar: 2 });
      expect(result.diagnostics).toHaveLength(2);
      expect(result.diagnostics.every((d) => d.code === "unknown_key")).toBe(true);
    });

    it("does not warn for known keys", () => {
      const result = validateConfig({ specsRoot: "./specs", tdd: true, agents: {}, execution: {} });
      expect(result.diagnostics.filter((d) => d.code === "unknown_key")).toHaveLength(0);
    });
  });

  describe("invalid thinking values", () => {
    it("returns an error for an invalid thinking value", () => {
      const result = validateConfig({ agents: { worker: { thinking: "mega" } } });
      expect(result.diagnostics.some((d) => d.code === "invalid_thinking")).toBe(true);
      expect(result.gateState.blocked).toBe(true);
    });

    it("accepts all six valid thinking levels", () => {
      for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
        const result = validateConfig({ agents: { worker: { thinking: level } } });
        expect(result.diagnostics.filter((d) => d.code === "invalid_thinking")).toHaveLength(0);
      }
    });
  });

  describe("gateState", () => {
    it("blocked is true when there are errors", () => {
      const result = validateConfig({ tdd: "not a boolean" });
      expect(result.gateState.blocked).toBe(true);
    });

    it("blocked is false when there are only warnings", () => {
      const result = validateConfig({ unknownKey: "val" });
      expect(result.gateState.blocked).toBe(false);
    });

    it("message reflects the diagnostic state", () => {
      const errors = validateConfig({ tdd: "not boolean" });
      expect(errors.gateState.message).toContain("error");

      const warnings = validateConfig({ unknownKey: "val" });
      expect(warnings.gateState.message).toContain("warning");

      const clean = validateConfig({});
      expect(clean.gateState.message).toBe("Config is valid.");
    });
  });
});
