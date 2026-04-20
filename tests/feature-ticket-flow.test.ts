import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestSession, when, says, type TestSession } from "@marcfargas/pi-test-harness";
import { loadConfig, resolveSpecsRoot } from "../src/config.js";
import { loadRegistry, saveRegistry, featureMemoryPath } from "../src/registry.js";

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
    "",
    "## Implementation Notes",
    "- Keep the change minimal.",
    "",
    "## Acceptance Criteria",
    "- The slice is verifiable.",
    "",
  ].join("\n");
}

describe("feature-ticket-flow integration", () => {
  let t: TestSession | undefined;

  afterEach(() => t?.dispose());

  // ── /init-feature ──────────────────────────────────────────────────────────

  it("scaffolds a feature directory with a stub spec via /init-feature", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    patchHarnessCompatibility(t);
    await t.run(when("/init-feature demo-feature", []));

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "demo-feature");
    const specContent = await readFile(path.join(featureRoot, "01-master-spec.md"), "utf8");

    expect(specContent).toContain("demo-feature");
    expect(specContent).toContain("## Goal");
    // No execution plan or tickets yet — user fills in the spec first
    await expect(readFile(path.join(featureRoot, "02-execution-plan.md"), "utf8")).rejects.toThrow();
  });

  // ── /plan-feature prompt ───────────────────────────────────────────────────

  it("sends the planner prompt when /plan-feature is run on a feature with a spec", async () => {
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
    await t.run(when("/plan-feature my-feature", []));
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

  it("switches to the configured planner model before sending /plan-feature work", async () => {
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
    await t.run(when("/plan-feature planner-model", []));
    await settleSession(t);

    expect(currentModelRef(t)).toBe("openai/gpt-5");
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
    await t.run(when("/plan-feature tdd-feature", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("TDD is enabled");
  });

  it("errors when /plan-feature is run with no spec file", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot } = await featurePaths(t.cwd, "no-spec");
    await mkdir(path.join(featureRoot, "tickets"), { recursive: true });
    // no 01-master-spec.md

    patchHarnessCompatibility(t);
    await t.run(when("/plan-feature no-spec", []));
    await settleSession(t);

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).toLowerCase().includes("spec file not found"))).toBe(
      true,
    );
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  it("blocks /start-feature when the execution plan is missing", async () => {
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
    await t.run(when("/start-feature no-plan", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  it("blocks /start-feature when a ticket has a missing dependency", async () => {
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
    await t.run(when("/start-feature broken-deps", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  it("blocks /start-feature when a ticket is missing required sections", async () => {
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
    await t.run(when("/start-feature template-broken", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(
      true,
    );
  });

  // ── Ticket execution ───────────────────────────────────────────────────────

  it("sends execution prompt when /next-ticket is run", async () => {
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
      when("/next-ticket demo", []),
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
    await t.run(when("/next-ticket tester-model", []));
    await settleSession(t);

    expect(currentModelRef(t)).toBe("openai/gpt-5-mini");
  });

  it("switches from tester model to worker model on TDD auto-handoff", async () => {
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
    await t.run(
      when("/next-ticket handoff-models", [
        says("APPROVED\nTester completed red phase."),
      ]),
    );
    await settleSession(t, 200);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Tester phase");
    expect(userMessages).toContain("Worker phase");
    expect(currentModelRef(t)).toBe("openai/gpt-4.1-mini");
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
    await t.run(when("/next-ticket roles-check", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    // First message should be the tester phase prompt
    expect(userMessages).toContain("Tester phase");
    expect(userMessages).toContain("red phase");
    expect(userMessages).toContain("tester-notes");
    expect(userMessages).toContain("APPROVED (tests written and red)");
  });

  it("switches from worker model to reviewer model on explicit phase handoff", async () => {
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
    await t.run(
      when("/next-ticket phase-models", [
        says("APPROVED\nWorker complete."),
      ]),
    );
    await settleSession(t, 250);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).toContain("Reviewer phase");
    expect(currentModelRef(t)).toBe("openai/gpt-5-mini");
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
    await t.run(when("/next-ticket no-tdd-roles", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).not.toContain("Reviewer phase");
    expect(userMessages).not.toContain("Chief phase");
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

    // Write a memory file as if the chief wrote it after a previous ticket
    const { specsRoot } = await featurePaths(t.cwd, "mem-feature");
    const memPath = featureMemoryPath(specsRoot, "mem-feature");
    await writeFile(
      memPath,
      "# Feature Memory: mem-feature\n\n### After STK-000\n- Used Zod for validation\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/next-ticket mem-feature", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("04-feature-memory.md");
    expect(userMessages).toContain("accumulated context from previous tickets");
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
    await t.run(when("/next-ticket retry-priority", []));
    await settleSession(t);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("STK-001");
    expect(userMessages).toContain("retry");
  });

  it("auto-advances from worker to reviewer with a separate reviewer prompt", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "phase-prompts", [
      { id: "STK-001", body: validTicket("STK-001") },
    ]);

    patchHarnessCompatibility(t);
    await t.run(
      when("/next-ticket phase-prompts", [
        says("APPROVED\nWorker done."),
      ]),
    );
    await settleSession(t, 250);

    const userMessages = t.events.messages
      .filter((m) => m.role === "user")
      .map(messageText)
      .join("\n\n");

    expect(userMessages).toContain("Worker phase");
    expect(userMessages).toContain("Reviewer phase");
    expect(userMessages).toContain("reviewer-notes");
  });
});
