import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveFeatureSlug, ensureUniqueFeatureSlug, scaffoldSpecFile, pathExists } from "../src/feature-flow/scaffold.js";

async function makeTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "pi-feature-flow-scaffold-"));
}

// ─── deriveFeatureSlug ────────────────────────────────────────────────────────

describe("deriveFeatureSlug", () => {
  it("converts a plain description to a slug", () => {
    expect(deriveFeatureSlug("user login page")).toBe("login-page");
  });

  it("strips English stop words", () => {
    expect(deriveFeatureSlug("build a new onboarding flow for users")).toBe("new-onboarding");
  });

  it("strips Spanish stop words", () => {
    expect(deriveFeatureSlug("quiero crear una pantalla de login")).toBe("pantalla-de-login");
  });

  it("strips special characters and accents via NFKD normalization", () => {
    // NFKD decomposes accented chars into base + combining diacritic;
    // combining diacritics are removed, leaving only ASCII base chars.
    // "añadir" → "an" (stop word) + "adir"; "página" → "pa" + "gina"; "de" stays; "configuración" → "configuracio" + "n"
    expect(deriveFeatureSlug("añadir página de configuración")).toBe("adir-pa-gina-de-configuracio-n");
  });

  it("limits slug to 6 meaningful tokens", () => {
    const slug = deriveFeatureSlug("checkout payment billing address invoice receipt confirmation success page");
    expect(slug.split("-").length).toBeLessThanOrEqual(6);
  });

  it("lowercases the result", () => {
    expect(deriveFeatureSlug("User Profile Settings")).toBe("profile-settings");
  });

  it("removes consecutive hyphens", () => {
    const slug = deriveFeatureSlug("hello -- world");
    expect(slug).not.toContain("--");
  });

  it("does not start or end with a hyphen", () => {
    const slug = deriveFeatureSlug("  login page  ");
    expect(slug).not.toMatch(/^-|-$/);
  });

  it("returns a non-empty string for an empty-ish description", () => {
    const slug = deriveFeatureSlug("a an the");
    expect(slug.length).toBeGreaterThan(0);
  });
});

// ─── ensureUniqueFeatureSlug ──────────────────────────────────────────────────

describe("ensureUniqueFeatureSlug", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("returns the base slug when no conflict exists", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);

    expect(await ensureUniqueFeatureSlug(specsRoot, "login-page")).toBe("login-page");
  });

  it("appends -2 when the base slug already exists", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    await mkdir(path.join(specsRoot, "login-page"), { recursive: true });

    expect(await ensureUniqueFeatureSlug(specsRoot, "login-page")).toBe("login-page-2");
  });

  it("increments until a unique slug is found", async () => {
    const specsRoot = await makeTempDir();
    dirs.push(specsRoot);
    await mkdir(path.join(specsRoot, "login-page"), { recursive: true });
    await mkdir(path.join(specsRoot, "login-page-2"), { recursive: true });

    expect(await ensureUniqueFeatureSlug(specsRoot, "login-page")).toBe("login-page-3");
  });
});

// ─── scaffoldSpecFile ─────────────────────────────────────────────────────────

describe("scaffoldSpecFile", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("creates a stub spec file and returns true", async () => {
    const featureDir = await makeTempDir();
    dirs.push(featureDir);

    const created = await scaffoldSpecFile(featureDir, "my-feature");

    expect(created).toBe(true);
    expect(await pathExists(path.join(featureDir, "01-master-spec.md"))).toBe(true);
  });

  it("the stub spec contains the feature name and required placeholders", async () => {
    const featureDir = await makeTempDir();
    dirs.push(featureDir);
    await scaffoldSpecFile(featureDir, "onboarding-flow");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(featureDir, "01-master-spec.md"), "utf8");

    expect(content).toContain("onboarding-flow");
    expect(content).toContain("## Goal");
    expect(content).toContain("## Acceptance Criteria");
    expect(content).toContain("/feature-plan");
  });

  it("returns false and does not overwrite an existing spec file", async () => {
    const featureDir = await makeTempDir();
    dirs.push(featureDir);
    const { writeFile, readFile } = await import("node:fs/promises");
    await writeFile(path.join(featureDir, "01-master-spec.md"), "# existing content", "utf8");

    const created = await scaffoldSpecFile(featureDir, "my-feature");
    const content = await readFile(path.join(featureDir, "01-master-spec.md"), "utf8");

    expect(created).toBe(false);
    expect(content).toBe("# existing content");
  });
});
