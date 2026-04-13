import { chromium } from "playwright";
import { generatePlanViewerHTML } from "../../src/viewers/plan-viewer-html.js";
import { writeFileSync } from "fs";

const REALISTIC_MARKDOWN = `# Feature execution plan

## Approach Summary
- Build the backend API first
- Then the frontend components

## Ticket Sequence
1. STK-001 — Backend data model
2. STK-002 — Frontend UI

## Code Example
\`\`\`typescript
interface User {
  id: string;
  email: string;
}
\`\`\`

## Notes
> This is a quote with **bold** and *italic*

### Edge cases
- null: handle gracefully
- \`inline code\` with backticks
- <Component> tags
- </ClosingTag>

---

**Summary**: done.
`;

async function runTests() {
  const browser = await chromium.launch({ headless: true });

  // Test 1: Realistic markdown renders
  {
    const html = generatePlanViewerHTML({
      title: "Test Feature",
      feature: "test-feature",
      markdown: REALISTIC_MARKDOWN,
      port: 3939,
    });
    writeFileSync("/tmp/plan-viewer-test.html", html);

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push("PAGE: " + err.message));

    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    const text = await page.locator("#planContainer").textContent();
    const title = await page.title();

    console.log("=== Test 1: Realistic markdown ===");
    console.log("Title:", title);
    console.log("Has H1:", text?.includes("Feature execution plan"));
    console.log("Has ticket:", text?.includes("STK-001"));
    console.log("Has code:", text?.includes("typescript"));
    console.log("Content length:", text?.length);
    console.log("Errors:", errors.length > 0 ? errors : "none ✓");

    if (errors.length > 0) {
      console.error("FAILED: JS errors detected");
      process.exitCode = 1;
    }
    if (!text?.includes("Feature execution plan")) {
      console.error("FAILED: content not rendered");
      process.exitCode = 1;
    }

    await page.close();
  }

  // Test 2: Backticks and code fences
  {
    const md = `# H1
## H2
### H3

- [ ] unchecked
- [x] checked

\`\`\`js
const x = 1;
\`\`\`

> quote

\`inline code\`
`;
    const html = generatePlanViewerHTML({ title: "Code Test", feature: "code-test", markdown: md, port: 3940 });

    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
    page.on("pageerror", (err) => errors.push("PAGE: " + err.message));

    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);

    const text = await page.locator("#planContainer").textContent();

    console.log("\n=== Test 2: Code fences and backticks ===");
    console.log("Has H1:", text?.includes("H1"));
    console.log("Has checked:", text?.includes("checked"));
    console.log("Has quote:", text?.includes("quote"));
    console.log("Has code:", text?.includes("code"));
    console.log("Errors:", errors.length > 0 ? errors : "none ✓");

    if (errors.length > 0) {
      console.error("FAILED: JS errors");
      process.exitCode = 1;
    }

    await page.close();
  }

  await browser.close();
  console.log("\nAll tests passed ✓");
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
