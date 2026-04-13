import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AuthoringSkillsConfig, FeatureAgentName, FeatureExecutionProfile, FeatureTicketFlowConfig } from "./types.js";

// ─── Defaults (convention over configuration) ─────────────────────────────────

const DEFAULT_SPECS_ROOT = "./docs/technical-specs";

// File names inferred from convention (not configurable)
const REQUIRED_SPEC_FILES = ["01-master-spec.md", "02-execution-plan.md"] as const;
const TICKETS_DIR_NAME = "tickets";
const REGISTRY_FILE = "03-ticket-registry.json";
const STARTER_TICKET_ID = "STK-001";

// Status parsing keywords (sensible defaults)
const STATUS_REQUEST = "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.";
const APPROVED_KEYWORDS = ["APPROVED"] as const;
const BLOCKED_KEYWORDS = ["BLOCKED"] as const;
const NEEDS_FIX_KEYWORDS = ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"] as const;
const MAX_MESSAGES_TO_INSPECT = 6;

// Dependency parsing defaults (convention: `- Requires: ...`)
const REQUIRES_LABEL = "Requires";
const DEPENDENCY_SPLIT_PATTERN = ",";

// ─── Authoring skills defaults ─────────────────────────────────────────────────


const DEFAULT_AUTHORING_SKILLS: Required<AuthoringSkillsConfig> = {
  productRequirementsSkill: "prd-development",
  requirementsRefinementSkill: "spec-driven-workflow",
};

// ─── Config loading ───────────────────────────────────────────────────────────

const YAML_CONFIG_FILE = ".pi/feature-ticket-flow.yaml";
const YML_CONFIG_FILE = ".pi/feature-ticket-flow.yml";

const DEFAULT_PROFILE = "default";

const DEFAULT_CONFIG: FeatureTicketFlowConfig = {
  specsRoot: DEFAULT_SPECS_ROOT,
  defaultProfile: DEFAULT_PROFILE,
  tdd: false,
  profiles: {
    [DEFAULT_PROFILE]: {
      preferSubagents: true,
      agents: {
        planner: { agent: "planner" },
        worker: { agent: "worker" },
        reviewer: { agent: "reviewer" },
      },
    },
  },
};

export async function loadConfig(cwd: string): Promise<FeatureTicketFlowConfig> {
  const candidates = [YAML_CONFIG_FILE, YML_CONFIG_FILE].map((file) => path.resolve(cwd, file));

  for (const configPath of candidates) {
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = parseYaml(raw) as Partial<FeatureTicketFlowConfig>;
      return normalizeConfig(parsed);
    } catch {
      // try next config path
    }
  }

  return normalizeConfig({});
}

function normalizeConfig(parsed: Partial<FeatureTicketFlowConfig>): FeatureTicketFlowConfig {
  const defaultProfile = parsed.defaultProfile || DEFAULT_PROFILE;
  const mergedProfiles: Record<string, FeatureExecutionProfile> = {
    ...(DEFAULT_CONFIG.profiles || {}),
    ...(parsed.profiles || {}),
  };
  return {
    specsRoot: parsed.specsRoot || DEFAULT_SPECS_ROOT,
    defaultProfile,
    tdd: parsed.tdd ?? DEFAULT_CONFIG.tdd ?? false,
    authoringSkills: normalizeAuthoringSkills(parsed.authoringSkills),
    profiles: mergedProfiles,
  };
}

function normalizeAuthoringSkills(
  input?: Partial<AuthoringSkillsConfig>,
): Required<AuthoringSkillsConfig> {
  return {
    productRequirementsSkill: input?.productRequirementsSkill ?? DEFAULT_AUTHORING_SKILLS.productRequirementsSkill,
    requirementsRefinementSkill:
      input?.requirementsRefinementSkill ?? DEFAULT_AUTHORING_SKILLS.requirementsRefinementSkill,
  } as Required<AuthoringSkillsConfig>;
}

