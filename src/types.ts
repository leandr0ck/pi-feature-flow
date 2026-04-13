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

// ─── Execution ───────────────────────────────────────────────────────────────

export type ExecutionChainStep = {
  agent: string;
  task: string;
};

// ─── Config ───────────────────────────────────────────────────────────────────

export type FeatureTicketFlowConfig = {
  /** Root directory containing feature folders. Default: "./docs/technical-specs" */
  specsRoot: string;
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