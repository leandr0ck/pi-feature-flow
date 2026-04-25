import { execFile } from "node:child_process";

export interface RepoCleanResult {
  clean: boolean;
  dirtyFiles: string[];
}

/**
 * Check whether the git working tree is clean (ignoring gitignored paths).
 * Resolves with `{ clean: true }` if `git status --porcelain` is empty.
 */
export function checkRepoClean(cwd: string): Promise<RepoCleanResult> {
  return new Promise((resolve, reject) => {
    execFile("git", ["status", "--porcelain"], { cwd, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`git status failed: ${err.message}`));
        return;
      }
      const lines = stdout.trim();
      if (!lines) {
        resolve({ clean: true, dirtyFiles: [] });
        return;
      }
      const dirtyFiles = lines
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.replace(/^\S+\s+/, ""));
      resolve({ clean: false, dirtyFiles });
    });
  });
}

export interface CommitResult {
  ok: boolean;
  commitHash?: string;
  error?: string;
}

/**
 * Stage all changes and commit with a deterministic message.
 * Returns the short commit hash on success.
 */
export function commitSnapshot(
  cwd: string,
  message: string,
): Promise<CommitResult> {
  return new Promise((resolve) => {
    // 1. git add -A
    execFile("git", ["add", "-A"], { cwd, timeout: 30_000 }, (addErr) => {
      if (addErr) {
        resolve({ ok: false, error: `git add -A failed: ${addErr.message}` });
        return;
      }

      // 2. check if anything was staged (empty commit guard)
      execFile("git", ["diff", "--cached", "--quiet"], { cwd, timeout: 10_000 }, (diffErr) => {
        // diff --cached --quiet exits 0 = no staged changes → nothing to commit
        if (diffErr === null) {
          resolve({ ok: false, error: "nothing to commit" });
          return;
        }

        // 3. commit
        execFile(
          "git",
          ["commit", "-m", message],
          { cwd, timeout: 30_000 },
          (commitErr, commitStdout) => {
            if (commitErr) {
              resolve({
                ok: false,
                error: `git commit failed: ${commitErr.message}`,
              });
              return;
            }

            // 4. extract short hash
            execFile(
              "git",
              ["rev-parse", "--short", "HEAD"],
              { cwd, timeout: 10_000 },
              (hashErr, hashOut) => {
                if (hashErr) {
                  resolve({
                    ok: true,
                    commitHash: "unknown",
                  });
                  return;
                }
                resolve({ ok: true, commitHash: hashOut.trim() });
              },
            );
          },
        );
      });
    });
  });
}

/** Build a deterministic commit message for a finished ticket. */
export function buildCommitMessage(feature: string, ticketId: string, title?: string): string {
  const prefix = title ? `: ${title}` : "";
  return `feature(${feature}): ${ticketId}${prefix}`;
}
