// @vitest-environment node
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { build, parseAst } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures");

interface ContentScriptCase {
  file: string;
  fixture: string;
  url: string;
  requestKey?: string;
  request?: unknown;
  resultKey: string;
  expected: unknown;
}

const CONTENT_SCRIPTS: ContentScriptCase[] = [
  {
    file: "content/source-extractor.js",
    fixture: "source/US.html",
    url: "https://www.amazon.com/dp/B000000001",
    resultKey: "__ACROSS_AMAZON_SOURCE_CONTEXT__",
    expected: { source: { marketplace: "US", asin: "B000000001", sourceUrl: "https://www.amazon.com/dp/B000000001" } }
  },
  {
    file: "content/search-extractor.js",
    fixture: "search/DE.html",
    url: "https://www.amazon.de/s?k=Acme+Ultra+Widget",
    requestKey: "__ACROSS_AMAZON_SEARCH_REQUEST__",
    request: { marketplace: "DE", limit: 8 },
    resultKey: "__ACROSS_AMAZON_SEARCH_CANDIDATES__",
    expected: expect.arrayContaining([
      expect.objectContaining({ marketplace: "DE", asin: "B000000005", url: "https://www.amazon.de/dp/B000000005" })
    ])
  },
  {
    file: "content/product-extractor.js",
    fixture: "product/DE.html",
    url: "https://www.amazon.de/dp/B000000005",
    requestKey: "__ACROSS_AMAZON_PRODUCT_REQUEST__",
    request: { marketplace: "DE", sourceDestinationCountryCode: "US" },
    resultKey: "__ACROSS_AMAZON_PRODUCT_RESULT__",
    expected: {
      marketplace: "DE",
      canonicalUrl: "https://www.amazon.de/dp/B000000005",
      breakdown: { item: { amount: 37.2, currency: "EUR" }, importFees: { amount: 3.2, currency: "EUR" } }
    }
  }
];

let outDir: string | undefined;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "across-amazon-build-"));
  await build({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true, write: true }
  });
}, 20_000);

afterAll(async () => {
  if (outDir) {
    await rm(outDir, { recursive: true, force: true });
  }
});

async function readBuiltFile(file: string): Promise<string> {
  if (!outDir) {
    throw new Error("The build did not produce an output directory");
  }
  return readFile(join(outDir, file), "utf8");
}

describe("production build of the content scripts", () => {
  it.each(CONTENT_SCRIPTS)("$file is a single arrow IIFE with no module syntax", async ({ file }) => {
    const code = await readBuiltFile(file);
    const program = parseAst(code);

    expect(code.startsWith("(() => {\n")).toBe(true);
    expect(program.body).toHaveLength(1);
    expect(program.body[0]).toMatchObject({
      type: "ExpressionStatement",
      expression: {
        type: "CallExpression",
        arguments: [],
        callee: { type: "ArrowFunctionExpression", params: [] }
      }
    });
    expect(program.body.filter((node) => /^(Import|Export)/.test(node.type))).toEqual([]);
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\.meta\b/);
    expect(code.trimEnd().endsWith(`//# sourceMappingURL=${file.slice("content/".length)}.map`)).toBe(true);
  });

  it.each(CONTENT_SCRIPTS)(
    "$file runs again when injected a second time into the same isolated world",
    async ({ file, fixture, url, requestKey, request, resultKey, expected }) => {
      const script = new Script(await readBuiltFile(file), { filename: file });
      const dom = new JSDOM(readFileSync(join(FIXTURE_ROOT, fixture), "utf8"), { url, runScripts: "outside-only" });
      const isolatedWorld = dom.getInternalVMContext();
      const scope = dom.window as unknown as Record<string, unknown>;

      for (const injection of [1, 2]) {
        if (requestKey) {
          scope[requestKey] = request;
        }

        expect(() => script.runInContext(isolatedWorld), `injection ${injection}`).not.toThrow();
        expect(structuredClone(scope[resultKey]), `injection ${injection}`).toMatchObject(expected as object);
        delete scope[resultKey];
      }
    }
  );
});
