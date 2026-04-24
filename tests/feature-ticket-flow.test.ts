import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestSession, when, type TestSession } from "@marcfargas/pi-test-harness";
import { loadConfig, resolveSpecsRoot } from "../src/config.js";
import { loadRegistry, saveRegistry, featureMemoryPath, workerContextPath } from "../src/registry.js";
import { loadCheckpoint, type PendingExecution } from "../src/feature-flow/state.js";
import { getForbiddenBashDecision, isSafeValidationCommand } from "../src/feature-flow/bash-governance.js";
import { evaluateGovernanceForToolCall } from "../extensions/feature-ticket-flow.js";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, "../extensions/feature-ticket-flow.ts");

function patchHarnessCompatibility(t: TestSession) {
  const agent = t.session.agent as { setTools?: (tools: unknown[]) => void; state?: { tools?: unknown[] } };
  if (typeof agent.setTools !== "function") {
    agent.setTools = (tools: unknown[]) => {
      if (agent.state) agent.state.tools = tools;
    };
  }
}

async function featurePaths(cwd: string, feature: string) {
  const config = await loadConfig(cwd);
  const specsRoot = resolveSpecsRoot(cwd, config);
  const featureRoot = path.join(specsRoot, feature);
  const ticketsRoot = path.join(featureRoot, "tickets");
  return { config, specsRoot, featureRoot, ticketsRoot };
}

function messageText(message: { content?: string | Array<{ type: string; text?: string }> }) {
  if (typeof message.content === "string") return message.content;
  return (message.content || [])
    .filter((part: { type: string; text?: string }) => part.type === "text")
    .map((part: { type: string; text?: string }) => part.text || "")
    .join("\n");
}

