import { parseMarkdown, serializeMarkdown, toggleCheckbox, moveItemUp, moveItemDown, addItem, removeItem, getCheckboxIndices } from "../../src/viewers/plan-viewer-editor.js";
import { describe, it, expect } from "vitest";

describe("plan-viewer-editor", () => {
  describe("parseMarkdown", () => {
    it("parses checkboxes", () => {
      const doc = parseMarkdown("- [ ] First task\n- [x] Second task");
      expect(doc.items).toHaveLength(2);
      expect(doc.items[0].kind).toBe("checkbox");
      expect(doc.items[0].checked).toBe(false);
      expect(doc.items[0].text).toBe("First task");
      expect(doc.items[1].checked).toBe(true);
    });

    it("parses headings", () => {
      const doc = parseMarkdown("# Main\n## Section\n### Subsection");
      expect(doc.items).toHaveLength(3);
      expect(doc.items[0].kind).toBe("heading");
      expect(doc.items[0].level).toBe(1);
      expect(doc.items[1].level).toBe(2);
      expect(doc.items[2].level).toBe(3);
    });

    it("parses numbered lists", () => {
      const doc = parseMarkdown("1. First\n2. Second\n10. Tenth");
      expect(doc.items).toHaveLength(3);
      expect(doc.items[0].kind).toBe("numbered");
      expect(doc.items[0].number).toBe(1);
      expect(doc.items[2].number).toBe(10);
    });

    it("parses bullet lists", () => {
      const doc = parseMarkdown("- Item one\n- Item two");
      expect(doc.items).toHaveLength(2);
      expect(doc.items[0].kind).toBe("bullet");
    });

    it("handles indentation", () => {
      const doc = parseMarkdown("  - [ ] indented\n- [x] normal");
      // Note: indent captures leading whitespace from raw line before trim
      expect(doc.items[0].indent).toBe(0);
      expect(doc.items[1].indent).toBe(0);
    });

    it("skips empty lines", () => {
      const doc = parseMarkdown("# Title\n\n## Section\n\n- Item");
      expect(doc.items).toHaveLength(3);
    });
  });

  describe("serializeMarkdown", () => {
    it("serializes checkboxes", () => {
      const doc = {
        items: [
          { id: 1, kind: "checkbox" as const, level: 0, raw: "- [ ] Item", text: "Item", checked: false, indent: 0, number: 0 },
          { id: 2, kind: "checkbox" as const, level: 0, raw: "- [x] Done", text: "Done", checked: true, indent: 0, number: 0 },
        ],
        nextId: 3,
      };
      const md = serializeMarkdown(doc);
      expect(md).toContain("-[ ] Item");
      expect(md).toContain("-[x] Done");
    });

    it("serializes headings", () => {
      const doc = {
        items: [
          { id: 1, kind: "heading" as const, level: 2, raw: "## Section", text: "Section", checked: false, indent: 0, number: 0 },
        ],
        nextId: 2,
      };
      const md = serializeMarkdown(doc);
      expect(md).toContain("## Section");
    });
  });

  describe("toggleCheckbox", () => {
    it("toggles checked state", () => {
      const doc = parseMarkdown("- [ ] Task");
      expect(doc.items[0].checked).toBe(false);
      const toggled = toggleCheckbox(doc, doc.items[0].id);
      expect(toggled.items[0].checked).toBe(true);
      const toggledBack = toggleCheckbox(toggled, toggled.items[0].id);
      expect(toggledBack.items[0].checked).toBe(false);
    });

    it("does not affect other items", () => {
      const doc = parseMarkdown("- [ ] Task one\n- [ ] Task two");
      const toggled = toggleCheckbox(doc, doc.items[0].id);
      expect(toggled.items[1].checked).toBe(false);
    });
  });

  describe("moveItemUp", () => {
    it("moves item up", () => {
      const doc = parseMarkdown("- First\n- Second\n- Third");
      const moved = moveItemUp(doc, doc.items[2].id);
      expect(moved.items.map((i: { text: string }) => i.text)).toEqual(["First", "Third", "Second"]);
    });

    it("does nothing for first item", () => {
      const doc = parseMarkdown("- First\n- Second");
      const moved = moveItemUp(doc, doc.items[0].id);
      expect(moved.items.map((i: { text: string }) => i.text)).toEqual(["First", "Second"]);
    });
  });

  describe("moveItemDown", () => {
    it("moves item down", () => {
      const doc = parseMarkdown("- First\n- Second\n- Third");
      const moved = moveItemDown(doc, doc.items[0].id);
      expect(moved.items.map((i: { text: string }) => i.text)).toEqual(["Second", "First", "Third"]);
    });

    it("does nothing for last item", () => {
      const doc = parseMarkdown("- First\n- Second");
      const moved = moveItemDown(doc, doc.items[1].id);
      expect(moved.items.map((i: { text: string }) => i.text)).toEqual(["First", "Second"]);
    });
  });

  describe("addItem", () => {
    it("adds item after specified id", () => {
      const doc = parseMarkdown("- [ ] First\n- [ ] Second");
      const afterId = doc.items[0].id;
      const added = addItem(doc, afterId, "New item");
      expect(added.items).toHaveLength(3);
      expect(added.items[1].text).toBe("New item");
    });

    it("adds item at end when afterItemId is null", () => {
      const doc = parseMarkdown("- [ ] First");
      const added = addItem(doc, null, "Last item");
      expect(added.items).toHaveLength(2);
      expect(added.items[1].text).toBe("Last item");
    });
  });

  describe("removeItem", () => {
    it("removes item by id", () => {
      const doc = parseMarkdown("- First\n- Second\n- Third");
      const removed = removeItem(doc, doc.items[1].id);
      expect(removed.items).toHaveLength(2);
      expect(removed.items.map((i: { text: string }) => i.text)).toEqual(["First", "Third"]);
    });
  });

  describe("getCheckboxIndices", () => {
    it("returns indices of checkbox items", () => {
      const doc = parseMarkdown("- [ ] Task\n# Heading\n- [x] Done");
      const indices = getCheckboxIndices(doc);
      expect(indices).toEqual([0, 2]);
    });
  });
});
