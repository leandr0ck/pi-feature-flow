import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Phase = "planner" | "tester" | "worker" | "reviewer" | "manager";

export type RunStatus = "ok" | "error" | "running";

export type RunOutcome = "APPROVED" | "BLOCKED" | "NEEDS-FIX";

export interface TokenUsage {
  input: number;
  output: number;
  cost: number;
}

export interface RunEntry {
  feature: string;
  ticketId: string;
  phase: Phase;
  phase_run: number; // index of attempt for this phase (0-based)
  ts: number;        // unix epoch ms
  status: RunStatus;
  duration?: number; // ms
  outcome?: RunOutcome;
  model?: string;    // provider/id
  thinking?: string;
  skills?: string[];
  tokens?: TokenUsage;
  error?: string;
}

type StoredRun = Omit<RunEntry, "ts" | "phase_run" | "status">;

// ─── Path constants ───────────────────────────────────────────────────────────

const HISTORY_DIR = path.join(".pi", "agent");
const HISTORY_FILE = "feature-flow-history.jsonl";
const MAX_LINES = 1000;
const KEEP_LINES = 800;

let _historyRoot: string | null = null;
let _historyPathOverride: string | null = null;

/**
 * For testing only: override the history file path.
 * Pass null to restore the default (homedir).
 */
export function _setHistoryPath(path: string | null): void {
  _historyPathOverride = path;
}

function getHistoryPath(): string {
  if (_historyPathOverride !== null) return _historyPathOverride;
  return path.join(homedir(), HISTORY_DIR, HISTORY_FILE);
}

// ─── In-memory store ─────────────────────────────────────────────────────────

/** Active runs keyed by runId: "feature/ticketId/phase" */
const activeRuns = new Map<string, RunEntry>();

// ─── JSONL helpers ───────────────────────────────────────────────────────────

function persistEntry(entry: RunEntry): void {
  try {
    const filePath = getHistoryPath();
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Write failures are silent — never block execution
  }
}

function rotateIfNeeded(): void {
  try {
    const filePath = getHistoryPath();
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);

    if (lines.length <= MAX_LINES) return;

    // Keep the last KEEP_LINES lines
    const kept = lines.slice(-KEEP_LINES);
    writeFileSync(filePath, kept.join("\n") + "\n", "utf8");
  } catch {
    // Rotation failures are silent
  }
}

// ─── Phase-run counter (how many times startRun was called per runId) ────────

const phaseRunCounters = new Map<string, number>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a new run for a phase.
 * Returns the full RunEntry with ts, phase_run, and status="running".
 */
export function startRun(runId: string, entry: StoredRun): RunEntry {
  // Increment phase run counter
  const counter = phaseRunCounters.get(runId) ?? -1;
  const phase_run = counter + 1;
  phaseRunCounters.set(runId, phase_run);

  const full: RunEntry = {
    ...entry,
    ts: Date.now(),
    phase_run,
    status: "running",
  };

  activeRuns.set(runId, full);
  return full;
}

/**
 * Update fields on an active run (e.g. model, thinking, tokens).
 * Does nothing if the runId is not active.
 */
export function updateRun(runId: string, updates: Partial<RunEntry>): void {
  const existing = activeRuns.get(runId);
  if (!existing) return;

  activeRuns.set(runId, { ...existing, ...updates });
}

/**
 * Finish an active run: set status, persist to JSONL, remove from active.
 */
export function finishRun(runId: string, status: RunStatus, error?: string): void {
  const existing = activeRuns.get(runId);
  if (!existing) return;

  const finished: RunEntry = {
    ...existing,
    status,
    duration: Date.now() - existing.ts,
    error: error ?? existing.error,
  };

  activeRuns.delete(runId);
  persistEntry(finished);
  rotateIfNeeded();
}

/**
 * Return the most recent run entries, newest first.
 *
 * @param limit  Maximum number of entries to return. Default: 10.
 * @returns RunEntry[]  Sorted by ts descending. Empty array if no history file or on error.
 *
 * TUI contract: STK-012/014 import this directly — no adapter needed.
 */
export function getRecentRuns(limit = 10): RunEntry[] {
  try {
    const filePath = getHistoryPath();
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);

    const entries: RunEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as RunEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Return all runs currently in "running" state.
 *
 * @returns RunEntry[]  Only runs with status === "running". Empty array if none active.
 *
 * TUI contract: STK-012 polls this every 2s while active runs exist.
 */
export function getActiveRuns(): RunEntry[] {
  return [...activeRuns.values()];
}

// ─── For testing only: reset all module-level state ────────────────────────────

/**
 * Resets the in-memory store and counters.
 * For use in tests only — never call in production.
 */
export function _resetForTesting(): void {
  activeRuns.clear();
  phaseRunCounters.clear();
  _historyPathOverride = null;
}
