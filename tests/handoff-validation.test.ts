import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateManagerArtifacts,
  validateReviewerArtifacts,
  validateTesterArtifacts,
  validateWorkerArtifacts,
} from "../src/feature-flow/handoff-validation.js";

async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-handoff-validation-"));
}

describe("handoff validation", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("accepts valid tester artifacts", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const notes = path.join(dir, "tester-notes.md");
    const log = path.join(dir, "handoff-log.md");
    const json = path.join(dir, "tester-handoff.json");

    await writeFile(notes, "# Tester Notes — STK-001\n\n## Tests written\n- tests/example.test.ts: covers AC\n\n## Test guidelines followed\n- existing conventions\n\n## Notes for worker\n- run bun test\n", "utf8");
    await writeFile(log, "# Handoff Log — STK-001\n\n## Tester\n- done\n\n## Worker\n- pending\n\n## Reviewer\n- pending\n\n## Manager\n- pending\n", "utf8");
    await writeFile(json, JSON.stringify({ ticketId: "STK-001", phase: "tester", status: "APPROVED", testsWritten: [{ path: "tests/example.test.ts", scope: "covers AC" }], testGuidelines: ["existing conventions"], notesForWorker: ["run bun test"] }, null, 2), "utf8");

    const result = await validateTesterArtifacts(notes, log, json);
    expect(result.ok).toBe(true);
  });

  it("rejects placeholder markdown and incomplete json", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const notes = path.join(dir, "reviewer-notes.md");
    const log = path.join(dir, "handoff-log.md");
    const json = path.join(dir, "reviewer-handoff.json");

    await writeFile(notes, "# Reviewer Notes — STK-001\n\n## Verdict\n<APPROVED | NEEDS-FIX | BLOCKED>\n\n## Findings\n- <specific issue>\n\n## Reviewer edits made\n- <none>\n\n## Evidence\n- <test output>\n", "utf8");
    await writeFile(log, "# Handoff Log — STK-001\n\n## Reviewer\n- <none>\n\n## Manager\n- pending\n", "utf8");
    await writeFile(json, JSON.stringify({ ticketId: "STK-001", phase: "reviewer", status: "APPROVED" }, null, 2), "utf8");

    const result = await validateReviewerArtifacts(notes, log, json);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("placeholders");
    expect(result.issues.join(" ")).toContain("evidence");
  });

  it("accepts valid worker and manager artifacts", async () => {
    const dir = await makeTempDir();
    dirs.push(dir);
    const workerLog = path.join(dir, "worker-handoff-log.md");
    const workerJson = path.join(dir, "worker-handoff.json");
    await writeFile(workerLog, "# Handoff Log — STK-001\n\n## Worker\n- updated\n\n## Reviewer\n- next\n\n## Manager\n- next\n", "utf8");
    await writeFile(workerJson, JSON.stringify({ ticketId: "STK-001", phase: "worker", status: "APPROVED", filesChanged: [{ path: "src/example.ts", summary: "implemented", status: "complete" }], technicalDecisions: ["minimal change"], risks: ["none"], notesForReviewer: ["tests ran"] }, null, 2), "utf8");
    const workerResult = await validateWorkerArtifacts(workerLog, workerJson);
    expect(workerResult.ok).toBe(true);

    const context = path.join(dir, "worker-context.md");
    const memory = path.join(dir, "feature-memory.md");
    const managerLog = path.join(dir, "manager-handoff-log.md");
    const managerJson = path.join(dir, "manager-handoff.json");
    await writeFile(context, "# Worker Context — STK-001\n\n## Status\nAPPROVED\n\n## Files modified\n- src/example.ts: done [complete]\n\n## Reviewer findings\n- none\n\n## Continuation notes\n- none\n", "utf8");
    await writeFile(memory, "# Feature Memory — demo\n\n## Patterns confirmed\n- reuse helper\n\n## Decisions\n- keep scope thin\n\n## Pitfalls to avoid\n- avoid drift\n\n## Ticket learnings\n### demo\n- 2026-04-21 STK-001 done\n", "utf8");
    await writeFile(managerLog, "# Handoff Log — STK-001\n\n## Manager\n- promoted learnings\n", "utf8");
    await writeFile(managerJson, JSON.stringify({ ticketId: "STK-001", phase: "manager", status: "APPROVED", promotedToFeatureMemory: ["reuse helper"], reusablePatterns: ["thin slices"], continuationAdvice: ["read feature memory"] }, null, 2), "utf8");
    const managerResult = await validateManagerArtifacts(context, memory, managerLog, managerJson);
    expect(managerResult.ok).toBe(true);
  });
});
