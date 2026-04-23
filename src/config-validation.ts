// ─── Shared types for config diagnostics ────────────────────────────────────

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

// ─── Diagnostic codes ────────────────────────────────────────────────────────

const DIAG_CODES = {
  INVALID_JSON: "invalid_json",
  UNKNOWN_KEY: "unknown_key",
  INVALID_SPECS_ROOT: "invalid_specs_root",
  INVALID_TDD: "invalid_tdd",
  INVALID_THINKING: "invalid_thinking",
  INVALID_MODEL_TIER_REF: "invalid_model_tier_ref",
  DUPLICATE_TIER: "duplicate_tier",
  MISSING_REQUIRED_COMMAND_KEY: "missing_required_command_key",
} as const;

const VALID_THINKING_VALUES: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const VALID_AGENT_ROLES = ["planner", "tester", "worker", "reviewer", "chief"] as const;
type ValidAgentRole = (typeof VALID_AGENT_ROLES)[number];

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "specsRoot",
  "tdd",
  "execution",
  "agents",
  "modelTiers",
  "profiles",
  "commands",
]);

// ─── Core validation ──────────────────────────────────────────────────────────

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

  // null/undefined means no user config — all defaults apply
  if (raw === null || raw === undefined) {
    return makeResult(diagnostics);
  }

  // Anything that is not a plain object is tolerated (e.g. a raw string from a failed JSON.parse
  // guard) — we treat it as an empty valid config so we never crash.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return makeResult(diagnostics);
  }

  const config = raw as Record<string, unknown>;

  // ── Unknown top-level keys ─────────────────────────────────────────────────
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

  // ── specsRoot validation ────────────────────────────────────────────────────
  if ("specsRoot" in config && config.specsRoot !== undefined) {
    if (!isString(config.specsRoot)) {
      diagnostics.push({
        level: "error",
        code: DIAG_CODES.INVALID_SPECS_ROOT,
        path: "specsRoot",
        message: `specsRoot must be a string, got ${typeof config.specsRoot}`,
      });
    }
  }

  // ── tdd validation ──────────────────────────────────────────────────────────
  if ("tdd" in config && config.tdd !== undefined) {
    if (!isBoolean(config.tdd)) {
      diagnostics.push({
        level: "error",
        code: DIAG_CODES.INVALID_TDD,
        path: "tdd",
        message: `tdd must be a boolean, got ${typeof config.tdd}`,
      });
    }
  }

  // ── agents validation ───────────────────────────────────────────────────────
  const agents = config.agents;
  if (isPlainObject(agents)) {
    for (const [role, agentConfig] of Object.entries(agents)) {
      if (!isPlainObject(agentConfig)) continue;

      // Validate thinking value if set
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

      // Validate tier reference (model value is not a concrete model path)
      if ("model" in agentConfig && agentConfig.model !== undefined && isString(agentConfig.model)) {
        const modelValue = agentConfig.model;
        if (!modelValue.includes("/")) {
          // It's a tier name — check it exists in modelTiers
          const modelTiers = config.modelTiers;
          if (!isPlainObject(modelTiers) || !(modelValue in modelTiers)) {
            diagnostics.push({
              level: "warning",
              code: DIAG_CODES.INVALID_MODEL_TIER_REF,
              path: `agents.${role}.model`,
              message: `Role "${role}" references model tier "${modelValue}" which does not exist in modelTiers. The tier will be ignored.`,
            });
          }
        }
      }
    }
  }

  // ── modelTiers duplicate key check ─────────────────────────────────────────
  const modelTiers = config.modelTiers;
  if (isPlainObject(modelTiers)) {
    const tierNames = Object.keys(modelTiers);
    const seen = new Set<string>();
    for (const name of tierNames) {
      if (seen.has(name)) {
        diagnostics.push({
          level: "warning",
          code: DIAG_CODES.DUPLICATE_TIER,
          path: `modelTiers.${name}`,
          message: `Duplicate tier name "${name}" in modelTiers. Only the last definition will be used.`,
        });
      }
      seen.add(name);
    }
  }

  // ── commands validation ─────────────────────────────────────────────────────
  const commands = config.commands;
  if (isPlainObject(commands)) {
    for (const [cmdName, preset] of Object.entries(commands)) {
      if (!isPlainObject(preset)) continue;
      // Warn if command name doesn't start with "ff-"
      if (!cmdName.startsWith("ff-")) {
        diagnostics.push({
          level: "warning",
          code: DIAG_CODES.UNKNOWN_KEY,
          path: `commands.${cmdName}`,
          message: `Command preset name "${cmdName}" should start with "ff-" (e.g. "ff-fast"). The command will not be registered.`,
        });
      }
      // Check entryFlow is defined
      if (!("entryFlow" in preset) || preset.entryFlow === undefined) {
        diagnostics.push({
          level: "error",
          code: DIAG_CODES.MISSING_REQUIRED_COMMAND_KEY,
          path: `commands.${cmdName}`,
          message: `Command preset "${cmdName}" is missing required field "entryFlow". The command will not be registered.`,
        });
      }
    }
  }

  // ── profiles validation ────────────────────────────────────────────────────
  const profiles = config.profiles;
  if (isPlainObject(profiles)) {
    for (const [profileName, profile] of Object.entries(profiles)) {
      if (!isPlainObject(profile)) continue;
      const profileAgents = profile.agents;
      if (isPlainObject(profileAgents)) {
        for (const role of Object.keys(profileAgents)) {
          if (!VALID_AGENT_ROLES.includes(role as ValidAgentRole)) {
            diagnostics.push({
              level: "warning",
              code: DIAG_CODES.UNKNOWN_KEY,
              path: `profiles.${profileName}.agents.${role}`,
              message: `Profile "${profileName}" references unknown agent role "${role}". Valid roles: ${VALID_AGENT_ROLES.join(", ")}.`,
            });
          }
        }
      }
    }
  }

  return makeResult(diagnostics);
}

// ─── Gate state derivation ────────────────────────────────────────────────────

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