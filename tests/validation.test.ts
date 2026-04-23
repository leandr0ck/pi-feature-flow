import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFeature } from "../src/validation.js";

async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-validation-"));
}

function validPlan(feature: string): string {
  return [
    `# ${feature} execution plan`,
    "",
    "## Approach Summary",
    "- Deliver the feature.",
    "",
    "## Ticket Sequence",
    "1. STK-001 — first slice",
    "",
    "## Dependency Logic",
    "- Keep it minimal.",
    "",
    "## Validation Strategy",
    "- Validate before execution.",
    "",
    "## Rollout Notes",
    "- Not applicable.",
    "",
  ].join("\n");
}

function validTicket(id: string, requires = "none"): string {
  return [
    `# ${id} — Test ticket`,
    "",
    "## Goal",
    "Do something.",
    "",
    `- Requires: ${requires}`,
    "- Files: src/example.ts, tests/example.test.ts",
    "",
    "## Implementation Notes",
    "- Keep it minimal.",
    "",
    "## Acceptance Criteria",
    "- The slice is verifiable.",
    "",
  ].join("\n");
}

async function seedValidFeature(specsRoot: string, feature: string, tickets: string[] = ["STK-001"]) {
  const featureDir = path.join(specsRoot, feature);
  const ticketsDir = path.join(featureDir, "tickets");
  await mkdir(ticketsDir, { recursive: true });
  await writeFile(path.join(featureDir, "01-master-spec.md"), `# ${feature}\n\n## Goal\nTest.\n`, "utf8");
  await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan(feature), "utf8");
  for (const id of tickets) {
    await writeFile(path.join(ticketsDir, `${id}.md`), validTicket(id), "utf8");
  }
}

