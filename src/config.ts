import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig } from "./types.js";

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

// ─── Config loading ───────────────────────────────────────────────────────────

const CONFIG_FILE = ".pi/feature-ticket-flow.json";

export async function loadConfig(cwd: string): Promise<FeatureTicketFlowConfig> {
  const configPath = path.resolve(cwd, CONFIG_FILE);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FeatureTicketFlowConfig>;
    return { ...parsed, specsRoot: parsed.specsRoot || DEFAULT_SPECS_ROOT };
  } catch {
    return { specsRoot: DEFAULT_SPECS_ROOT };
  }
}

export function resolveSpecsRoot(cwd: string, config: FeatureTicketFlowConfig): string {
  return path.resolve(cwd, config.specsRoot);
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