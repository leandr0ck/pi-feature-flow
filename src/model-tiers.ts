import type { FeatureAgentRole } from "./types.js";
import type { ThinkingLevel } from "./config-validation.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedRoleConfig {
  model: string;
  thinking?: ThinkingLevel;
  source: "tier" | "concrete";
}

/**
 * A partial FeatureFlowConfig that includes the fields needed for tier resolution.
 * This allows the module to work before modelTiers is added to the main type.
 */
interface ModelTiersConfig {
  agents?: Partial<Record<FeatureAgentRole, { model?: string; thinking?: ThinkingLevel }>>;
  modelTiers?: Record<string, { model: string; thinking?: ThinkingLevel }>;
}

// ─── Resolution logic ────────────────────────────────────────────────────────

/**
 * Resolves a role's model and thinking from the config.
 *
 * Resolution order:
 * 1. If agents[role].model contains '/' → treat as concrete model → return as-is
 * 2. If agents[role].model matches a key in modelTiers → expand to tier config
 * 3. Otherwise → return undefined (caller falls back to Pi's active model)
 *
 * If agents[role].thinking is explicitly set, it overrides the tier's thinking.
 */
export function resolveModelForRole(
  config: ModelTiersConfig,
  role: FeatureAgentRole,
): ResolvedRoleConfig | undefined {
  const agentConfig = config.agents?.[role];
  if (!agentConfig) return undefined;

  const modelValue = agentConfig.model;
  if (!modelValue) return undefined;

  // Rule 1: concrete model (contains '/')
  if (modelValue.includes("/")) {
    return { model: modelValue, source: "concrete" };
  }

  // Rule 2: tier name — check if it exists in modelTiers
  const tiers = config.modelTiers ?? {};
  const tierDef = tiers[modelValue];
  if (!tierDef) {
    // Rule 3: tier name not found → undefined
    return undefined;
  }

  // Tier found — expand to concrete model + thinking
  // Explicit thinking on the agent overrides the tier's thinking
  const thinking = agentConfig.thinking ?? tierDef.thinking;

  return {
    model: tierDef.model,
    thinking,
    source: "tier",
  };
}
