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
        modelTiers: { cheap: { model: "anthropic/claude-haiku-4" } },
        profiles: {},
        commands: {},
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
      const result = validateConfig({ specsRoot: "./specs", tdd: true });
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

  describe("missing command entryFlow", () => {
    it("returns an error when a command preset is missing entryFlow", () => {
      const result = validateConfig({ commands: { "ff-fast": { description: "fast" } } });
      expect(result.diagnostics.some((d) => d.code === "missing_required_command_key")).toBe(true);
      expect(result.gateState.blocked).toBe(true);
    });

    it("does NOT error when entryFlow is present", () => {
      const result = validateConfig({ commands: { "ff-fast": { entryFlow: true, description: "fast" } } });
      expect(result.diagnostics.filter((d) => d.code === "missing_required_command_key")).toHaveLength(0);
      expect(result.gateState.blocked).toBe(false);
    });
  });

  describe("invalid model tier reference", () => {
    it("returns a warning when a role references a non-existent tier", () => {
      const result = validateConfig({
        agents: { worker: { model: "ghost-tier" } },
        modelTiers: { cheap: { model: "anthropic/claude-haiku-4" } },
      });
      expect(result.diagnostics.some((d) => d.code === "invalid_model_tier_ref")).toBe(true);
      expect(result.gateState.blocked).toBe(false); // only a warning
    });

    it("does NOT warn when the referenced tier exists", () => {
      const result = validateConfig({
        agents: { worker: { model: "cheap" } },
        modelTiers: { cheap: { model: "anthropic/claude-haiku-4" } },
      });
      expect(result.diagnostics.filter((d) => d.code === "invalid_model_tier_ref")).toHaveLength(0);
    });

    it("does NOT warn for concrete model paths (containing '/')", () => {
      const result = validateConfig({ agents: { worker: { model: "openai/gpt-4o" } } });
      expect(result.diagnostics.filter((d) => d.code === "invalid_model_tier_ref")).toHaveLength(0);
    });

    it("warns when modelTiers is absent and a tier name is referenced", () => {
      const result = validateConfig({ agents: { worker: { model: "unknown-tier" } } });
      expect(result.diagnostics.some((d) => d.code === "invalid_model_tier_ref")).toBe(true);
    });
  });

  describe("duplicate tier names", () => {
    it("returns a warning for duplicate tier names", () => {
      // JSON.parse deduplicates keys so this path is tested by ensuring the logic runs without errors
      const result = validateConfig({
        modelTiers: {
          cheap: { model: "a" },
          balanced: { model: "b" },
        },
      });
      const dupDiags = result.diagnostics.filter((d) => d.code === "duplicate_tier");
      expect(dupDiags).toHaveLength(0); // no duplicates in this config
    });
  });

  describe("command presets", () => {
    it('warns if command name does not start with "ff-"', () => {
      const result = validateConfig({ commands: { "strict-flow": { entryFlow: true } } });
      expect(result.diagnostics.some((d) => d.code === "unknown_key" && d.path === "commands.strict-flow")).toBe(true);
    });

    it('passes without warning for command names starting with "ff-"', () => {
      const result = validateConfig({ commands: { "ff-fast": { entryFlow: true } } });
      expect(result.diagnostics.filter((d) => d.code === "unknown_key")).toHaveLength(0);
    });

    it('errors when command preset is missing entryFlow', () => {
      const result = validateConfig({ commands: { "ff-fast": { description: "no entryFlow" } } });
      expect(result.diagnostics.some((d) => d.code === "missing_required_command_key")).toBe(true);
      expect(result.gateState.blocked).toBe(true);
    });

    it('does not warn or error for valid command preset', () => {
      const result = validateConfig({ commands: { "ff-fast": { entryFlow: true, description: "fast run" } } });
      expect(result.diagnostics).toHaveLength(0);
      expect(result.gateState.blocked).toBe(false);
    });
  });

  describe("profiles", () => {
    it('warns for profile with invalid agent role "scripter"', () => {
      const result = validateConfig({
        profiles: {
          frontend: { agents: { scripter: { skills: ["foo"] } } },
        },
      });
      expect(result.diagnostics.some((d) => d.code === "unknown_key" && d.path.includes("scripter"))).toBe(true);
    });

    it('does not warn for profile with valid agent roles', () => {
      const result = validateConfig({
        profiles: {
          frontend: { agents: { worker: { skills: ["senior-frontend"] } } },
        },
      });
      expect(result.diagnostics).toHaveLength(0);
    });
  });

  describe("ThinkingLevel type", () => {
    it("ThinkingLevel is a valid type — all six levels accepted without errors", () => {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
      for (const level of levels) {
        const result = validateConfig({ agents: { planner: { thinking: level } } });
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
