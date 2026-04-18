import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type PendingExecution =
  | {
      kind: "feature-plan";
      feature: string;
      cwd: string;
      specsRoot: string;
    }
  | {
      /** Tester phase: runs first when TDD is enabled. Produces tester-notes before the worker starts. */
      kind: "ticket-tester";
      feature: string;
      ticketId: string;
      cwd: string;
      specsRoot: string;
    }
  | {
      /** Worker → reviewer → chief phase. Runs after the tester (TDD) or directly (non-TDD). */
      kind: "ticket-execution";
      feature: string;
      ticketId: string;
      phase: "start" | "resume" | "retry";
      cwd: string;
      specsRoot: string;
    };

export type ParsedOutcome = {
  status: "done" | "blocked" | "needs_fix";
  note?: string;
};

let pendingExecution: PendingExecution | undefined;

// ─── Checkpoint file helpers ─────────────────────────────────────────────────
// Persists PendingExecution to disk so the session can resume after a crash
// or pi restart mid-execution. One file per feature directory.

function checkpointPath(specsRoot: string, feature: string): string {
  return path.join(specsRoot, feature, ".pending-execution.json");
}

export async function persistCheckpoint(pending: PendingExecution): Promise<void> {
  const specsRoot = "specsRoot" in pending
    ? (pending as { specsRoot: string }).specsRoot
    : undefined;
  if (!specsRoot) return;
  const feature = "feature" in pending ? (pending as { feature: string }).feature : undefined;
  if (!feature) return;
  try {
    await fs.writeFile(checkpointPath(specsRoot, feature), JSON.stringify(pending, null, 2), "utf8");
  } catch {
    // Non-fatal — checkpoint is best-effort
  }
}

export async function clearCheckpoint(specsRoot: string, feature: string): Promise<void> {
  try {
    await fs.unlink(checkpointPath(specsRoot, feature));
  } catch {
    // Already gone — fine
  }
}

export async function loadCheckpoint(specsRoot: string, feature: string): Promise<PendingExecution | undefined> {
  try {
    const raw = await fs.readFile(checkpointPath(specsRoot, feature), "utf8");
    return JSON.parse(raw) as PendingExecution;
  } catch {
    return undefined;
  }
}

// ─── In-memory state ─────────────────────────────────────────────────────────

export function getPendingExecution(): PendingExecution | undefined {
  return pendingExecution;
}

export function setPendingExecution(next: PendingExecution | undefined): void {
  pendingExecution = next;
}

export function outcomeLabel(status: ParsedOutcome["status"]): "APPROVED" | "BLOCKED" | "NEEDS-FIX" {
  return status === "done" ? "APPROVED" : status === "blocked" ? "BLOCKED" : "NEEDS-FIX";
}

export function parseOutcome(
  messages: Array<{ role: string; content?: unknown }>,
): ParsedOutcome | undefined {
  const APPROVED = ["APPROVED"];
  const BLOCKED = ["BLOCKED"];
  const NEEDS_FIX = ["NEEDS-FIX", "NEEDS_FIX", "NEEDS FIX"];

  const assistantTexts = messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => {
      const content = message.content as Array<{ type: string; text?: string }> | undefined;
      return (content || []).filter((part) => part.type === "text").map((part) => part.text as string);
    })
    .slice(-6)
    .reverse();

  for (const text of assistantTexts) {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const keyword of BLOCKED) {
      const found = lines.find((line) => line === keyword || text.includes(keyword));
      if (found) return { status: "blocked", note: found };
    }

    for (const keyword of NEEDS_FIX) {
      const found = lines.find((line) => line === keyword || text.includes(keyword));
      if (found) return { status: "needs_fix", note: found };
    }

    for (const keyword of APPROVED) {
      const found = lines.find((line) => line === keyword || text.includes(keyword));
      if (found) return { status: "done", note: found };
    }
  }

  return undefined;
}

export function emitInfo(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: "feature-ticket-flow", content: text, display: true });
}

// ─── Usage extraction ─────────────────────────────────────────────────────────

export type RunUsage = NonNullable<import("../types.js").TicketRun["usage"]>;

/**
 * Extract aggregate token/cost totals from the messages emitted in agent_end.
 * Each assistant message carries a `.usage` field with input/output/cacheRead/cacheWrite/cost.
 */
export function extractUsage(
  messages: Array<{ role: string; content?: unknown; usage?: unknown }>,
): RunUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const u = msg.usage as {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    } | undefined;
    if (!u) continue;
    inputTokens += u.input ?? 0;
    outputTokens += u.output ?? 0;
    cacheReadTokens += u.cacheRead ?? 0;
    cacheWriteTokens += u.cacheWrite ?? 0;
    costUsd += u.cost?.total ?? 0;
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}
