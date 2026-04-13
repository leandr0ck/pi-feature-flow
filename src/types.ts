export type TicketStatus = "pending" | "in_progress" | "done" | "blocked";

export type TicketRecord = {
  id: string;
  title: string;
  path: string;
  dependencies: string[];
  status: TicketStatus;
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type TicketRegistry = {
  feature: string;
  version: 1;
  updatedAt: string;
  tickets: TicketRecord[];
};

export type DependencyParser = (content: string) => string[];

export type FeatureTicketFlowConfig = {
  specsRoot: string;
  ticketsDirName: string;
  registryFile: string;
  featureSelectorTitle: string;
  executionMode: "chain-message" | "command-message" | "custom-message";
  executionTarget: string;
  executionPromptTemplate?: string;
  executionStatusRequest: string;
  dependencyParsing: {
    mode: "requires-line" | "frontmatter" | "custom";
    requiresLabel: string;
  };
};
