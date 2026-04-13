import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type PendingExecution =
  | {
      kind: "feature-plan";
      feature: string;
      cwd: string;
      specsRoot: string;
    }
  | {
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

export function getPendingExecution(): PendingExecution | undefined {
  return pendingExecution;
}

export function setPendingExecution(next: PendingExecution | undefined): void {
  pendingExecution = next;
}

export function outcomeLabel(status: ParsedOutcome["status"]): "APPROVED" | "BLOCKED" | "NEEDS-FIX" {
  return status === "done" ? "APPROVED" : status === "blocked" ? "BLOCKED" : "NEEDS-FIX";
}

export function parseOutcome(messages: Array<{ role: string; content?: unknown }>): ParsedOutcome | undefined {
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
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

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
