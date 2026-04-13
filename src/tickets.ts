import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig, TicketRecord } from "./types.js";

export async function discoverTickets(ticketsDir: string, config: FeatureTicketFlowConfig): Promise<TicketRecord[]> {
  const files = (await fs.readdir(ticketsDir)).filter((file) => file.endsWith(".md")).sort();
  const tickets = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(ticketsDir, file);
      const content = await fs.readFile(absolutePath, "utf8");
      const id = file.replace(/\.md$/, "");
      return {
        id,
        title: parseTitle(content, id),
        path: absolutePath,
        dependencies: parseDependencies(content, config),
        status: "pending" as const,
        updatedAt: new Date().toISOString(),
        runs: [],
      } satisfies TicketRecord;
    }),
  );

  return tickets.sort((a: TicketRecord, b: TicketRecord) => a.id.localeCompare(b.id));
}

export function parseTitle(content: string, fallbackId: string) {
  const heading = content.match(/^#\s+[^—-]+[—-]\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();

  const firstHeading = content.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim() || fallbackId;
}

export function parseDependencies(content: string, config: FeatureTicketFlowConfig) {
  if (config.dependencyParsing.mode === "frontmatter") {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    const field = config.dependencyParsing.frontmatterField || "requires";
    const line = frontmatter?.[1]
      .split("\n")
      .find((row) => row.trim().toLowerCase().startsWith(`${field.toLowerCase()}:`));
    if (!line) return [];
    const raw = line.split(":").slice(1).join(":").trim();
    return normalizeDependencyList(raw, config.dependencyParsing.splitPattern);
  }

  if (config.dependencyParsing.mode === "custom") {
    const pattern = config.dependencyParsing.customPattern;
    if (!pattern) return [];

    const match = content.match(new RegExp(pattern, "m"));
    return normalizeDependencyList(match?.[1] || "", config.dependencyParsing.splitPattern);
  }

  const label = escapeRegExp(config.dependencyParsing.requiresLabel);
  const match = content.match(new RegExp(`^-\\s*${label}:\\s*(.+)$`, "m"));
  return normalizeDependencyList(match?.[1] || "", config.dependencyParsing.splitPattern);
}

function normalizeDependencyList(raw: string, splitPattern = ",") {
  const value = raw.trim();
  if (!value || value.toLowerCase() === "none" || value === "-") return [];

  const splitter = splitPattern === "," ? /,/ : new RegExp(splitPattern);
  return value
    .split(splitter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