export function resolveExecutionProfile(
  config: FeatureTicketFlowConfig,
  text: string,
): { name: string; profile: FeatureExecutionProfile } {
  const profiles = config.profiles || {};
  const haystack = text.toLowerCase();

  for (const [name, profile] of Object.entries(profiles)) {
    if (name === (config.defaultProfile || DEFAULT_PROFILE)) continue;
    const matchAny = profile.matchAny || [];
    if (matchAny.some((term) => haystack.includes(term.toLowerCase()))) {
      return resolveExecutionProfileByName(config, name);
    }
  }

  const fallbackName = config.defaultProfile || DEFAULT_PROFILE;
  return resolveExecutionProfileByName(config, fallbackName);
}

export function resolveExecutionProfileByName(
  config: FeatureTicketFlowConfig,
  profileName: string,
): { name: string; profile: FeatureExecutionProfile } {
  const profiles = config.profiles || {};
  const defaultName = config.defaultProfile || DEFAULT_PROFILE;
  return {
    name: profileName,
    profile: mergeProfiles(profileName === defaultName ? undefined : profiles[defaultName], profiles[profileName]),
  };
}

function mergeProfiles(base?: FeatureExecutionProfile, override?: FeatureExecutionProfile): FeatureExecutionProfile {
  return {
    preferSubagents: override?.preferSubagents ?? base?.preferSubagents ?? true,
    matchAny: override?.matchAny || base?.matchAny,
    agents: {
      ...(base?.agents || {}),
      ...(override?.agents || {}),
    },
  };
}

export function renderAgentPreferences(profile: FeatureExecutionProfile): string[] {
  const lines: string[] = [];
  const orderedAgents: FeatureAgentName[] = ["planner", "worker", "reviewer"];

  for (const name of orderedAgents) {
    const agent = profile.agents?.[name];
    if (!agent) continue;
    const parts = [`- ${name}`];
    if (agent.agent) parts.push(`agent=${agent.agent}`);
    if (agent.model) parts.push(`model=${agent.model}`);
    if (agent.thinking) parts.push(`thinking=${agent.thinking}`);
    lines.push(parts.join("; "));
  }

  return lines;
}

export function resolveSpecsRoot(cwd: string, config: FeatureTicketFlowConfig): string {
  return path.resolve(cwd, config.specsRoot);
}

/**
 * Returns the fully-resolved authoring skills for a config, with defaults applied.
 * Note: normalizeAuthoringSkills guarantees all fields are present.
 */
export function resolveAuthoringSkills(
  config: FeatureTicketFlowConfig,
): Required<AuthoringSkillsConfig> {
  return (config.authoringSkills ?? DEFAULT_AUTHORING_SKILLS) as Required<AuthoringSkillsConfig>;
}

export function resolveTddEnabled(config: FeatureTicketFlowConfig): boolean {
  return config.tdd ?? false;
}

// ─── Exported constants for use in other modules ──────────────────────────────

export const DEFAULT_REQUIRED_SPEC_FILES = REQUIRED_SPEC_FILES;
export const DEFAULT_TICKETS_DIR_NAME = TICKETS_DIR_NAME;
export const DEFAULT_REGISTRY_FILE = REGISTRY_FILE;
export const DEFAULT_STARTER_TICKET_ID = STARTER_TICKET_ID;
export const DEFAULT_STATUS_REQUEST = STATUS_REQUEST;
export const DEFAULT_APPROVED_KEYWORDS = APPROVED_KEYWORDS;
export const DEFAULT_BLOCKED_KEYWORDS = BLOCKED_KEYWORDS;
export const DEFAULT_NEEDS_FIX_KEYWORDS = NEEDS_FIX_KEYWORDS;
export const DEFAULT_MAX_MESSAGES_TO_INSPECT = MAX_MESSAGES_TO_INSPECT;
export const DEFAULT_REQUIRES_LABEL = REQUIRES_LABEL;
export const DEFAULT_DEPENDENCY_SPLIT_PATTERN = DEPENDENCY_SPLIT_PATTERN;