async function settleSession(t: TestSession, ms = 100) {
  await (t.session.agent as { waitForIdle?: () => Promise<void> }).waitForIdle?.();
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function currentModelRef(t: TestSession): string | undefined {
  const model = ((t.session as { model?: { provider?: string; id?: string } }).model)
    ?? ((t.session.agent as { state?: { model?: { provider?: string; id?: string } } }).state?.model);
  if (!model?.provider || !model?.id) return undefined;
  return `${model.provider}/${model.id}`;
}


/** Seed a feature with spec + execution plan + tickets ready for execution */
async function seedFeature(
  cwd: string,
  feature: string,
  tickets: Array<{ id: string; body: string }>,
) {
  const { featureRoot, ticketsRoot } = await featurePaths(cwd, feature);
  await mkdir(ticketsRoot, { recursive: true });
  await writeFile(
    path.join(featureRoot, "01-master-spec.md"),
    `# ${feature}\n\n## Goal\nTest feature.\n\n## Acceptance Criteria\n- Works.\n`,
    "utf8",
  );
  await writeFile(
    path.join(featureRoot, "02-execution-plan.md"),
    [
      `# ${feature} execution plan`,
      "",
      "## Approach Summary",
      "- Deliver a minimal valid feature package.",
      "",
      "## Ticket Sequence",
      "1. STK-001 — first slice",
      "",
      "## Dependency Logic",
      "- Keep dependencies explicit and minimal.",
      "",
      "## Validation Strategy",
      "- Validate planning artifacts before execution.",
      "",
      "## Rollout Notes",
      "- Not applicable for tests.",
      "",
    ].join("\n"),
    "utf8",
  );

  for (const ticket of tickets) {
    await writeFile(path.join(ticketsRoot, `${ticket.id}.md`), ticket.body, "utf8");
  }
}

function validTicket(id: string, requires = "none"): string {
  return [
    `# ${id} — Test ticket`,
    "",
    "## Goal",
    "Implement a minimal test slice.",
    "",
    `- Requires: ${requires}`,
    "- Files: src/example.ts, tests/example.test.ts",
    "",
    "## Implementation Notes",
    "- Keep the change minimal.",
    "",
    "## Acceptance Criteria",
    "- The slice is verifiable.",
    "",
  ].join("\n");
}

describe("feature-ticket-flow governance", () => {
  it("allows non-destructive verification commands", () => {
    expect(isSafeValidationCommand("bun run typecheck")).toBe(true);
    expect(isSafeValidationCommand("bun run build")).toBe(true);
    expect(isSafeValidationCommand("npm run build")).toBe(true);
    expect(getForbiddenBashDecision("bun run typecheck", "WORKER")).toBeUndefined();
    expect(getForbiddenBashDecision("bun run build", "WORKER")).toBeUndefined();
    expect(getForbiddenBashDecision("next build", "REVIEWER")).toBeUndefined();
    expect(getForbiddenBashDecision("tsc --noEmit", "TESTER")).toBeUndefined();
  });

  it("still blocks tester test execution commands", () => {
    expect(getForbiddenBashDecision("bun test", "TESTER")).toContain("Tester may not execute tests");
  });

  it("blocks planner reads outside the active feature directory", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "read", input: { path: "/repo/package.json" } },
      pending,
    );

    expect(decision?.reason).toContain("Planner may only read files inside the active feature directory or the skills directory");
  });

  it("blocks planner writes outside the active feature directory", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "write", input: { path: "/repo/src/index.ts" } },
      pending,
    );

    expect(decision?.reason).toContain("Planner may only write inside the active feature directory");
  });

  it("blocks planner bash usage entirely", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "bash", input: { command: "ls" } },
      pending,
    );

    expect(decision?.reason).toContain("Planner may not use bash");
  });

  it("allows planner read of skills directory", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "read", input: { path: "/repo/skills/feature-planning/SKILL.md" } },
      pending,
    );

    expect(decision).toBeUndefined();
  });

  it("allows planner read of nested skill files", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "read", input: { path: "/repo/skills/feature-execution/templates/some-template.md" } },
      pending,
    );

    expect(decision).toBeUndefined();
  });

  it("blocks planner write inside skills directory", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };


    const decision = await evaluateGovernanceForToolCall(
      { toolName: "write", input: { path: "/repo/skills/feature-planning/SKILL.md" } },
      pending,
    );

    expect(decision?.reason).toContain("Planner may only write inside the active feature directory");
  });

  it("blocks planner edit inside skills directory", async () => {
    const pending: PendingExecution = {
      kind: "feature-plan",
      cwd: "/repo",
      specsRoot: "/repo/docs",
      feature: "demo",
    };

    const decision = await evaluateGovernanceForToolCall(
      { toolName: "edit", input: { path: "/repo/skills/feature-planning/SKILL.md" } },
      pending,
    );

    expect(decision?.reason).toContain("Planner may only write inside the active feature directory");
  });
});

