// ─── Ticket lifecycle ─────────────────────────────────────────────────────────

export type TicketStatus = "pending" | "in_progress" | "needs_fix" | "done" | "blocked";

export type TicketRunMode = "start" | "resume" | "retry";

export type TicketRunOutcome = "approved" | "blocked" | "needs_fix" | "done";

export type TicketRun = {
  startedAt: string;
  finishedAt?: string;
  mode: TicketRunMode;
  outcome?: TicketRunOutcome;
  note?: string;
  /** Tokens and cost consumed by this run (populated from agent message usage). */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
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
  version: 1;
  updatedAt: string;
  tickets: TicketRecord[];
};

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * The five agent roles in the feature workflow:
 * - planner  : reads the spec, creates execution plan + tickets
 * - tester   : writes tests before implementation (TDD red phase)
 * - worker   : implements the ticket
 * - reviewer : reviews the implementation
 * - chief    : updates ticket state and maintains feature memory across tickets
 */
export type FeatureAgentRole = "planner" | "tester" | "worker" | "reviewer" | "chief";

export type FeatureAgentConfig = {
  /** Pi agent name to delegate to (e.g. "claude", "worker") */
  agent?: string;
  /** Model override for this role */
  model?: string;
  /** Thinking intensity */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Skill names to activate when running this role */
  skills?: string[];
};

export type FeatureFlowExecutionConfig = {
  /** Start the first available ticket automatically after planning. Default: true */
  autoStartFirstTicketAfterPlanning?: boolean;
  /** Continue automatically to subsequent tickets after one ticket finishes. Default: true */
  autoAdvanceToNextTicket?: boolean;
  /** When true, disables bash command blocking (allows migrate, db:push, direct SQL, etc. outside session). Default: false */
  allowExternalToolCalls?: boolean;
};

export type FeatureFlowConfig = {
  /** Root directory containing feature folders. Default: "./docs" */
  specsRoot: string;
  /** Enable TDD-oriented execution. Default: false */
  tdd?: boolean;
  /** Auto-execution behavior for ticket progression */
  execution?: FeatureFlowExecutionConfig;
  /** Per-role agent configuration */
  agents?: Partial<Record<FeatureAgentRole, FeatureAgentConfig>>;
  /** Named model tiers for reusable model+thinking combos */
  modelTiers?: Record<string, ModelTierConfig>;
  /** Skill+model overrides per ticket profile */
  profiles?: Record<string, ProfileOverlay>;
  /** Named command presets with override policies */
  commands?: Record<string, CommandPreset>;
};

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelTierConfig {
  model: string;
  thinking?: ThinkingLevel;
}

export interface CommandPreset {
  description?: string;
  tdd?: boolean;
  agents?: Partial<Record<FeatureAgentRole, FeatureAgentConfig>>;
}

export interface ProfileOverlay {
  agents?: Partial<Record<FeatureAgentRole, FeatureAgentConfig>>;
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type ExecutionChainStep = {
  agent: string;
  task: string;
};

// ─── Validation ───────────────────────────────────────────────────────────────

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
    | "orphan-ticket"
    | "ticket-template-mismatch"
    | "execution-plan-template-mismatch";
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

// ─── Cost tracking ─────────────────────────────────────────────────────────

export type TicketCostEntry = {
  ticketId: string;
  phase: "tester" | "worker" | "reviewer" | "chief";
  runIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  recordedAt: string;
};

export type FeatureCost = {
  feature: string;
  totalCostUsd: number;
  entries: TicketCostEntry[];
  updatedAt: string;
};
