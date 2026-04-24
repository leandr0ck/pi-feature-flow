import { describe, expect, it } from "vitest";
import {
  renderManagerHandoffJsonTemplate,
  renderFeatureMemoryTemplate,
  renderHandoffLogTemplate,
  renderHandoffLogTemplateForPhase,
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

  it("renders handoff log (tester phase by default) with placeholders in Tester section and comments for future phases", () => {
    const content = renderHandoffLogTemplate("STK-001");
    expect(content).toContain("# Handoff Log — STK-001");
    expect(content).toContain("## Tester");
    expect(content).toContain("Tests written: <files and scope>");
    expect(content).toContain("<!-- ## Worker section:");
    expect(content).toContain("<!-- ## Reviewer section:");
    expect(content).toContain("<!-- ## Manager section:");
  });

  describe("renderHandoffLogTemplateForPhase", () => {
    it("renders tester phase with only Tester section placeholders and HTML comments for future phases", () => {
      const content = renderHandoffLogTemplateForPhase("STK-001", "tester");
      expect(content).toContain("# Handoff Log — STK-001");
      expect(content).toContain("## Tester");
      expect(content).toContain("Tests written: <files and scope>");
      expect(content).toContain("<!-- ## Worker section:");
      expect(content).toContain("<!-- ## Reviewer section:");
      expect(content).toContain("<!-- ## Manager section:");
      // Future phase sections should NOT have <...> placeholders
      expect(content).not.toContain("## Worker\n- Files changed: <");
      expect(content).not.toContain("## Reviewer\n- Verifications: <");
      expect(content).not.toContain("## Manager\n- Promoted to feature memory: <");
    });

    it("renders worker phase with Tester and Worker sections", () => {
      const content = renderHandoffLogTemplateForPhase("STK-001", "worker");
      expect(content).toContain("## Tester");
      expect(content).toContain("## Worker");
      expect(content).toContain("Files changed: <paths>");
      expect(content).toContain("<!-- ## Reviewer section:");
      expect(content).toContain("<!-- ## Manager section:");
    });

    it("renders reviewer phase with Worker section filled and Reviewer section with placeholders", () => {
      const content = renderHandoffLogTemplateForPhase("STK-001", "reviewer");
      expect(content).toContain("## Tester");
      expect(content).toContain("## Worker");
      expect(content).toContain("## Reviewer");
      expect(content).toContain("Verifications: <checks performed>");
      expect(content).toContain("Recommendation: <APPROVED | NEEDS-FIX | BLOCKED>");
      expect(content).toContain("<!-- ## Manager section:");
    });

    it("renders manager phase with all sections but only Manager has placeholders", () => {
      const content = renderHandoffLogTemplateForPhase("STK-001", "manager");
      expect(content).toContain("## Tester");
      expect(content).toContain("## Worker");
      expect(content).toContain("## Reviewer");
      expect(content).toContain("## Manager");
      expect(content).toContain("Promoted to feature memory: <none | bullets>");
    });

    it("renderHandoffLogTemplate defaults to tester phase", () => {
      const template = renderHandoffLogTemplate("STK-001");
      const explicit = renderHandoffLogTemplateForPhase("STK-001", "tester");
      expect(template).toEqual(explicit);
    });
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
