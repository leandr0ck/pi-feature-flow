import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimeConfigStore, ensureConfigFile, getConfigPath, configExists } from "../src/config-store.js";

const TMP_BASE = "/tmp/pi-ffs-test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function withTempDir(fn: (cwd: string) => Promise<void>): Promise<void> {
  const unique = `${TMP_BASE}-${Date.now()}`;
  await mkdir(unique, { recursive: true });
  try {
    await fn(unique);
  } finally {
    await rm(unique, { recursive: true, force: true });
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("config-store", () => {
  describe("getConfig — defaults", () => {
    it("returns defaults when no user config exists", async () => {
      await withTempDir(async (cwd) => {
        const store = createRuntimeConfigStore(cwd);
        const cfg = store.getConfig();
        expect(cfg.specsRoot).toBe("./docs");
        expect(cfg.tdd).toBe(false);
        expect(cfg.execution!.autoStartFirstTicketAfterPlanning).toBe(true);
        expect(cfg.agents!.planner).toEqual({});
      });
    });

    it("deep-merges user config on top of defaults", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi", "feature-flow.json"),
          JSON.stringify({ tdd: true, agents: { worker: { model: "cheap" } } }),
        );
        const store = createRuntimeConfigStore(cwd);
        const cfg = store.getConfig();
        expect(cfg.tdd).toBe(true);
        expect(cfg.agents!.worker).toEqual({ model: "cheap" });
        expect(cfg.specsRoot).toBe("./docs");
        expect(cfg.agents!.planner).toEqual({});
      });
    });
  });

  describe("getGateState — diagnostics", () => {
    it("blocked is false when no user config", async () => {
      await withTempDir(async (cwd) => {
        const store = createRuntimeConfigStore(cwd);
        expect(store.getGateState().blocked).toBe(false);
      });
    });

    it("blocked is true when a config error is present", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi", "feature-flow.json"),
          JSON.stringify({ tdd: "nope" }),
        );
        const store = createRuntimeConfigStore(cwd);
        expect(store.getGateState().blocked).toBe(true);
        expect(store.getGateState().diagnostics.some((d) => d.code === "invalid_tdd")).toBe(true);
      });
    });

    it("blocked is false when only warnings are present", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi", "feature-flow.json"),
          JSON.stringify({ unknownKey: "ignored" }),
        );
        const store = createRuntimeConfigStore(cwd);
        expect(store.getGateState().blocked).toBe(false);
        expect(store.getGateState().diagnostics.length).toBeGreaterThan(0);
      });
    });
  });

  describe("reloadConfig", () => {
    it("picks up changes to user config after reload", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        const configPath = path.join(cwd, ".pi", "feature-flow.json");
        await writeFile(configPath, JSON.stringify({ tdd: false }));

        const store = createRuntimeConfigStore(cwd);
        expect(store.getConfig().tdd).toBe(false);

        await writeFile(configPath, JSON.stringify({ tdd: true }));
        store.reloadConfig();
        expect(store.getConfig().tdd).toBe(true);

        await writeFile(configPath, JSON.stringify({ tdd: false }));
        store.reloadConfig();
        expect(store.getConfig().tdd).toBe(false);
      });
    });

    it("removed user config after reload returns to defaults", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        const configPath = path.join(cwd, ".pi", "feature-flow.json");
        await writeFile(configPath, JSON.stringify({ tdd: true }));

        const store = createRuntimeConfigStore(cwd);
        expect(store.getConfig().tdd).toBe(true);

        await rm(configPath);
        store.reloadConfig();
        expect(store.getConfig().tdd).toBe(false);
      });
    });
  });

  describe("interface", () => {
    it("exposes getConfig, getGateState, reloadConfig functions", async () => {
      await withTempDir(async (cwd) => {
        const store = createRuntimeConfigStore(cwd);
        expect(typeof store.getConfig).toBe("function");
        expect(typeof store.getGateState).toBe("function");
        expect(typeof store.reloadConfig).toBe("function");
      });
    });
  });

  describe("ensureConfigFile", () => {
    it("creates config file with defaults when it doesn't exist", async () => {
      await withTempDir(async (cwd) => {
        expect(configExists(cwd)).toBe(false);

        const createdPath = ensureConfigFile(cwd);

        expect(createdPath).toBe(getConfigPath(cwd));
        expect(existsSync(createdPath)).toBe(true);
        expect(configExists(cwd)).toBe(true);

        const content = await readFile(createdPath, "utf8");
        const parsed = JSON.parse(content);
        expect(parsed.specsRoot).toBe("./docs");
        expect(parsed.tdd).toBe(false);
        expect(parsed.execution).toEqual({
          autoStartFirstTicketAfterPlanning: true,
          autoAdvanceToNextTicket: true,
          allowExternalToolCalls: false,
        });
      });
    });

    it("does not overwrite existing config file", async () => {
      await withTempDir(async (cwd) => {
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        const configPath = path.join(cwd, ".pi", "feature-flow.json");
        const customConfig = { specsRoot: "./custom-docs", tdd: true };
        await writeFile(configPath, JSON.stringify(customConfig));

        const createdPath = ensureConfigFile(cwd);

        expect(createdPath).toBe(configPath);
        const content = await readFile(configPath, "utf8");
        const parsed = JSON.parse(content);
        expect(parsed.specsRoot).toBe("./custom-docs");
        expect(parsed.tdd).toBe(true);
      });
    });

    it("creates .pi directory if it doesn't exist", async () => {
      await withTempDir(async (cwd) => {
        expect(existsSync(path.join(cwd, ".pi"))).toBe(false);
        expect(existsSync(path.join(cwd, ".pi", "feature-flow.json"))).toBe(false);

        ensureConfigFile(cwd);

        expect(existsSync(path.join(cwd, ".pi"))).toBe(true);
        expect(existsSync(path.join(cwd, ".pi", "feature-flow.json"))).toBe(true);
      });
    });
  });

  describe("getConfigPath", () => {
    it("returns the correct path to the config file", async () => {
      await withTempDir(async (cwd) => {
        const configPath = getConfigPath(cwd);
        expect(configPath).toBe(path.resolve(cwd, ".pi", "feature-flow.json"));
      });
    });
  });

  describe("configExists", () => {
    it("returns false when config doesn't exist", async () => {
      await withTempDir(async (cwd) => {
        expect(configExists(cwd)).toBe(false);
      });
    });

    it("returns true when config exists", async () => {
      await withTempDir(async (cwd) => {
        ensureConfigFile(cwd);
        expect(configExists(cwd)).toBe(true);
      });
    });
  });
});
