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
  profileName?: string;
  tickets: TicketRecord[];
};

// ─── Execution ───────────────────────────────────────────────────────────────

export type ExecutionChainStep = {
  agent: string;
  task: string;
};

// ─── Config ───────────────────────────────────────────────────────────────────

export type FeatureAgentName = "planner" | "worker" | "reviewer";

export type FeatureAgentConfig = {
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  agent?: string;
};

export type FeatureExecutionProfile = {
  preferSubagents?: boolean;
  matchAny?: string[];
  agents?: Partial<Record<FeatureAgentName, FeatureAgentConfig>>;
};

/**
 * Configurable spec-authoring skill slots.
 * These are intentionally generic so projects can swap the underlying skills
 * without changing the config schema semantics.
 *
 * @default productRequirementsSkill      = "prd-development"
 * @default requirementsRefinementSkill  = "spec-driven-workflow"
 * @default technicalDesignSkill          = "technical-specification"
 */
export type AuthoringSkillsConfig = {
  /** Skill for writing product-facing requirements: problem framing, scope, users, success criteria. */
  productRequirementsSkill?: string;
  /** Skill for tightening requirements into structured FR/NFR/acceptance criteria. */
  requirementsRefinementSkill?: string;
  /** Skill for deeper technical design: architecture, data models, contracts, rollout. */
  technicalDesignSkill?: string;
};

export type FeatureTicketFlowConfig = {
  /** Root directory containing feature folders. Default: "./docs/technical-specs" */
  specsRoot: string;
  defaultProfile?: string;
  /** Enables TDD-oriented planning and execution guidance. Responsibility for having a working test suite remains with the user/project. */
  tdd?: boolean;
  /** Configurable authoring skill slots. Applied project-wide across all profiles. Defaults are applied during config normalization. */
  authoringSkills?: Partial<AuthoringSkillsConfig>;
  profiles?: Record<string, FeatureExecutionProfile>;
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