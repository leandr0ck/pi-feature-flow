import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureAgentRole, FeatureFlowConfig } from "./types.js";

// ─── Convention-based constants (not configurable) ───────────────────────────

const DEFAULT_SPECS_ROOT = "./docs/technical-specs";
const TICKETS_DIR_NAME = "tickets";
const REGISTRY_FILE = "03-ticket-registry.json";
const FEATURE_MEMORY_FILE = "04-feature-memory.md";

// Status parsing keywords
const STATUS_REQUEST = "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.";
const APPROVED_KEYWORDS = ["APPROVED"] as const;
const BLOCKED_KEYWORDS = ["BLOCKED"] as const;
const NEEDS_FIX_KEYWORDS = ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"] as const;
const MAX_MESSAGES_TO_INSPECT = 6;

// Dependency parsing defaults
const REQUIRES_LABEL = "Requires";
const DEPENDENCY_SPLIT_PATTERN = ",";

// ─── Config loading ───────────────────────────────────────────────────────────

const JSON_CONFIG_FILE = ".pi/feature-flow.json";

const DEFAULT_CONFIG: FeatureFlowConfig = {
  specsRoot: DEFAULT_SPECS_ROOT,
  tdd: false,
  agents: {
    planner: {},
    tester: {},
    worker: {},
    reviewer: {},
    chief: {},
  },
};

export async function loadConfig(cwd: string): Promise<FeatureFlowConfig> {
  const jsonPath = path.resolve(cwd, JSON_CONFIG_FILE);
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FeatureFlowConfig>;
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

function normalizeConfig(parsed: Partial<FeatureFlowConfig>): FeatureFlowConfig {
  return {
    specsRoot: parsed.specsRoot || DEFAULT_SPECS_ROOT,
    tdd: parsed.tdd ?? false,
    agents: {
      ...DEFAULT_CONFIG.agents,
      ...(parsed.agents || {}),
    },
  };
}

export function resolveSpecsRoot(cwd: string, config: FeatureFlowConfig): string {
  return path.resolve(cwd, config.specsRoot);
}

export function resolveTddEnabled(config: FeatureFlowConfig): boolean {
  return config.tdd ?? false;
}

export function getAgentConfig(config: FeatureFlowConfig, role: FeatureAgentRole) {
  return config.agents?.[role] ?? {};
}

/**
 * Build a human-readable summary of all agent role configurations.
 */
export function renderAgentRoles(config: FeatureFlowConfig): string[] {
  const roles: FeatureAgentRole[] = ["planner", "tester", "worker", "reviewer", "chief"];
  const lines: string[] = [];

  for (const role of roles) {
    const agent = config.agents?.[role];
    if (!agent) continue;
    const parts: string[] = [`- ${role}`];
    if (agent.agent) parts.push(`agent=${agent.agent}`);
    if (agent.model) parts.push(`model=${agent.model}`);
    if (agent.thinking) parts.push(`thinking=${agent.thinking}`);
    if (agent.skills?.length) parts.push(`skills=[${agent.skills.join(", ")}]`);
    lines.push(parts.join("; "));
  }

  return lines;
}

// ─── Exported constants ───────────────────────────────────────────────────────

export const DEFAULT_TICKETS_DIR_NAME = TICKETS_DIR_NAME;
export const DEFAULT_REGISTRY_FILE = REGISTRY_FILE;
export const DEFAULT_FEATURE_MEMORY_FILE = FEATURE_MEMORY_FILE;
export const DEFAULT_STATUS_REQUEST = STATUS_REQUEST;
export const DEFAULT_APPROVED_KEYWORDS = APPROVED_KEYWORDS;
export const DEFAULT_BLOCKED_KEYWORDS = BLOCKED_KEYWORDS;
export const DEFAULT_NEEDS_FIX_KEYWORDS = NEEDS_FIX_KEYWORDS;
export const DEFAULT_MAX_MESSAGES_TO_INSPECT = MAX_MESSAGES_TO_INSPECT;
export const DEFAULT_REQUIRES_LABEL = REQUIRES_LABEL;
export const DEFAULT_DEPENDENCY_SPLIT_PATTERN = DEPENDENCY_SPLIT_PATTERN;
