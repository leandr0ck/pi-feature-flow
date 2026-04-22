const FORBIDDEN_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:bun|npm|pnpm|yarn)\s+run\s+deploy\b|\bwrangler\s+deploy\b|\bvercel\b|\bnetlify\s+deploy\b|\bfly\s+deploy\b|\brailway\s+up\b|\bterraform\s+apply\b|\bpulumi\s+up\b|\bkubectl\s+apply\b|\bgh\s+workflow\s+run\b|\bdocker\s+push\b/i,
    reason: "Deploy/publish/infra execution is forbidden inside feature-flow phases.",
  },
  {
    pattern: /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b|\bgit\s+push\b|\bgit\s+tag\b|\bgh\s+pr\s+create\b/i,
    reason: "Publishing and remote git operations are forbidden inside feature-flow phases.",
  },
  {
    pattern: /db:reconcile|db-reconcile|INSERT\s+INTO\s+drizzle\.__drizzle_migrations|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE|\bpsql\b|drizzle-kit\s+push\b/i,
    reason: "Direct database surgery is forbidden. Use schema.ts + Drizzle generate/migrate only.",
  },
];

export function isSafeValidationCommand(command: string): boolean {
  return /\b(?:bun|npm|pnpm|yarn)\s+run\s+(?:typecheck|build|lint)\b|\b(?:bun|npm|pnpm|yarn)\s+build\b|\b(?:bun|npm|pnpm|yarn)\s+lint\b|\b(?:bunx|npx|pnpx)\s+tsc\b[^\n]*\s--noEmit\b|\btsc\b[^\n]*\s--noEmit\b|\b(?:next|vite|astro|svelte-kit)\s+build\b/i.test(command);
}

export function getForbiddenBashDecision(command: string, phase?: "PLANNER" | "TESTER" | "WORKER" | "REVIEWER" | "CHIEF" | "UNKNOWN"): string | undefined {
  if (isSafeValidationCommand(command)) return undefined;

  for (const entry of FORBIDDEN_BASH_PATTERNS) {
    if (entry.pattern.test(command)) return entry.reason;
  }

  if (phase === "TESTER" && isTestExecutionCommand(command)) {
    return "Tester may not execute tests. The tester role is limited to reading the ticket, writing test files, and documenting the test plan.";
  }

  const lower = command.toLowerCase();

  for (const protectedHint of [".env", "drizzle/", "drizzle\\", ".github/workflows", "wrangler.", "vercel.json", "netlify.toml", "fly.toml", "railway.json", "docker-compose", "terraform", "helm/"]) {
    if (lower.includes(protectedHint.toLowerCase())) {
      return `Bash command attempts to mutate a protected path (${protectedHint}).`;
    }
  }

  return undefined;
}

function isTestExecutionCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bphpunit\b|\brspec\b/i.test(command);
}
