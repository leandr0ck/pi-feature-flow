import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

async function makeTempProject() {
  return mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-config-"));
}

describe("feature-ticket-flow config", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("loads JSON config with agent preferences", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "feature-flow.json"),
      JSON.stringify({
        specsRoot: "./specs",
        tdd: false,
        agents: {
          planner: { model: "openai/gpt-5.4" },
          reviewer: { model: "anthropic/claude-sonnet-4" },
        },
      }),
      "utf8",
    );

    const config = await loadConfig(cwd);
    expect(config.specsRoot).toBe("./specs");
    expect(config.agents?.planner?.model).toBe("openai/gpt-5.4");
    expect(config.agents?.reviewer?.model).toBe("anthropic/claude-sonnet-4");
  });

  it("falls back to defaults when no config file exists", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);

    const config = await loadConfig(cwd);
    expect(config.specsRoot).toBe("./docs");
    expect(config.tdd).toBe(false);
  });

  it("agent skills array is preserved", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "feature-flow.json"),
      JSON.stringify({
        agents: {
          tester: { agent: "claude", skills: ["tdd"] },
          reviewer: { agent: "claude", skills: ["code-reviewer"] },
          chief: { agent: "claude", skills: [] },
        },
      }),
      "utf8",
    );

    const config = await loadConfig(cwd);
    expect(config.agents?.tester?.skills).toEqual(["tdd"]);
    expect(config.agents?.reviewer?.skills).toEqual(["code-reviewer"]);
    expect(config.agents?.chief?.skills).toEqual([]);
  });
});
