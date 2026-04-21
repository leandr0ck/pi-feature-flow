import { describe, expect, it } from "vitest";
import { buildReviewerPrompt } from "../src/feature-flow/prompts.js";

describe("reviewer prompt", () => {
  it("allows corrective review with ticket-scoped edits and TDD-first guidance", () => {
    const prompt = buildReviewerPrompt(
      "demo-feature",
      "STK-001",
      "/specs/demo-feature",
      "/specs/demo-feature/tickets/STK-001.md",
      "/specs/demo-feature/04-feature-memory.md",
      "/specs/demo-feature/tickets/STK-001-reviewer-notes.md",
      "/specs/demo-feature/tickets/STK-001-handoff-log.md",
      {},
    );

    expect(prompt).toContain("perform a corrective code review when needed");
    expect(prompt).toContain("you may edit tests and/or implementation within the ticket-owned file scope");
    expect(prompt).toContain("add or adjust tests first whenever needed");
    expect(prompt).toContain("If review passes cleanly, do not edit code");
  });
});
