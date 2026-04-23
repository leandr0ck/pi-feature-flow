import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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

// ─── Default config values ───────────────────────────────────────────────────

const DEFAULT_SPECS_ROOT = "./docs";
const DEFAULT_TDD = false;
const DEFAULT_EXECUTION = {
  autoStartFirstTicketAfterPlanning: true,
  autoAdvanceToNextTicket: true,
  allowExternalToolCalls: false,
};

export function createRuntimeConfigStore(cwd: string): RuntimeConfigStore {
  // ── Fallback defaults (in-memory, used when default-config.json is missing) ──
  const fallbackDefaults: Record<string, unknown> = {
    specsRoot: DEFAULT_SPECS_ROOT,
    tdd: DEFAULT_TDD,
    execution: DEFAULT_EXECUTION,
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

  // ── Load defaults (one-time, at construction) ─────────────────────────────
  const defaultsPath = resolveDefaultConfigPath();
  let defaults: Record<string, unknown>;

  try {
    const rawDefaults = readFileSync(defaultsPath, "utf8");
    defaults = JSON.parse(rawDefaults);
  } catch {
    // If defaults file is missing, fall back to fallbackDefaults
    defaults = fallbackDefaults;
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

// ─── Config file creation ─────────────────────────────────────────────────────

const DEFAULT_CONFIG_TEMPLATE = {
  specsRoot: DEFAULT_SPECS_ROOT,
  tdd: DEFAULT_TDD,
  execution: DEFAULT_EXECUTION,
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

/**
 * Creates the default config file at `.pi/feature-flow.json` if it doesn't exist.
 * Also ensures the `.pi` directory exists.
 * Returns the path to the config file.
 */
export function ensureConfigFile(cwd: string): string {
  const configDir = path.resolve(cwd, ".pi");
  const configPath = path.resolve(configDir, "feature-flow.json");

  if (existsSync(configPath)) {
    return configPath;
  }

  // Ensure .pi directory exists
  mkdirSync(configDir, { recursive: true });

  // Write default config
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2) + "\n", "utf8");

  return configPath;
}

/**
 * Returns the path to the user config file.
 */
export function getConfigPath(cwd: string): string {
  return path.resolve(cwd, USER_CONFIG_FILE);
}

/**
 * Checks if the user config file exists.
 */
export function configExists(cwd: string): boolean {
  return existsSync(getConfigPath(cwd));
}
