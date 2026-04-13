import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestSession, when, says, type TestSession } from "@marcfargas/pi-test-harness";
import { loadConfig, resolveSpecsRoot } from "../src/config.js";
import { loadRegistry } from "../src/registry.js";

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

async function settleSession(t: TestSession) {
  await (t.session.agent as { waitForIdle?: () => Promise<void> }).waitForIdle?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function seedFeature(
  cwd: string,
  feature: string,
  tickets: Array<{ id: string; body: string }>,
) {
  const { featureRoot, ticketsRoot } = await featurePaths(cwd, feature);
  await mkdir(ticketsRoot, { recursive: true });
  await writeFile(path.join(featureRoot, "01-master-spec.md"), `# ${feature} master spec\n\n## Goal\nTest feature\n`, "utf8");
  await writeFile(path.join(featureRoot, "02-execution-plan.md"), `# ${feature} execution plan\n`, "utf8");

  for (const ticket of tickets) {
    await writeFile(path.join(ticketsRoot, `${ticket.id}.md`), ticket.body, "utf8");
  }
}

async function writeFeatureConfig(cwd: string, yaml: string) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "feature-ticket-flow.yaml"), yaml, "utf8");
}

describe("feature-ticket-flow integration", () => {
  let t: TestSession | undefined;

  afterEach(() => t?.dispose());

  it("scaffolds a feature via /init-feature", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    patchHarnessCompatibility(t);
    await t.run(when("/init-feature demo-feature", []));

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "demo-feature");
    const masterSpec = await readFile(path.join(featureRoot, "01-master-spec.md"), "utf8");
    const executionPlan = await readFile(path.join(featureRoot, "02-execution-plan.md"), "utf8");
    const starterTicket = await readFile(path.join(ticketsRoot, "STK-001.md"), "utf8");

    expect(masterSpec).toContain("demo-feature");
    expect(executionPlan).toContain("execution plan");
    expect(starterTicket).toContain("STK-001");
    expect(starterTicket).toContain("- Profile: default");
  });

  it("uses /feature without requiring a profile and asks for ticket-level profiles", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    await writeFeatureConfig(
      t.cwd,
      [
        "profiles:",
        "  default: {}",
        "  frontend: {}",
        "  backend: {}",
      ].join("\n"),
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature build onboarding flow", []));
    await settleSession(t);

    const userMessages = t.events.messages.filter((message) => message.role === "user").map(messageText).join("\n\n");
    const notifications = t.events.uiCallsFor("notify");

    expect(userMessages).toContain("Every ticket must include a `- Profile:` line");
    expect(userMessages).toContain("Allowed ticket profiles: default, frontend, backend");
    expect(notifications.some((call) => String(call.args[0]).includes("Planning spec and tickets..."))).toBe(true);
  });

  it("continues planning on /start-feature when 04-technical-design.md exists and tickets do not yet exist", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "technical-gate");
    await mkdir(ticketsRoot, { recursive: true });
    await writeFile(path.join(featureRoot, "01-master-spec.md"), "# technical-gate\n\nNeeds technical design\n", "utf8");
    await writeFile(path.join(featureRoot, "02-execution-plan.md"), "# technical-gate execution plan\n", "utf8");
    await writeFile(path.join(featureRoot, "04-technical-design.md"), "# technical design\n\nMore detail\n", "utf8");

    patchHarnessCompatibility(t);
    await t.run(when("/start-feature technical-gate", []));
    await settleSession(t);

    const userMessages = t.events.messages.filter((message) => message.role === "user").map(messageText).join("\n\n");
    expect(userMessages).toContain("Continue planning for feature \"technical-gate\"");
    expect(userMessages).toContain("04-technical-design.md");
  });

  it("blocks /start-feature when validation fails", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    const { featureRoot, ticketsRoot } = await featurePaths(t.cwd, "broken-feature");
    await mkdir(ticketsRoot, { recursive: true });
    await writeFile(path.join(featureRoot, "01-master-spec.md"), "# broken-feature\n", "utf8");
    await writeFile(
      path.join(ticketsRoot, "STK-001.md"),
      "# STK-001 — Missing dependency\n\n- Profile: backend\n- Requires: STK-999\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/start-feature broken-feature", []));

    const notifications = t.events.uiCallsFor("notify");
    expect(notifications.some((call) => String(call.args[0]).includes("failed validation"))).toBe(true);
  });

  it("auto-marks a started ticket as done when the agent says APPROVED", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "demo", [
      {
        id: "STK-001",
        body: "# STK-001 — First ticket\n\n- Profile: default\n- Requires: none\n",
      },
    ]);

    // Pre-approve so the review gate passes
    const { specsRoot: specsRootDemo } = await featurePaths(t.cwd, "demo");
    const registryDemo = await loadRegistry(specsRootDemo, "demo");
    registryDemo.review = {
      status: "approved",
      requestedAt: new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      comments: [],
      lastAction: "approve",
    };
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(specsRootDemo, "demo", "03-ticket-registry.json"),
      JSON.stringify(registryDemo, null, 2) + "\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(
      when("/start-feature demo", [
        says("APPROVED\nCompleted successfully."),
      ]),
    );

    await settleSession(t);

    const { specsRoot: finalSpecsRoot } = await featurePaths(t.cwd, "demo");
    const finalRegistry = await loadRegistry(finalSpecsRoot, "demo");
    const ticket = finalRegistry.tickets.find((item: { id: string }) => item.id === "STK-001");

    expect(ticket?.status).toBe("done");
    expect(ticket?.runs).toHaveLength(1);
    expect(ticket?.runs[0]?.mode).toBe("start");
    expect(ticket?.runs[0]?.outcome).toBe("done");
  });

  it("uses the ticket profile before the feature fallback profile during execution", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await writeFeatureConfig(
      t.cwd,
      [
        "profiles:",
        "  default: {}",
        "  frontend: {}",
        "  backend: {}",
      ].join("\n"),
    );

    await seedFeature(t.cwd, "profile-routing", [
      {
        id: "STK-001",
        body: "# STK-001 — Backend ticket\n\n- Profile: backend\n- Requires: none\n",
      },
    ]);

    const { specsRoot } = await featurePaths(t.cwd, "profile-routing");
    const registry = await loadRegistry(specsRoot, "profile-routing");
    registry.profileName = "frontend";
    // Pre-approve so the review gate passes
    registry.review = {
      status: "approved",
      requestedAt: new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      comments: [],
      lastAction: "approve",
    };
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(specsRoot, "profile-routing", "03-ticket-registry.json"),
      JSON.stringify(registry, null, 2) + "\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(
      when("/start-feature profile-routing", [
        says("APPROVED\nCompleted successfully."),
      ]),
    );

    await settleSession(t);

    const userMessages = t.events.messages.filter((message) => message.role === "user").map(messageText).join("\n\n");
    expect(userMessages).toContain("Execution profile: backend");
  });

  it("prioritizes needs-fix tickets before pending ones on /next-ticket", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
      mockUI: { select: 0 },
    });

    await seedFeature(t.cwd, "priority", [
      {
        id: "STK-001",
        body: "# STK-001 — Retry me\n\n- Profile: default\n- Requires: none\n",
      },
      {
        id: "STK-002",
        body: "# STK-002 — Still pending\n\n- Profile: default\n- Requires: none\n",
      },
    ]);

    const { specsRoot } = await featurePaths(t.cwd, "priority");
    const registry = await loadRegistry(specsRoot, "priority");
    const ticket = registry.tickets.find((item: { id: string }) => item.id === "STK-001");
    if (!ticket) throw new Error("missing STK-001");
    ticket.status = "needs_fix";
    ticket.runs.push({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      mode: "start",
      outcome: "needs_fix",
    });
    // Pre-approve so the review gate passes
    registry.review = {
      status: "approved",
      requestedAt: new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      comments: [],
      lastAction: "approve",
    };

    const fs = await import("node:fs/promises");
    await fs.writeFile(path.join(specsRoot, "priority", "03-ticket-registry.json"), JSON.stringify(registry, null, 2) + "\n", "utf8");

    patchHarnessCompatibility(t);
    await t.run(
      when("/next-ticket priority", [
        says("APPROVED\nRetry complete."),
      ]),
    );

    await settleSession(t);

    const refreshed = await loadRegistry(specsRoot, "priority");
    const retried = refreshed.tickets.find((item: { id: string }) => item.id === "STK-001");
    const untouched = refreshed.tickets.find((item: { id: string }) => item.id === "STK-002");

    expect(retried?.status).toBe("done");
    expect(retried?.runs.at(-1)?.mode).toBe("retry");
    expect(untouched?.status).toBe("pending");
  });

  it("shows current profile for a feature with /feature-profile <slug>", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    await seedFeature(t.cwd, "profile-test", [
      { id: "STK-001", body: "# STK-001\n\n- Profile: frontend\n- Requires: none\n" },
    ]);

    const { specsRoot } = await featurePaths(t.cwd, "profile-test");
    const registry = await loadRegistry(specsRoot, "profile-test");
    registry.profileName = "frontend";
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      path.join(specsRoot, "profile-test", "03-ticket-registry.json"),
      JSON.stringify(registry, null, 2) + "\n",
      "utf8",
    );

    patchHarnessCompatibility(t);
    await t.run(when("/feature-profile profile-test", []));
    await settleSession(t);
  });

  it("sets profile for a feature with /feature-profile <slug> <profile>", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });

    await seedFeature(t.cwd, "set-profile-test", [
      { id: "STK-001", body: "# STK-001\n\n- Profile: frontend\n- Requires: none\n" },
    ]);

    patchHarnessCompatibility(t);
    await t.run(when("/feature-profile set-profile-test default", []));
    await settleSession(t);

    const { specsRoot } = await featurePaths(t.cwd, "set-profile-test");
    const registry = await loadRegistry(specsRoot, "set-profile-test");
    expect(registry.profileName).toBe("default");
  });
});
