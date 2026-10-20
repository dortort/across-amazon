import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MANIFEST = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { permissions: string[] };

describe("manifest permissions", () => {
  it("asks only for scripting and storage", () => {
    expect(MANIFEST.permissions).toEqual(["scripting", "storage"]);
  });
});
