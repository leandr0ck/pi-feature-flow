export type TicketStatus = "pending" | "in_progress" | "needs_fix" | "done" | "blocked";

export type TicketRunMode = "start" | "resume" | "retry";

export type TicketRunOutcome = "approved" | "blocked" | "needs_fix" | "done";

export type TicketRun = {
  startedAt: string;
  finishedAt?: string;
  mode: TicketRunMode;
  outcome?: TicketRunOutcome;
  note?: string;
};

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
  runs: TicketRun[];
};

export type TicketRegistry = {
  feature: string;
  version: 2;
  updatedAt: string;
  tickets: TicketRecord[];
};

export type DependencyParser = (content: string) => string[];

export type ExecutionChainStep = {
  agent: string;
  task: string;
};

export type FeatureTicketFlowConfig = {
  specsRoot: string;
  ticketsDirName: string;
  registryFile: string;
  featureSelectorTitle: string;
  requiredSpecFiles: string[];
  executionMode: "chain-message" | "command-message" | "custom-message" | "subagent-chain";
  executionTarget: string;
  executionPromptTemplate?: string;
  executionPromptTemplates?: Partial<Record<"start" | "resume" | "retry" | "blocked", string>>;
  executionChain?: ExecutionChainStep[];
  executionStatusRequest: string;
  statusParsing: {
    enabled: boolean;
    approved: string[];
    blocked: string[];
    needsFix: string[];
    maxMessagesToInspect: number;
  };
  dependencyParsing: {
    mode: "requires-line" | "frontmatter" | "custom";
    requiresLabel: string;
    frontmatterField: string;
    customPattern?: string;
    splitPattern?: string;
  };
  scaffold: {
    createStarterTicket: boolean;
    starterTicketId: string;
    starterTicketTitle: string;
  };
};

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  code:
    | "missing-spec-file"
    | "missing-tickets-dir"
    | "no-tickets"
    | "duplicate-ticket-id"
    | "invalid-ticket-id"
    | "duplicate-dependency"
    | "missing-dependency"
    | "dependency-cycle"
    | "orphan-ticket";
  message: string;
  ticketId?: string;
  filePath?: string;
};

export type FeatureValidationResult = {
  feature: string;
  featurePath: string;
  valid: boolean;
  issues: ValidationIssue[];
};
