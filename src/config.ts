import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig } from "./types.js";

export const DEFAULT_CONFIG: FeatureTicketFlowConfig = {
  specsRoot: "./docs/technical-specs",
  ticketsDirName: "tickets",
  registryFile: "03-ticket-registry.json",
  featureSelectorTitle: "Choose feature",
  requiredSpecFiles: ["01-master-spec.md", "02-execution-plan.md"],
  executionMode: "chain-message",
  executionTarget: "ticket-tdd-execution",
  executionStatusRequest: "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  executionPromptTemplates: {},
  executionChain: [
    {
      agent: "planner",
      task: "Plan implementation for feature={feature}; ticket={ticket}. Keep scope strict and output only the minimal execution plan.",
    },
    {
      agent: "implementer",
      task: "Implement only feature={feature}; ticket={ticket} using the previous step. Do not broaden scope.",
    },
    {
      agent: "verifier",
      task: "Verify feature={feature}; ticket={ticket}. Return one clear final outcome token: APPROVED, BLOCKED, or NEEDS-FIX. {status_request}",
    },
  ],
  statusParsing: {
    enabled: true,
    approved: ["APPROVED"],
    blocked: ["BLOCKED"],
    needsFix: ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"],
    maxMessagesToInspect: 6,
  },
  dependencyParsing: {
    mode: "requires-line",
    requiresLabel: "Requires",
    frontmatterField: "requires",
    customPattern: "^-\\s*Depends on:\\s*(.+)$",
    splitPattern: ",",
  },
  scaffold: {
    createStarterTicket: true,
    starterTicketId: "STK-001",
    starterTicketTitle: "Initial implementation slice",
  },
};

const CONFIG_FILES = [".pi/feature-ticket-flow.json", "feature-ticket-flow.config.json"];

export async function loadConfig(cwd: string): Promise<FeatureTicketFlowConfig> {
  for (const relativePath of CONFIG_FILES) {
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<FeatureTicketFlowConfig>;
      return mergeConfig(parsed);
    } catch {
      continue;
    }
  }
  return { ...DEFAULT_CONFIG };
}

export function mergeConfig(override?: Partial<FeatureTicketFlowConfig>): FeatureTicketFlowConfig {
  return {
    ...DEFAULT_CONFIG,
    ...override,
    requiredSpecFiles: override?.requiredSpecFiles?.length ? override.requiredSpecFiles : [...DEFAULT_CONFIG.requiredSpecFiles],
    executionPromptTemplates: {
      ...DEFAULT_CONFIG.executionPromptTemplates,
      ...(override?.executionPromptTemplates || {}),
    },
    executionChain: override?.executionChain?.length ? override.executionChain : [...(DEFAULT_CONFIG.executionChain || [])],
    statusParsing: {
      ...DEFAULT_CONFIG.statusParsing,
      ...(override?.statusParsing || {}),
    },
    dependencyParsing: {
      ...DEFAULT_CONFIG.dependencyParsing,
      ...(override?.dependencyParsing || {}),
    },
    scaffold: {
      ...DEFAULT_CONFIG.scaffold,
      ...(override?.scaffold || {}),
    },
  };
}

export function resolveSpecsRoot(cwd: string, config: FeatureTicketFlowConfig) {
  return path.resolve(cwd, config.specsRoot);
}
