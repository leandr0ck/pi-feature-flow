import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureFlowConfig } from "./types.js";
import { validateConfig, type ConfigGateState, type ConfigValidationResult } from "./config-validation.js";

// ─── Package root resolution ───────────────────────────────────────────────────

/**
 * Resolves the absolute path to `default-config.json` at the package root.
 */
function resolveDefaultConfigPath(): string {
  const selfPath = fileURLToPath(import.meta.url);
  return path.resolve(selfPath, "..", "..", "default-config.json");
}

// ─── RuntimeConfigStore interface ─────────────────────────────────────────────

export interface RuntimeConfigStore {
  getConfig(): FeatureFlowConfig;
  getGateState(): ConfigGateState;
  reloadConfig(): void;
}

// ─── Deep merge ───────────────────────────────────────────────────────────────

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const baseValue = base[key];

    if (
      overrideValue !== undefined &&
      overrideValue !== null &&
      typeof overrideValue === "object" &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      );
    } else if (overrideValue !== undefined) {
      result[key] = overrideValue;
    }
  }

  return result as T;
}

// ─── createRuntimeConfigStore ─────────────────────────────────────────────────

const USER_CONFIG_FILE = ".pi/feature-flow.json";

export function createRuntimeConfigStore(cwd: string): RuntimeConfigStore {
  // ── Load defaults (one-time, at construction) ─────────────────────────────
  const defaultsPath = resolveDefaultConfigPath();
  let defaults: Record<string, unknown>;

  try {
    const rawDefaults = readFileSync(defaultsPath, "utf8");
    defaults = JSON.parse(rawDefaults);
  } catch {
    // If defaults file is missing, fall back to a minimal in-memory default
    defaults = {
      specsRoot: "./docs/technical-specs",
      tdd: false,
      execution: {
        autoStartFirstTicketAfterPlanning: true,
        autoAdvanceToNextTicket: true,
        allowExternalToolCalls: false,
      },
      agents: {
        planner: {},
        tester: {},
        worker: {},
        reviewer: {},
        chief: {},
      },
      modelTiers: {},
      profiles: {},
      commands: {},
    };
  }

  // ── Load user config (may not exist) ──────────────────────────────────────
  const userConfigPath = path.resolve(cwd, USER_CONFIG_FILE);
  let rawUserConfig: unknown = undefined;
  let validationResult: ConfigValidationResult = {
    diagnostics: [],
    gateState: { blocked: false, diagnostics: [], message: "Config is valid." },
  };

  function loadUserConfig(): void {
    try {
      const raw = readFileSync(userConfigPath, "utf8");
      rawUserConfig = JSON.parse(raw);
    } catch {
      rawUserConfig = undefined;
    }
    validationResult = validateConfig(rawUserConfig);
  }

  loadUserConfig();

  // ── Merged config (derived, not stored) ────────────────────────────────────
  function buildMergedConfig(): FeatureFlowConfig {
    if (rawUserConfig === undefined) return defaults as FeatureFlowConfig;
    return deepMerge(defaults as Record<string, unknown>, rawUserConfig as Partial<FeatureFlowConfig>) as FeatureFlowConfig;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    getConfig(): FeatureFlowConfig {
      return buildMergedConfig();
    },

    getGateState(): ConfigGateState {
      return validationResult.gateState;
    },

    reloadConfig(): void {
      loadUserConfig();
    },
  };
}
