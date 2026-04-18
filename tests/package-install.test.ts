import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySandboxInstall } from "@marcfargas/pi-test-harness";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_DIR = path.resolve(__dirname, "..");

describe("package install verification", () => {
  it("packs, installs, and loads the pi package successfully", async () => {
    const result = await verifySandboxInstall({
      packageDir: PACKAGE_DIR,
      expect: {
        extensions: 1,
      },
    });

    expect(result.loaded.extensionErrors).toEqual([]);
    expect(result.loaded.extensions).toBe(1);
    expect(result.loaded.skills).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
