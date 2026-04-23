import { describe, expect, it } from "vitest";
import {
  renderManagerHandoffJsonTemplate,
  renderFeatureMemoryTemplate,
  renderHandoffLogTemplate,
  renderReviewerHandoffJsonTemplate,
  renderReviewerNotesTemplate,
  renderTesterHandoffJsonTemplate,
  renderTesterNotesTemplate,
  renderWorkerContextTemplate,
  renderWorkerHandoffJsonTemplate,
  toJsonCodeFence,
  toMarkdownCodeFence,
} from "../src/handoff-templates.js";

describe("handoff templates", () => {
  it("renders tester notes with fixed sections", () => {
    const content = renderTesterNotesTemplate("STK-001");
    expect(content).toContain("# Tester Notes — STK-001");
    expect(content).toContain("## Tests written");
    expect(content).toContain("## Test guidelines followed");
    expect(content).toContain("## Notes for worker");
  });

  it("renders reviewer notes with fixed sections", () => {
    const content = renderReviewerNotesTemplate("STK-001");
    expect(content).toContain("# Reviewer Notes — STK-001");
    expect(content).toContain("## Verdict");
    expect(content).toContain("## Findings");
    expect(content).toContain("## Reviewer edits made");
    expect(content).toContain("## Evidence");
  });

  it("renders worker context with fixed sections", () => {
    const content = renderWorkerContextTemplate("STK-001");
    expect(content).toContain("# Worker Context — STK-001");
    expect(content).toContain("## Status");
    expect(content).toContain("## Files modified");
    expect(content).toContain("## Continuation notes");
  });

  it("renders handoff log with all role sections", () => {
    const content = renderHandoffLogTemplate("STK-001");
    expect(content).toContain("# Handoff Log — STK-001");
    expect(content).toContain("## Tester");
    expect(content).toContain("Test guidelines followed");
    expect(content).toContain("## Worker");
    expect(content).toContain("## Reviewer");
    expect(content).toContain("Edits made");
    expect(content).toContain("## Manager");
  });

  it("renders feature memory template with fixed sections", () => {
    const content = renderFeatureMemoryTemplate("checkout-flow");
    expect(content).toContain("# Feature Memory — checkout-flow");
    expect(content).toContain("## Patterns confirmed");
    expect(content).toContain("## Decisions");
    expect(content).toContain("## Pitfalls to avoid");
    expect(content).toContain("## Ticket learnings");
  });

  it("renders structured JSON handoff templates", () => {
    expect(renderTesterHandoffJsonTemplate("STK-001")).toContain('"phase": "tester"');
    expect(renderWorkerHandoffJsonTemplate("STK-001")).toContain('"phase": "worker"');
    expect(renderReviewerHandoffJsonTemplate("STK-001")).toContain('"phase": "reviewer"');
    expect(renderManagerHandoffJsonTemplate("STK-001")).toContain('"phase": "manager"');
  });

  it("wraps template content in markdown fences", () => {
    expect(toMarkdownCodeFence("# Title\n")).toEqual(["```md", "# Title", "```"]);
  });

  it("wraps template content in json fences", () => {
    expect(toJsonCodeFence('{"ok":true}\n')).toEqual(["```json", '{"ok":true}', "```"]);
  });
});
