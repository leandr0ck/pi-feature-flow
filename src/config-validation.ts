// ─── Shared types for config diagnostics ──────────────────────────────────

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ConfigDiagnosticLevel = "error" | "warning";

export interface ConfigDiagnostic {
  level: ConfigDiagnosticLevel;
  code: string;
  path: string;
  message: string;
}

export interface ConfigGateState {
  blocked: boolean;
  diagnostics: ConfigDiagnostic[];
  message: string;
}

export interface ConfigValidationResult {
  diagnostics: ConfigDiagnostic[];
  gateState: ConfigGateState;
}

// ─── Diagnostic codes ──────────────────────────────────────────────────────

const DIAG_CODES = {
  INVALID_JSON: "invalid_json",
  UNKNOWN_KEY: "unknown_key",
  INVALID_SPECS_ROOT: "invalid_specs_root",
  INVALID_TDD: "invalid_tdd",
  INVALID_THINKING: "invalid_thinking",
} as const;

const VALID_THINKING_VALUES: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "specsRoot",
  "tdd",
  "execution",
  "agents",
]);

// ─── Core validation ───────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Validates a raw config object and returns diagnostics + gate state.
 * Does NOT throw — all errors are collected and returned.
 */
export function validateConfig(raw: unknown): ConfigValidationResult {
  const diagnostics: ConfigDiagnostic[] = [];

  if (raw === null || raw === undefined) {
    return makeResult(diagnostics);
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return makeResult(diagnostics);
  }

  const config = raw as Record<string, unknown>;

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push({
        level: "warning",
        code: DIAG_CODES.UNKNOWN_KEY,
        path: key,
        message: `Unknown top-level key "${key}" in feature-flow config. This key will be ignored.`,
      });
    }
  }

  if ("specsRoot" in config && config.specsRoot !== undefined && !isString(config.specsRoot)) {
    diagnostics.push({
      level: "error",
      code: DIAG_CODES.INVALID_SPECS_ROOT,
      path: "specsRoot",
      message: `specsRoot must be a string, got ${typeof config.specsRoot}`,
    });
  }

  if ("tdd" in config && config.tdd !== undefined && !isBoolean(config.tdd)) {
    diagnostics.push({
      level: "error",
      code: DIAG_CODES.INVALID_TDD,
      path: "tdd",
      message: `tdd must be a boolean, got ${typeof config.tdd}`,
    });
  }

  const agents = config.agents;
  if (isPlainObject(agents)) {
    for (const [role, agentConfig] of Object.entries(agents)) {
      if (!isPlainObject(agentConfig)) continue;

      if ("thinking" in agentConfig && agentConfig.thinking !== undefined) {
        if (!VALID_THINKING_VALUES.includes(agentConfig.thinking as ThinkingLevel)) {
          diagnostics.push({
            level: "error",
            code: DIAG_CODES.INVALID_THINKING,
            path: `agents.${role}.thinking`,
            message: `thinking must be one of ${VALID_THINKING_VALUES.join(", ")}, got "${agentConfig.thinking}"`,
          });
        }
      }
    }
  }

  return makeResult(diagnostics);
}

// ─── Gate state derivation ─────────────────────────────────────────────────

function makeResult(diagnostics: ConfigDiagnostic[]): ConfigValidationResult {
  const errors = diagnostics.filter((d) => d.level === "error");
  const blocked = errors.length > 0;

  let message: string;
  if (errors.length === 0 && diagnostics.length === 0) {
    message = "Config is valid.";
  } else if (errors.length > 0) {
    message = `Config has ${errors.length} error(s). Feature-flow commands are blocked until the errors are fixed.`;
  } else {
    message = `Config has ${diagnostics.length} warning(s) but no errors. Feature-flow will run normally.`;
  }

  return { diagnostics, gateState: { blocked, diagnostics, message } };
}
