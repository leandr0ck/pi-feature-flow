import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig } from "./types";

export const DEFAULT_CONFIG: FeatureTicketFlowConfig = {
  specsRoot: "./docs/technical-specs",
  ticketsDirName: "tickets",
  registryFile: "03-ticket-registry.json",
  featureSelectorTitle: "Choose feature",
  executionMode: "chain-message",
  executionTarget: "ticket-tdd-execution",
  executionStatusRequest: "When you finish, clearly say whether the result is APPROVED, BLOCKED, or NEEDS-FIX.",
  dependencyParsing: {
    mode: "requires-line",
    requiresLabel: "Requires",
  },
};

const CONFIG_FILES = [
  ".pi/feature-ticket-flow.json",
  "feature-ticket-flow.config.json",
];

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
    dependencyParsing: {
      ...DEFAULT_CONFIG.dependencyParsing,
      ...(override?.dependencyParsing || {}),
    },
  };
}

export function resolveSpecsRoot(cwd: string, config: FeatureTicketFlowConfig) {
  return path.resolve(cwd, config.specsRoot);
}