describe("validateFeature", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("returns valid=true for a well-formed feature", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    await seedValidFeature(specsRoot, "my-feature");

    const result = await validateFeature(specsRoot, "my-feature");

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  // ── Missing spec file ─────────────────────────────────────────────────────

  it("warns when 01-master-spec.md is missing", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "no-spec");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("no-spec"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001"), "utf8");

    const result = await validateFeature(specsRoot, "no-spec");

    const warning = result.issues.find((i) => i.code === "missing-spec-file" && i.severity === "warning");
    expect(warning).toBeDefined();
    expect(result.valid).toBe(true); // warnings don't make it invalid
  });

  // ── Missing execution plan ────────────────────────────────────────────────

  it("errors when 02-execution-plan.md is missing", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "no-plan");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# no-plan\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001"), "utf8");

    const result = await validateFeature(specsRoot, "no-plan");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-spec-file" && i.severity === "error")).toBe(true);
  });

  // ── Execution plan template mismatch ─────────────────────────────────────

  it("errors when execution plan is missing required sections", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "bad-plan");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# bad-plan\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), "# bad-plan execution plan\n\nNo sections here.\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001"), "utf8");

    const result = await validateFeature(specsRoot, "bad-plan");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "execution-plan-template-mismatch")).toBe(true);
  });

  // ── Missing tickets directory ─────────────────────────────────────────────

  it("errors when the tickets directory is missing", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "no-tickets-dir");
    await mkdir(featureDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# no-tickets-dir\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("no-tickets-dir"), "utf8");

    const result = await validateFeature(specsRoot, "no-tickets-dir");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-tickets-dir")).toBe(true);
  });

  // ── No ticket files ───────────────────────────────────────────────────────

  it("errors when the tickets directory is empty", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "empty-tickets");
    await mkdir(path.join(featureDir, "tickets"), { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# empty-tickets\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("empty-tickets"), "utf8");

    const result = await validateFeature(specsRoot, "empty-tickets");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "no-tickets")).toBe(true);
  });

  it("ignores worker/reviewer/tester artifact markdown files during validation", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "artifact-validation");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# artifact-validation\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("artifact-validation"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-worker-context.md"), "# Worker Context — STK-001\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-reviewer-notes.md"), "# Reviewer Notes — STK-001\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-tester-notes.md"), "# Tester Notes — STK-001\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-handoff-log.md"), "# Handoff Log — STK-001\n", "utf8");

    const result = await validateFeature(specsRoot, "artifact-validation");

    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.ticketId?.includes("worker-context"))).toBe(false);
    expect(result.issues.some((i) => i.ticketId?.includes("reviewer-notes"))).toBe(false);
    expect(result.issues.some((i) => i.ticketId?.includes("tester-notes"))).toBe(false);
    expect(result.issues.some((i) => i.ticketId?.includes("handoff-log"))).toBe(false);
  });

  it("errors when only artifact markdown files exist in the tickets directory", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "artifacts-only");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# artifacts-only\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("artifacts-only"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-worker-context.md"), "# Worker Context — STK-001\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-reviewer-notes.md"), "# Reviewer Notes — STK-001\n", "utf8");
    await writeFile(path.join(ticketsDir, "STK-001-handoff-log.md"), "# Handoff Log — STK-001\n", "utf8");

    const result = await validateFeature(specsRoot, "artifacts-only");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "no-tickets")).toBe(true);
  });

  // ── Duplicate ticket IDs ──────────────────────────────────────────────────
  // NOTE: case-insensitive duplicate file names (e.g. STK-001.md vs stk-001.md)
  // cannot be tested on macOS (APFS/HFS+ case-insensitive) because the OS treats
  // them as the same file. The duplicate-ticket-id code path is only exercisable
  // on a case-sensitive filesystem.

  // ── Missing dependency ────────────────────────────────────────────────────

  it("errors when a ticket omits all test file paths from - Files:", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "missing-test-file-scope");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# missing-test-file-scope\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("missing-test-file-scope"), "utf8");
    await writeFile(
      path.join(ticketsDir, "STK-001.md"),
      validTicket("STK-001").replace("- Files: src/example.ts, tests/example.test.ts", "- Files: src/example.ts, src/other.ts"),
      "utf8",
    );

    const result = await validateFeature(specsRoot, "missing-test-file-scope");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "ticket-files-missing-test-path" && i.ticketId === "STK-001")).toBe(true);
  });

  it("errors when a ticket depends on a non-existent ticket", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "missing-dep");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# missing-dep\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("missing-dep"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001", "STK-999"), "utf8");

    const result = await validateFeature(specsRoot, "missing-dep");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-dependency" && i.ticketId === "STK-001")).toBe(true);
  });

  // ── Dependency cycle ──────────────────────────────────────────────────────

  it("errors on a direct dependency cycle between two tickets", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "cycle");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# cycle\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("cycle"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001", "STK-002"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-002.md"), validTicket("STK-002", "STK-001"), "utf8");

    const result = await validateFeature(specsRoot, "cycle");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "dependency-cycle")).toBe(true);
  });

  // ── Orphan tickets ────────────────────────────────────────────────────────

  it("warns on orphan tickets when there are multiple tickets", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "orphan");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# orphan\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("orphan"), "utf8");
    // STK-001 depends on STK-002, but STK-003 is completely disconnected
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001", "STK-002"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-002.md"), validTicket("STK-002"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-003.md"), validTicket("STK-003"), "utf8");

    const result = await validateFeature(specsRoot, "orphan");

    expect(result.issues.some((i) => i.code === "orphan-ticket" && i.ticketId === "STK-003")).toBe(true);
  });

  it("does not warn about orphans when there is only one ticket", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    await seedValidFeature(specsRoot, "single-ticket", ["STK-001"]);

    const result = await validateFeature(specsRoot, "single-ticket");

    expect(result.issues.some((i) => i.code === "orphan-ticket")).toBe(false);
  });

  // ── Duplicate dependencies ────────────────────────────────────────────────

  it("warns when a ticket lists the same dependency twice", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "dup-dep");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# dup-dep\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("dup-dep"), "utf8");
    await writeFile(path.join(ticketsDir, "STK-001.md"), validTicket("STK-001"), "utf8");
    // Duplicate dependency: STK-001, STK-001
    const body = validTicket("STK-002", "STK-001").replace("- Requires: STK-001", "- Requires: STK-001, STK-001");
    await writeFile(path.join(ticketsDir, "STK-002.md"), body, "utf8");

    const result = await validateFeature(specsRoot, "dup-dep");

    expect(result.issues.some((i) => i.code === "duplicate-dependency" && i.ticketId === "STK-002")).toBe(true);
  });

  // ── Invalid ticket ID format ──────────────────────────────────────────────

  it("warns when a ticket ID does not match the recommended pattern", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "bad-id");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# bad-id\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("bad-id"), "utf8");
    const content = [
      "# my-task — Test ticket",
      "",
      "## Goal",
      "Do something.",
      "",
      "- Requires: none",
      "",
      "## Implementation Notes",
      "- Keep it minimal.",
      "",
      "## Acceptance Criteria",
      "- Verifiable.",
      "",
    ].join("\n");
    await writeFile(path.join(ticketsDir, "my-task.md"), content, "utf8");

    const result = await validateFeature(specsRoot, "bad-id");

    expect(result.issues.some((i) => i.code === "invalid-ticket-id" && i.ticketId === "my-task")).toBe(true);
  });

  // ── Ticket template mismatch ──────────────────────────────────────────────

  it("errors when a ticket is missing required sections", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    const featureDir = path.join(specsRoot, "bad-ticket");
    const ticketsDir = path.join(featureDir, "tickets");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(path.join(featureDir, "01-master-spec.md"), `# bad-ticket\n\n## Goal\nTest.\n`, "utf8");
    await writeFile(path.join(featureDir, "02-execution-plan.md"), validPlan("bad-ticket"), "utf8");
    // Missing Implementation Notes and Acceptance Criteria
    await writeFile(
      path.join(ticketsDir, "STK-001.md"),
      "# STK-001 — Incomplete\n\n## Goal\nDo stuff.\n\n- Requires: none\n",
      "utf8",
    );

    const result = await validateFeature(specsRoot, "bad-ticket");

    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "ticket-template-mismatch" && i.ticketId === "STK-001")).toBe(true);
  });
});
