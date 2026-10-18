// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const PLAYWRIGHT_IMAGE = /mcr\.microsoft\.com\/playwright:v([^\s"'-]+)-[a-z]+/g;

interface PackageJson {
  devDependencies?: Record<string, string>;
}

function pinnedPlaywrightVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as PackageJson;
  const version = pkg.devDependencies?.["@playwright/test"];
  if (!version) {
    throw new Error("@playwright/test is missing from devDependencies");
  }
  return version;
}

function ciPlaywrightImageVersions(): string[] {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  return [...workflow.matchAll(PLAYWRIGHT_IMAGE)].map((match) => match[1]);
}

describe("ci config", () => {
  it("pins @playwright/test to an exact version", () => {
    expect(pinnedPlaywrightVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("runs e2e in the playwright container that matches the pinned @playwright/test version", () => {
    const versions = ciPlaywrightImageVersions();

    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([pinnedPlaywrightVersion()]));
  });

  it("installs the pinned @playwright/test version", () => {
    const require = createRequire(join(REPO_ROOT, "package.json"));
    const installed = (require("@playwright/test/package.json") as { version: string }).version;

    expect(installed).toBe(pinnedPlaywrightVersion());
  });
});
