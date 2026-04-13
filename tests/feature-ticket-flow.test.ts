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
      "# STK-001 — Missing dependency\n\n- Requires: STK-999\n",
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
        body: "# STK-001 — First ticket\n\n- Requires: none\n",
      },
    ]);

    patchHarnessCompatibility(t);
    await t.run(
      when("/start-feature demo", [
        says("APPROVED\nCompleted successfully."),
      ]),
    );

    await settleSession(t);

    const { specsRoot } = await featurePaths(t.cwd, "demo");
    const registry = await loadRegistry(specsRoot, "demo");
    const ticket = registry.tickets.find((item: { id: string }) => item.id === "STK-001");

    expect(ticket?.status).toBe("done");
    expect(ticket?.runs).toHaveLength(1);
    expect(ticket?.runs[0]?.mode).toBe("start");
    expect(ticket?.runs[0]?.outcome).toBe("done");
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
        body: "# STK-001 — Retry me\n\n- Requires: none\n",
      },
      {
        id: "STK-002",
        body: "# STK-002 — Still pending\n\n- Requires: none\n",
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
});