describe("feature-ticket-flow integration", () => {
  let t: TestSession | undefined;

  afterEach(() => t?.dispose());

  // ── /init-feature ──────────────────────────────────────────────────────────

  it("scaffolds a feature directory with a stub spec via /feature-init", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    patchHarnessCompatibility(t);
    await t.run(when("/feature-init demo-feature", []));

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "demo-feature");
    const specContent = await readFile(path.join(featureRoot, "01-master-spec.md"), "utf8");

    expect(specContent).toContain("demo-feature");
    expect(specContent).toContain("## Goal");
    // No execution plan or tickets yet — user fills in the spec first
    await expect(readFile(path.join(featureRoot, "02-execution-plan.md"), "utf8")).rejects.toThrow();
  });

  // ── /plan-feature prompt ───────────────────────────────────────────────────

  it("sends the planner prompt when /feature-plan is run on a feature with a spec", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "my-feature");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    await writeFile(
      path.join(featureRoot, "01-master-spec.md"),
      "# my-feature\n\n## Goal\nBuild something.\n\n## Acceptance Criteria\n- It works.\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan my-feature", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((message) => message.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("feature-planning");
    expect(userMessages).toContain("01-master-spec.md");
    expect(userMessages).toContain("02-execution-plan.md");
    expect(userMessages).toContain("## Approach Summary");
    expect(userMessages).toContain("## Implementation Notes");
    expect(userMessages).toContain("APPROVED, BLOCKED, or NEEDS-FIX");
  });

  it("switches to the configured planner model before sending /feature-plan work", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "planner-model");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    await writeFile(
      path.join(featureRoot, "01-master-spec.md"),
      "# planner-model\n\n## Goal\nSwitch planner model.\n\n## Acceptance Criteria\n- It works.\n",
      "utf8",
    );
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ agents: { planner: { model: "openai/gpt-5" } } }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan planner-model", []));
    await settleSession(t);

    expect(currentModelRef(t)).toBe("openai/gpt-5");
  });

  it("stops /feature-plan when the configured planner model does not exist", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot, specsRoot } = await featurePaths(t.cwd, "planner-missing-model");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    await writeFile(
      path.join(featureRoot, "01-master-spec.md"),
      "# planner-missing-model\n\n## Goal\nFail fast.\n\n## Acceptance Criteria\n- It aborts.\n",
      "utf8",
    );
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ agents: { planner: { model: "openai/not-a-real-model" } } }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan planner-missing-model", []));
    await settleSession(t);

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("configured model not found"))).toBe(true);
    expect(await loadCheckpoint(specsRoot, "planner-missing-model")).toBeUndefined();
  });

  it("includes TDD instructions in the planner prompt when TDD is enabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "tdd-feature");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    await writeFile(
      path.join(featureRoot, "01-master-spec.md"),
      "# tdd-feature\n\n## Goal\nTest TDD.\n\n## Acceptance Criteria\n- Tests first.\n",
      "utf8",
    );
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ tdd: true }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan tdd-feature", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("TDD is enabled");
  });

  it("tells the planner to include a writable test file path in every ticket", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "test-file-scope");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    await writeFile(
      path.join(featureRoot, "01-master-spec.md"),
      "# test-file-scope\n\n## Goal\nPlan valid tickets.\n\n## Acceptance Criteria\n- Tickets include test scope.\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan test-file-scope", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("must include at least one writable test file path");
  });

  it("errors when /feature-plan is run with no spec file", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "no-spec");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    // no 01-master-spec.md

    patchHarnessCompatibility(t);
    await t.run(when("/feature-plan no-spec", []));
    await settleSession(t);

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).toLowerCase().includes("spec file not found"))).toBe(
      true,
    );
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it("blocks /feature-start when the execution plan is missing", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "no-plan");
    await mkdir(ticketsRoot, { recursive: true });
    await writeFile(path.join(featureRoot, "01-master-spec.md"), "# no-plan\n\n## Goal\nTest.\n", "utf8");
    await writeFile(path.join(ticketsRoot, "STK-001.md"), validTicket("STK-001"), "utf8");
    // no 02-execution-plan.md

    patchHarnessCompatibility(t);
    await t.run(when("/feature-start no-plan", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  it("blocks /feature-start when a ticket has a missing dependency", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "broken-deps");
    await mkdir(ticketsRoot, { recursive: true });
    await writeFile(path.join(featureRoot, "01-master-spec.md"), "# broken-deps\n", "utf8");
    await writeFile(
      path.join(featureRoot, "02-execution-plan.md"),
      "# broken-deps execution plan\n\n## Approach Summary\n- test\n\n## Ticket Sequence\n1. STK-001\n\n## Dependency Logic\n- test\n\n## Validation Strategy\n- test\n\n## Rollout Notes\n- N/A\n",
      "utf8",
    );
    await writeFile(
      path.join(ticketsRoot, "STK-001.md"),
      validTicket("STK-001", "STK-999"),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-start broken-deps", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  it("blocks /feature-start when a ticket is missing required sections", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "template-broken");
    await mkdir(ticketsRoot, { recursive: true });
    await writeFile(path.join(featureRoot, "01-master-spec.md"), "# template-broken\n", "utf8");
    await writeFile(
      path.join(featureRoot, "02-execution-plan.md"),
      "# template-broken execution plan\n\n## Approach Summary\n- ok\n\n## Ticket Sequence\n1. STK-001\n\n## Dependency Logic\n- ok\n\n## Validation Strategy\n- ok\n\n## Rollout Notes\n- N/A\n",
      "utf8",
    );
    // ticket missing Implementation Notes and Acceptance Criteria
    await writeFile(
      path.join(ticketsRoot, "STK-001.md"),
      "# STK-001 — Incomplete\n\n## Goal\nDo stuff.\n\n- Requires: none\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-start template-broken", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  // ── Ticket execution ───────────────────────────────────────────────────────

  it("sends execution prompt when /feature-next is run", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "demo", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    patchHarnessCompatibility(t);
    await t.run(
      when("/feature-next demo", []),
    );
    await settleSession(t);

    // Verify execution prompt was sent
    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");
    expect(userMessages).toContain("STK-001");
    expect(userMessages).toContain("feature-execution");
  });

  it("switches to the configured tester model before the tester phase", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "tester-model", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ tdd: true, agents: { tester: { model: "openai/gpt-5-mini" } } }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next tester-model", []));
    await settleSession(t);

    expect(currentModelRef(t)).toBe("openai/gpt-5-mini");
  });

  it("records a tester checkpoint with phase=start when TDD is enabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "handoff-models", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({
        tdd: true,
        agents: {
          tester: { model: "openai/gpt-5-mini" },
          worker: { model: "openai/gpt-4.1-mini" },
        },
      }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next handoff-models", []));
    await settleSession(t, 200);

    const { specsRoot } = await featurePaths(t.cwd, "handoff-models");
    const checkpoint = await loadCheckpoint(specsRoot, "handoff-models");

    expect(checkpoint?.kind).toBe("ticket-tester");
    expect(checkpoint && "phase" in checkpoint ? checkpoint.phase : undefined).toBe("start");
    expect(currentModelRef(t)).toBe("openai/gpt-5-mini");
  });

  it("sends the tester prompt as first message when TDD is enabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "roles-check", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ tdd: true }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next roles-check", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    // First message should be the tester phase prompt
    expect(userMessages).toContain("Tester phase");
    expect(userMessages).toContain("TEST AUTHORING ONLY");
    expect(userMessages).toContain("tester-notes");
    expect(userMessages).toContain("handoff log");
    expect(userMessages).toContain("Do NOT run the test suite");
  });

  it("preserves retry phase in the tester checkpoint when TDD is enabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "retry-tdd-handoff", [
      { id: "STK-001", body: validTicket("STK-001") },
      { id: "STK-002", body: validTicket("STK-002") },
    ]);
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({ tdd: true }),
      "utf8",
    );

    const { specsRoot } = await featurePaths(t.cwd, "retry-tdd-handoff");
    const registry = await loadRegistry(specsRoot, "retry-tdd-handoff");
    registry.tickets[0]!.status = "needs_fix";
    await saveRegistry(specsRoot, "retry-tdd-handoff", registry);

    const contextPath = workerContextPath(specsRoot, "retry-tdd-handoff", "STK-001");
    await writeFile(contextPath, "# Worker Context — STK-001\n\n## Continuation notes\n- retry me\n", "utf8");

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next retry-tdd-handoff", []));
    await settleSession(t, 250);

    const checkpoint = await loadCheckpoint(specsRoot, "retry-tdd-handoff");
    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(checkpoint?.kind).toBe("ticket-tester");
    expect(checkpoint && "phase" in checkpoint ? checkpoint.phase : undefined).toBe("retry");
    expect(userMessages).toContain("Tester phase");
  });

  it("switches to the configured worker model when TDD is disabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "phase-models", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);
    await mkdir(path.join(t.cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(t.cwd, ".pi", "feature-flow.json"),
      JSON.stringify({
        agents: {
          worker: { model: "openai/gpt-4.1-mini" },
          reviewer: { model: "openai/gpt-5-mini" },
        },
      }),
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next phase-models", []));
    await settleSession(t, 250);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).not.toContain("Reviewer phase");
    expect(currentModelRef(t)).toBe("openai/gpt-4.1-mini");
  });

  it("sends worker prompt first when TDD is disabled", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "no-tdd-roles", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);
    // tdd: false (default)

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next no-tdd-roles", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).not.toContain("Reviewer phase");
    expect(userMessages).not.toContain("Manager phase");
  });

  it("references the feature memory file in ticket prompt when it exists", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "mem-feature", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    // Write a memory file as if the manager wrote it after a previous ticket
    const { specsRoot } = await featurePaths(t.cwd, "mem-feature");
    const memPath = featureMemoryPath(specsRoot, "mem-feature");
    await writeFile(
      memPath,
      "# Feature Memory: mem-feature\n\n### After STK-000\n- Used Zod for validation\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next mem-feature", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("04-feature-memory.md");
    expect(userMessages).toContain("handoff log");
    expect(userMessages).toContain("patterns from previous tickets");
  });

  it("ignores worker/reviewer/tester artifact markdown files when loading the registry", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "artifact-ignore", [
      { id: "STK-001", body: validTicket("STK-001") },
      { id: "STK-002", body: validTicket("STK-002", "STK-001") },
    ]);

    const { ticketsRoot, specsRoot } = await featurePaths(t.cwd, "artifact-ignore");
    await writeFile(
      path.join(ticketsRoot, "STK-001-worker-context.md"),
      "# Worker Context — STK-001\n",
      "utf8",
    );
    await writeFile(
      path.join(ticketsRoot, "STK-001-reviewer-notes.md"),
      "# Reviewer Notes — STK-001\n",
      "utf8",
    );
    await writeFile(
      path.join(ticketsRoot, "STK-001-tester-notes.md"),
      "# Tester Notes — STK-001\n",
      "utf8",
    );
    await writeFile(
      path.join(ticketsRoot, "STK-001-handoff-log.md"),
      "# Handoff Log — STK-001\n",
      "utf8",
    );

    const registry = await loadRegistry(specsRoot, "artifact-ignore");

    expect(registry.tickets.map((ticket) => ticket.id)).toEqual(["STK-001", "STK-002"]);
  });

  it("prefers needs_fix tickets over pending ones", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "retry-priority", [
      { id: "STK-001", body: validTicket("STK-001") },
      { id: "STK-002", body: validTicket("STK-002") },
    ]);

    const { specsRoot } = await featurePaths(t.cwd, "retry-priority");
    const registry = await loadRegistry(specsRoot, "retry-priority");
    registry.tickets[0]!.status = "needs_fix";
    await saveRegistry(specsRoot, "retry-priority", registry);

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next retry-priority", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("STK-001");
    expect(userMessages).toContain("retry");
  });

  it("creates an execution checkpoint for worker runs", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "reviewer-artifact-guard", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next reviewer-artifact-guard", []));
    await settleSession(t, 250);

    const { specsRoot } = await featurePaths(t.cwd, "reviewer-artifact-guard");
    const checkpoint = await loadCheckpoint(specsRoot, "reviewer-artifact-guard");

    expect(checkpoint?.kind).toBe("ticket-execution");
    expect(checkpoint && "executionRole" in checkpoint ? checkpoint.executionRole : undefined).toBe("worker");
  });

  it("writes a resumable checkpoint file as soon as execution starts", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "missing-outcome", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next missing-outcome", []));
    await settleSession(t, 250);

    const { specsRoot } = await featurePaths(t.cwd, "missing-outcome");
    const checkpoint = await loadCheckpoint(specsRoot, "missing-outcome");

    expect(checkpoint).toBeDefined();
    expect(checkpoint?.kind).toBe("ticket-execution");
  });

  it("includes worker prompt artifacts for execution", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "phase-prompts", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    patchHarnessCompatibility(t);
    await t.run(when("/feature-next phase-prompts", []));
    await settleSession(t, 250);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).toContain("Phase: start");
    expect(userMessages).toContain("handoff log");
    expect(userMessages).toContain("feature-execution");
  });

});
