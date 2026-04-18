import { describe, expect, it } from "vitest";
import {
  validateExecutionPlanTemplate,
  renderExecutionPlanTemplate,
  REQUIRED_EXECUTION_PLAN_SECTIONS,
} from "../src/execution-plan-template.js";

// ─── renderExecutionPlanTemplate ──────────────────────────────────────────────

describe("renderExecutionPlanTemplate", () => {
  it("renders a valid execution plan that passes its own validator", () => {
    const result = renderExecutionPlanTemplate("my-feature");
    const issues = validateExecutionPlanTemplate(result);
    expect(issues).toHaveLength(0);
  });

  it("includes the feature name in the heading", () => {
    const result = renderExecutionPlanTemplate("onboarding-flow");
    expect(result).toContain("# onboarding-flow execution plan");
  });

  it("includes all required sections", () => {
    const result = renderExecutionPlanTemplate("test");
    for (const section of REQUIRED_EXECUTION_PLAN_SECTIONS) {
      expect(result).toContain(section);
    }
    expect(result).toContain("## Rollout Notes");
  });
});

// ─── validateExecutionPlanTemplate ────────────────────────────────────────────

describe("validateExecutionPlanTemplate", () => {
  const validPlan = renderExecutionPlanTemplate("my-feature");

  it("returns no issues for a valid plan", () => {
    expect(validateExecutionPlanTemplate(validPlan)).toHaveLength(0);
  });

  it("reports error for a missing or malformed heading", () => {
    const content = validPlan.replace("# my-feature execution plan", "# my-feature plan");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("heading"))).toBe(true);
  });

  it("reports error when ## Approach Summary is missing", () => {
    const content = validPlan.replace("## Approach Summary", "## Summary");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("## Approach Summary"))).toBe(true);
  });

  it("reports error when ## Ticket Sequence is missing", () => {
    const content = validPlan.replace("## Ticket Sequence", "## Tickets");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("## Ticket Sequence"))).toBe(true);
  });

  it("reports error when ## Dependency Logic is missing", () => {
    const content = validPlan.replace("## Dependency Logic", "## Dependencies");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("## Dependency Logic"))).toBe(true);
  });

  it("reports error when ## Validation Strategy is missing", () => {
    const content = validPlan.replace("## Validation Strategy", "## Testing");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("## Validation Strategy"))).toBe(true);
  });

  it("reports error when ## Rollout Notes is missing", () => {
    const content = validPlan.replace("## Rollout Notes", "## Release");
    const issues = validateExecutionPlanTemplate(content);
    expect(issues.some((i) => i.includes("## Rollout Notes"))).toBe(true);
  });
});
