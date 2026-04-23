# Pi-TUI Integration Research

**Date:** 2026-04-23  
**Purpose:** Evaluate `@mariozechner/pi-tui` for pi-feature-flow UI components

---

## Executive Summary

pi-feature-flow has been migrated from manual ASCII rendering to `@mariozechner/pi-tui`, adopting the same patterns used by [pi-subagents](https://github.com/nicobailon/pi-subagents). This document captures the research, decisions, and implementation details.

---

## Source Repositories Analyzed

### 1. `@mariozechner/pi-tui`
**Repository:** https://github.com/badlogic/pi-mono/tree/main/packages/tui  
**Version:** 0.69.0

A minimal terminal UI framework with:
- **Differential Rendering:** Three-strategy rendering that only updates what changed
- **Synchronized Output:** Uses CSI 2026 for atomic screen updates (no flicker)
- **Component-based:** Simple `Component` interface with `render()` method
- **Built-in Components:** Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, Spacer, Image, Box, Container

### 2. `pi-subagents` (Reference Implementation)
**Repository:** https://github.com/nicobailon/pi-subagents  
**Key File:** [render.ts](https://github.com/nicobailon/pi-subagents/blob/main/render.ts)

pi-subagents provided the pattern we adopted: **using pi-tui components without the full TUI event loop**.

---

## Key Patterns from pi-subagents

### Pattern 1: Components Without Full TUI

pi-subagents does NOT use `TUI.start()` or take over the terminal. Instead, it:

```typescript
import { Container, Text, Spacer, Markdown, visibleWidth } from "@mariozechner/pi-tui";

// Create container and add children
const container = new Container();
container.addChild(new Text("Hello", 0, 0));
container.addChild(new Spacer(1));
container.addChild(new Markdown(output, 0, 0, mdTheme));

// Get rendered lines as string[]
const lines = container.render(width);
```

### Pattern 2: Custom Truncation Helper

pi-tui's `truncateToWidth()` adds `\x1b[0m` (reset) before ellipsis, which breaks chalk backgrounds. pi-subagents created a custom `truncLine()`:

```typescript
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function truncLine(text: string, maxWidth: number): string {
  if (visibleWidth(text) <= maxWidth) return text;

  const targetWidth = maxWidth - 1;
  let result = "";
  let currentWidth = 0;
  let activeStyles: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (ansiMatch) {
      const code = ansiMatch[0];
      result += code;
      if (code === "\x1b[0m" || code === "\x1b[m") {
        activeStyles = [];
      } else {
        activeStyles.push(code);
      }
      i += code.length;
      continue;
    }
    // ... grapheme processing
    if (currentWidth + graphemeWidth > targetWidth) {
      return result + activeStyles.join("") + "…";
    }
  }
  return result + activeStyles.join("") + "…";
}
```

### Pattern 3: Widget System (Conditional)

pi-subagents uses `ctx.ui.setWidget()` for async job tracking. This requires `ExtensionContext.ui` which may not be available in all contexts.

```typescript
// In pi-subagents/render.ts
if (!ctx.hasUI) return;
ctx.ui.setWidget(WIDGET_KEY, lines);
```

---

## What pi-feature-flow Uses Now

### Dependencies Added

```json
{
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-tui": "^0.69.0",
    "chalk": "^5.5.0"
  }
}
```

### Files Modified

| File | Changes |
|------|---------|
| `src/ui/status.ts` | Migrated to pi-tui Container/Box/Text |
| `src/ui/settings.ts` | Migrated to pi-tui Container/Box/Text |
| `package.json` | Added pi-tui dependencies |
| `tests/viewers/*.ts` | Updated tests for new output format |

### Components Available for Future Use

| Component | Use Case |
|-----------|----------|
| `Container` | Groups children, provides `render()` method |
| `Box` | Applies padding and background color |
| `Text` | Multi-line text with word wrapping |
| `TruncatedText` | Single-line truncation |
| `Markdown` | Render markdown with syntax highlighting |
| `Spacer` | Vertical spacing |
| `SelectList` | Interactive selection with keyboard nav |
| `Loader` | Animated loading spinner |
| `Input` | Single-line text input |
| `Editor` | Multi-line editor with autocomplete |

### Utilities Available

```typescript
import { 
  visibleWidth,    // Get visible width (ignoring ANSI)
  truncateToWidth, // Truncate with ANSI preservation
  matchesKey,      // Keyboard input detection
  Key              // Key constants
} from "@mariozechner/pi-tui";
```

---

## Architecture Comparison

### Before (Manual ASCII)

```typescript
// Pure string manipulation
const W = 58;
const TL = `╔${"═".repeat(W - 2)}╗`;

function renderStatusPanel(): string {
  const lines: string[] = [];
  lines.push(TL);
  lines.push(`│  Feature Flow Status${" ".repeat(W - 24)}│`);
  // ...
  return lines.join("\n");
}
```

### After (pi-tui Components)

```typescript
import { Container, Box, Text } from "@mariozechner/pi-tui";

function renderStatusPanel(): string {
  const container = new Container();
  
  const headerBox = new Box(0, 0, BORDER_COLOR_FN);
  headerBox.addChild(new Text("╔" + "═".repeat(W - 2) + "╗", 0, 0));
  container.addChild(headerBox);
  
  const titleBox = new Box(1, 0, BORDER_COLOR_FN);
  titleBox.addChild(new Text("  Feature Flow Status", 0, 0));
  container.addChild(titleBox);
  
  // ...
  return container.render(W).join("\n");
}
```

---

## Features NOT Yet Used

### 1. Differential Rendering
The TUI's differential rendering is valuable when you have a polling component. Currently, `FeatureFlowStatusComponent` re-renders everything on each poll interval.

To enable true differential rendering, you'd need to integrate with the full `TUI` event loop:
```typescript
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
tui.addChild(statusComponent);
tui.start();  // Takes over terminal
```

### 2. Overlay System
For modal dialogs:
```typescript
const handle = tui.showOverlay(component, {
  width: 60,
  anchor: 'center'
});
handle.hide();
```

### 3. Keyboard Shortcuts with `matchesKey`
More robust key detection:
```typescript
import { matchesKey, Key } from "@mariozechner/pi-tui";

handleKey(data: string): void {
  if (matchesKey(data, Key.up)) { /* navigate */ }
  if (matchesKey(data, Key.escape)) { /* close */ }
}
```

### 4. SelectList for Interactive Selection
Replaces manual arrow-key navigation:
```typescript
const list = new SelectList(items, 5, theme);
list.onSelect = (item) => { /* handle selection */ };
list.onCancel = () => { /* close */ };
```

---

## Integration Points to Explore

### ExtensionContext.ui API
The pi-coding-agent provides an `ExtensionContext` with a `ui` object:

```typescript
interface ExtensionContext {
  ui: {
    theme: Theme;
    setStatus(key: string, value: string): void;
    setWidget(key: string, lines: string[] | undefined): void;
    hasUI: boolean;
  };
}
```

When `ctx.hasUI` is true, you can use:
- `ctx.ui.setWidget()` — for persistent status displays
- `ctx.ui.theme` — for consistent theming

### Theme Colors
pi-coding-agent provides a theme object:
```typescript
ctx.ui.theme.fg("accent", "text")      // Foreground color
ctx.ui.theme.bg("toolSuccessBg", "text")  // Background color
ctx.ui.theme.bold("text")              // Bold text
```

---

## Testing Strategy

Tests verify the rendered output as strings:

```typescript
it("renders the ASCII frame", () => {
  const panel = renderStatusPanel([], [], 0);
  expect(panel).toMatch(/^╔/);      // Starts with ╔
  expect(panel).toMatch(/╝$/);      // Ends with ╝
  expect(panel).toContain("Feature Flow Status");
});
```

---

## Future Enhancements

### Short-term
1. Use `SelectList` in the status panel for run selection instead of manual key handling
2. Add `matchesKey`/`Key` for more robust keyboard handling
3. Integrate with `ExtensionContext.ui.theme` for consistent colors

### Long-term
1. Migrate to full `TUI` event loop for differential rendering
2. Add overlays for detailed run information
3. Implement real-time status updates via widgets

---

## References

- [pi-tui GitHub](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- [pi-tui README](./node_modules/@mariozechner/pi-tui/README.md)
- [pi-subagents render.ts](https://github.com/nicobailon/pi-subagents/blob/main/render.ts)
- [pi-subagents async-status.ts](https://github.com/nicobailon/pi-subagents/blob/main/async-status.ts)
