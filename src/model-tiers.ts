import type { FeatureAgentConfig, FeatureFlowConfig } from "./types.js";

export type ResolvedModelRole = {
  model?: string;
  thinking?: FeatureAgentConfig["thinking"];
  source: "explicit";
};

/**
 * Resolve the configured model/thinking for a role.
 *
 * This repo currently stores per-role concrete overrides directly in config,
 * so resolution is intentionally simple: return the role's configured values.
 * The helper exists so the extension can keep a single call site even if
 * future model tier indirection is reintroduced.
 */
export function resolveModelForRole(
  config: FeatureFlowConfig,
  role: string,
): ResolvedModelRole | undefined {
  const roleConfig = config.agents?.[role as keyof NonNullable<FeatureFlowConfig["agents"]>];
  if (!roleConfig) return undefined;
  if (!roleConfig.model && !roleConfig.thinking) return undefined;
  return {
    model: roleConfig.model,
    thinking: roleConfig.thinking,
    source: "explicit",
  };
}
