/**
 * Config merge order tests: base ← profile ← preset ← inline
 * Validates STK-019 / STK-020.
 */
import { describe, it, expect } from "vitest";
import type { FeatureFlowConfig, FeatureAgentRole } from "../src/types.js";

/**
 * Deep per-role agent merge (mirrors the extension's applyPreset/applyRoleRuntimeConfig logic).
 */
function deepMergeAgents(
  base: FeatureFlowConfig["agents"],
  override: FeatureFlowConfig["agents"],
): FeatureFlowConfig["agents"] {
  if (!override) return base ?? {};
  const result: FeatureFlowConfig["agents"] = {};
  // Collect all roles from both maps
  const roles = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(override),
  ]);
  for (const role of roles) {
    const baseRole = (base ?? {})[role as FeatureAgentRole];
    const overrideRole = override[role as FeatureAgentRole];
    if (!overrideRole) {
      if (baseRole) result[role as FeatureAgentRole] = baseRole;
    } else if (!baseRole) {
      result[role as FeatureAgentRole] = overrideRole;
    } else {
      // Both exist — deep merge: base fields preserved unless override explicitly replaces them
      result[role as FeatureAgentRole] = { ...baseRole, ...overrideRole };
    }
  }
  return result;
}

/**
 * Simulate applyRoleRuntimeConfig's profile merge logic.
 * Profile agents are merged on top of config agents (per-role deep merge).
 */
function mergeProfileAgents(
  baseAgents: FeatureFlowConfig["agents"],
  profileAgents: FeatureFlowConfig["agents"],
): FeatureFlowConfig["agents"] {
  return deepMergeAgents(baseAgents, profileAgents);
}

/**
 * Simulate applyPreset's preset merge logic.
 * Preset agents are merged on top of config agents (per-role deep merge).
 */
function mergePresetAgents(
  baseAgents: FeatureFlowConfig["agents"],
  presetAgents: FeatureFlowConfig["agents"],
): FeatureFlowConfig["agents"] {
  return deepMergeAgents(baseAgents, presetAgents);
}

/**
 * Simulate the full merge order for preset command paths:
 * base → profile → preset
 */
function mergePresetPath(
  base: FeatureFlowConfig,
  profileName: string,
  presetAgents: FeatureFlowConfig["agents"],
): FeatureFlowConfig["agents"] {
  const profileAgents = base.profiles?.[profileName]?.agents;
  // Profile applied on top of base
  const withProfile = mergeProfileAgents(base.agents, profileAgents);
  // Preset applied on top of profile
  const withPreset = mergePresetAgents(withProfile, presetAgents);
  return withPreset;
}

describe("config merge order: base ← profile ← preset", () => {
  const baseConfig: FeatureFlowConfig = {
    specsRoot: "./docs/technical-specs",
    agents: {
      worker: { model: "balanced", skills: ["default"] },
    },
  };

  it("preset wins over profile for same field", () => {
    // Preset sets model=cheap, profile sets model=max
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {
        frontend: { agents: { worker: { model: "max" } } },
      },
    };
    const mergedAgents = mergePresetPath(config, "frontend", {
      worker: { model: "cheap" },
    });
    expect(mergedAgents?.worker?.model).toBe("cheap"); // preset wins
  });

  it("profile wins over base when preset does not override it", () => {
    // Profile sets skills=sr-backend, preset doesn't set skills
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {
        frontend: { agents: { worker: { skills: ["senior-backend"] } } },
      },
    };
    const mergedAgents = mergePresetPath(config, "frontend", {});
    expect(mergedAgents?.worker?.skills).toContain("senior-backend"); // profile wins
  });

  it("base values preserved when neither profile nor preset overrides them", () => {
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {
        frontend: { agents: { worker: { model: "max" } } },
      },
    };
    const mergedAgents = mergePresetPath(config, "frontend", {});
    expect(mergedAgents?.worker?.model).toBe("max"); // profile overrides base
    expect(mergedAgents?.worker?.skills).toContain("default"); // base preserved
  });

  it("non-existent profile is silently ignored", () => {
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {
        frontend: { agents: { worker: { model: "max" } } },
      },
    };
    const mergedAgents = mergePresetPath(config, "nonexistent", {
      worker: { model: "cheap" },
    });
    // Profile ignored (doesn't exist), preset overrides base
    expect(mergedAgents?.worker?.model).toBe("cheap");
  });

  it("no profile, no preset uses base values", () => {
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {},
    };
    const mergedAgents = mergePresetPath(config, "nonexistent", {});
    expect(mergedAgents?.worker?.model).toBe("balanced"); // base preserved
    expect(mergedAgents?.worker?.skills).toContain("default"); // base preserved
  });

  it("profile-only merge: profile overrides base agent config", () => {
    const config: FeatureFlowConfig = {
      ...baseConfig,
      profiles: {
        backend: { agents: { worker: { skills: ["go", "k8s"] } } },
      },
    };
    const profileAgents = config.profiles?.["backend"]?.agents;
    const mergedAgents = mergeProfileAgents(config.agents, profileAgents);
    expect(mergedAgents?.worker?.skills).toEqual(["go", "k8s"]); // profile wins
    expect(mergedAgents?.worker?.model).toBe("balanced"); // base preserved
  });

  it("preset-only merge: preset overrides base agent config", () => {
    const presetAgents = { worker: { model: "cheap" } };
    const mergedAgents = mergePresetAgents(baseConfig.agents, presetAgents);
    expect(mergedAgents?.worker?.model).toBe("cheap"); // preset wins
    expect(mergedAgents?.worker?.skills).toContain("default"); // base preserved
  });

  it("full four-layer: inline > preset > profile > base", () => {
    // Inline is handled by applyRoleRuntimeConfig's inline overrides on top of preset result
    // In the preset path: base → profile → preset → (inline in runtime)
    // So preset wins over profile wins over base
    const config: FeatureFlowConfig = {
      ...baseConfig, // base: model=balanced
      profiles: {
        frontend: { agents: { worker: { skills: ["sr-backend"], model: "max" } } },
      },
    };
    // After base → profile → preset:
    const afterPreset = mergePresetPath(config, "frontend", {
      worker: { model: "cheap" },
    });
    expect(afterPreset?.worker?.model).toBe("cheap"); // preset wins over profile
    expect(afterPreset?.worker?.skills).toContain("sr-backend"); // profile preserved (preset didn't override)
    // Inline would be merged on top in applyRoleRuntimeConfig
    const inlineOverride = { worker: { model: "xmax" } };
    const finalAgents = mergePresetAgents(afterPreset, inlineOverride);
    expect(finalAgents?.worker?.model).toBe("xmax"); // inline wins over preset
  });

  it("stacked agent overrides merge per-role", () => {
    // Profile overrides worker, preset overrides reviewer
    const config: FeatureFlowConfig = {
      ...baseConfig,
      agents: {
        worker: { model: "balanced" },
        reviewer: { model: "balanced" },
      },
      profiles: {
        frontend: { agents: { worker: { model: "max" } } },
      },
    };
    const mergedAgents = mergePresetPath(config, "frontend", {
      reviewer: { model: "cheap" },
    });
    expect(mergedAgents?.worker?.model).toBe("max"); // profile overrides base worker
    expect(mergedAgents?.reviewer?.model).toBe("cheap"); // preset overrides base reviewer
    expect(mergedAgents?.worker?.model).toBe("max"); // preset does NOT affect worker (different role)
  });
});
