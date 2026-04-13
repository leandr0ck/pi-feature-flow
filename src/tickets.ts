import { promises as fs } from "node:fs";
import path from "node:path";
import type { FeatureTicketFlowConfig, TicketRecord } from "./types";

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
      };
    }),
  );

  return tickets.sort((a, b) => a.id.localeCompare(b.id));
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
    const line = frontmatter?.[1].split("\n").find((row) => row.trim().startsWith("requires:"));
    if (!line) return [];
    const raw = line.split(":").slice(1).join(":").trim();
    return normalizeDependencyList(raw);
  }

  const label = escapeRegExp(config.dependencyParsing.requiresLabel);
  const match = content.match(new RegExp(`^-\\s*${label}:\\s*(.+)$`, "m"));
  return normalizeDependencyList(match?.[1] || "");
}

function normalizeDependencyList(raw: string) {
  const value = raw.trim();
  if (!value || value.toLowerCase() === "none" || value === "-") return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
