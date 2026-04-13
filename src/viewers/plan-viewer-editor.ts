export type ItemKind = "checkbox" | "bullet" | "text" | "heading" | "numbered";

export interface PlanItem {
	id: number;
	kind: ItemKind;
	level: number;
	raw: string;
	text: string;
	checked: boolean;
	indent: number;
	number: number;
}

export interface PlanDocument {
	items: PlanItem[];
	nextId: number;
}

/** Parse markdown into a structured plan document */
export function parseMarkdown(markdown: string): PlanDocument {
	const CHECKBOX_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;
	const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
	const HEADING_RE = /^(#{1,6})\s+(.*)$/;
	const NUMBERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

	let nextId = 1;
	const items: PlanItem[] = [];

	const lines = markdown.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const cbMatch = trimmed.match(CHECKBOX_RE);
		if (cbMatch) {
			items.push({
				id: nextId++,
				kind: "checkbox",
				level: 0,
				raw: line,
				text: cbMatch[3],
				checked: cbMatch[2].toLowerCase() === "x",
				indent: cbMatch[1].length,
				number: 0,
			});
			continue;
		}

		const headingMatch = trimmed.match(HEADING_RE);
		if (headingMatch) {
			items.push({
				id: nextId++,
				kind: "heading",
				level: headingMatch[1].length,
				raw: line,
				text: headingMatch[2],
				checked: false,
				indent: 0,
				number: 0,
			});
			continue;
		}

		const numberedMatch = trimmed.match(NUMBERED_RE);
		if (numberedMatch) {
			items.push({
				id: nextId++,
				kind: "numbered",
				level: 0,
				raw: line,
				text: numberedMatch[3],
				checked: false,
				indent: numberedMatch[1].length,
				number: parseInt(numberedMatch[2], 10),
			});
			continue;
		}

		const bulletMatch = trimmed.match(BULLET_RE);
		if (bulletMatch) {
			items.push({
				id: nextId++,
				kind: "bullet",
				level: 0,
				raw: line,
				text: bulletMatch[2],
				checked: false,
				indent: bulletMatch[1].length,
				number: 0,
			});
			continue;
		}

		items.push({
			id: nextId++,
			kind: "text",
			level: 0,
			raw: line,
			text: trimmed,
			checked: false,
			indent: 0,
			number: 0,
		});
	}

	return { items, nextId };
}

function itemToMarkdown(item: PlanItem): string {
	switch (item.kind) {
		case "checkbox":
			return `${" ".repeat(item.indent)}-${item.checked ? "[x]" : "[ ]"} ${item.text}`;
		case "heading":
			return `${"#".repeat(item.level)} ${item.text}`;
		case "numbered":
			return `${" ".repeat(item.indent)}${item.number}. ${item.text}`;
		case "bullet":
			return `${" ".repeat(item.indent)}- ${item.text}`;
		case "text":
		default:
			return `${" ".repeat(item.indent)}${item.text}`;
	}
}

export function serializeMarkdown(doc: PlanDocument): string {
	return doc.items.map(itemToMarkdown).join("\n");
}

export function toggleCheckbox(doc: PlanDocument, itemId: number): PlanDocument {
	return {
		...doc,
		items: doc.items.map((item) =>
			item.id === itemId && item.kind === "checkbox" ? { ...item, checked: !item.checked } : item,
		),
	};
}

export function editItemText(doc: PlanDocument, itemId: number, newText: string): PlanDocument {
	return {
		...doc,
		items: doc.items.map((item) => (item.id === itemId ? { ...item, text: newText } : item)),
	};
}

export function moveItemUp(doc: PlanDocument, itemId: number): PlanDocument {
	const index = doc.items.findIndex((item) => item.id === itemId);
	if (index <= 0) return doc;

	const newItems = [...doc.items];
	[newItems[index - 1], newItems[index]] = [newItems[index], newItems[index - 1]];
	return { ...doc, items: newItems };
}

export function moveItemDown(doc: PlanDocument, itemId: number): PlanDocument {
	const index = doc.items.findIndex((item) => item.id === itemId);
	if (index < 0 || index >= doc.items.length - 1) return doc;

	const newItems = [...doc.items];
	[newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
	return { ...doc, items: newItems };
}

export function addSection(
	doc: PlanDocument,
	afterItemId: number | null,
	title: string,
	level: number = 2,
): PlanDocument {
	const afterIndex = afterItemId ? doc.items.findIndex((item) => item.id === afterItemId) : -1;
	const insertIndex = afterIndex >= 0 ? afterIndex + 1 : doc.items.length;

	const newItem: PlanItem = {
		id: doc.nextId,
		kind: "heading",
		level,
		raw: `${"#".repeat(level)} ${title}`,
		text: title,
		checked: false,
		indent: 0,
		number: 0,
	};

	const newItems = [...doc.items];
	newItems.splice(insertIndex, 0, newItem);

	return {
		...doc,
		items: newItems,
		nextId: doc.nextId + 1,
	};
}

export function addItem(
	doc: PlanDocument,
	afterItemId: number | null,
	text: string,
	kind: ItemKind = "checkbox",
): PlanDocument {
	const afterIndex = afterItemId ? doc.items.findIndex((item) => item.id === afterItemId) : -1;
	const insertIndex = afterIndex >= 0 ? afterIndex + 1 : doc.items.length;

	const newItem: PlanItem = {
		id: doc.nextId,
		kind,
		level: 0,
		raw: kind === "checkbox" ? `- [ ] ${text}` : `- ${text}`,
		text,
		checked: false,
		indent: 0,
		number: kind === "numbered" ? 1 : 0,
	};

	const newItems = [...doc.items];
	newItems.splice(insertIndex, 0, newItem);

	return {
		...doc,
		items: newItems,
		nextId: doc.nextId + 1,
	};
}

export function removeItem(doc: PlanDocument, itemId: number): PlanDocument {
	return {
		...doc,
		items: doc.items.filter((item) => item.id !== itemId),
	};
}

export function getNavigableIndices(doc: PlanDocument): number[] {
	return doc.items.map((_, index) => index);
}

export function getCheckboxIndices(doc: PlanDocument): number[] {
	return doc.items
		.filter((item) => item.kind === "checkbox")
		.map((item) => doc.items.indexOf(item));
}
