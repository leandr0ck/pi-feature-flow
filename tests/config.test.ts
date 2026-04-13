import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveExecutionProfile, resolveExecutionProfileByName } from "../src/config.js";

async function makeTempProject() {
  return mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-config-"));
}

describe("feature-ticket-flow config", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("loads YAML config with model preferences", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "feature-ticket-flow.yaml"),
      [
        "specsRoot: ./specs",
        "defaultProfile: default",
        "profiles:",
        "  default:",
        "    preferSubagents: true",
        "    agents:",
        "      planner:",
        "        model: openai/gpt-5.4",
        "      reviewer:",
        "        model: anthropic/claude-sonnet-4",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(cwd);
    expect(config.specsRoot).toBe("./specs");
    expect(config.profiles?.default?.agents?.planner?.model).toBe("openai/gpt-5.4");
    expect(config.profiles?.default?.agents?.reviewer?.model).toBe("anthropic/claude-sonnet-4");
  });

  it("selects a matching profile by feature text", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "feature-ticket-flow.yaml"),
      [
        "profiles:",
        "  default:",
        "    agents:",
        "      reviewer:",
        "        model: anthropic/claude-sonnet-4",
        "  frontend:",
        "    matchAny: [dashboard, ui, page]",
        "    agents:",
        "      reviewer:",
        "        model: openai/gpt-5.4",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(cwd);
    const selected = resolveExecutionProfile(config, "build a dashboard page for onboarding");

    expect(selected.name).toBe("frontend");
    expect(selected.profile.agents?.reviewer?.model).toBe("openai/gpt-5.4");
  });

  it("resolves a persisted profile name with default inheritance", async () => {
    const cwd = await makeTempProject();
    dirs.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "feature-ticket-flow.yaml"),
      [
        "profiles:",
        "  default:",
        "    agents:",
        "      planner:",
        "        model: anthropic/claude-sonnet-4",
        "      reviewer:",
        "        model: openai/gpt-5.4",
        "  backend:",
        "    agents:",
        "      worker:",
        "        model: anthropic/claude-sonnet-4",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(cwd);
    const selected = resolveExecutionProfileByName(config, "backend");

    expect(selected.name).toBe("backend");
    expect(selected.profile.agents?.planner?.model).toBe("anthropic/claude-sonnet-4");
    expect(selected.profile.agents?.worker?.model).toBe("anthropic/claude-sonnet-4");
    expect(selected.profile.agents?.reviewer?.model).toBe("openai/gpt-5.4");
  });
});
