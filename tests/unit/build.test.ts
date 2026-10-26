// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { build, parseAst } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OFFSCREEN_PAGE_JOB } from "../../src/shared/messages";

const REPO_ROOT = process.cwd();
const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OFFSCREEN_BUNDLE = "offscreen/offscreen.js";
const EXTENSION_ID = "across-amazon-test";

type MessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean;

interface Manifest {
  icons: Record<string, string>;
  action: { default_icon: Record<string, string> };
}

const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "manifest.json"), "utf8")) as Manifest;

const MANIFEST_ICONS = [
  ...Object.entries(MANIFEST.icons).map(([size, file]) => ({ key: "icons", size: Number(size), file })),
  ...Object.entries(MANIFEST.action.default_icon).map(([size, file]) => ({
    key: "action.default_icon",
    size: Number(size),
    file
  }))
];

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
  },
  {
    file: "content/location-setter.js",
    fixture: "location/nav-switzerland.html",
    url: "https://www.amazon.de/dp/B09LCMVB3F",
    requestKey: "__ACROSS_AMAZON_LOCATION_REQUEST__",
    request: { marketplace: "DE", countryCode: "CH" },
    resultKey: "__ACROSS_AMAZON_LOCATION_RESULT__",
    expected: { status: "ALREADY_SET", countryCode: "CH" }
  }
];

let buildRoot: string | undefined;

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "across-amazon-build-"));
  await build({
    root: REPO_ROOT,
    configFile: join(REPO_ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: join(buildRoot, "dist"), emptyOutDir: true, write: true }
  });
  // No build overrides here: with dist inside the root, Vite would empty it unless the config says not to.
  await build({ root: buildRoot, configFile: join(REPO_ROOT, "vite.offscreen.config.ts"), logLevel: "silent" });
}, 40_000);

afterAll(async () => {
  if (buildRoot) {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

function builtPath(file: string): string {
  if (!buildRoot) {
    throw new Error("The build did not produce an output directory");
  }
  return join(buildRoot, "dist", file);
}

async function readBuiltFile(file: string): Promise<string> {
  return readFile(builtPath(file), "utf8");
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
        expect(structuredClone(await scope[resultKey]), `injection ${injection}`).toMatchObject(expected as object);
        delete scope[resultKey];
      }
    }
  );
});

describe("production build of the offscreen document", () => {
  it("keeps the main build's files when it writes into the same dist", () => {
    const mainBuild = [
      "popup.html",
      "options.html",
      "offscreen.html",
      "background/service-worker.js",
      ...CONTENT_SCRIPTS.map(({ file }) => file)
    ];

    expect(mainBuild.filter((file) => !existsSync(builtPath(file)))).toEqual([]);
    expect(existsSync(builtPath(OFFSCREEN_BUNDLE))).toBe(true);
  });

  it("ships offscreen.html loading only the offscreen bundle, as a module", async () => {
    const page = new JSDOM(await readBuiltFile("offscreen.html")).window.document;
    const scripts = Array.from(page.querySelectorAll("script"), (script) => ({
      type: script.getAttribute("type"),
      src: script.getAttribute("src")
    }));

    expect(scripts).toEqual([{ type: "module", src: OFFSCREEN_BUNDLE }]);
  });

  it("bundles the offscreen document with no module syntax", async () => {
    const code = await readBuiltFile(OFFSCREEN_BUNDLE);
    const program = parseAst(code);

    expect(program.body.filter((node) => /^(Import|Export)/.test(node.type))).toEqual([]);
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\.meta\b/);
  });

  it("answers a product job with nothing but the bundle", async () => {
    const url = "https://www.amazon.de/dp/B000000005";
    const html = new TextEncoder().encode(readFileSync(join(FIXTURE_ROOT, "product/DE.html"), "utf8"));
    const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { runScripts: "outside-only" });
    const scope = dom.window as unknown as Record<string, unknown>;
    const listeners: MessageListener[] = [];
    scope.chrome = {
      runtime: { id: EXTENSION_ID, onMessage: { addListener: (listener: MessageListener) => listeners.push(listener) } }
    };
    scope.TextDecoder = TextDecoder;
    scope.fetch = async (input: string) => ({
      ok: true,
      status: 200,
      url: input,
      headers: new Headers({ "content-type": "text/html;charset=UTF-8" }),
      arrayBuffer: async () => html.slice().buffer
    });

    new Script(await readBuiltFile(OFFSCREEN_BUNDLE), { filename: OFFSCREEN_BUNDLE }).runInContext(dom.getInternalVMContext());
    const page = { kind: "product", request: { marketplace: "DE", sourceDestinationCountryCode: "US" } };
    const message = { target: "offscreen", type: OFFSCREEN_PAGE_JOB, payload: { runKey: "run-1", url, page } };
    const answer = await new Promise<unknown>((resolve) => {
      expect(listeners).toHaveLength(1);
      expect(listeners[0](message, { id: EXTENSION_ID }, resolve)).toBe(true);
    });

    expect(JSON.parse(JSON.stringify(answer))).toMatchObject({
      outcome: "read",
      finalUrl: url,
      product: { canonicalUrl: url, breakdown: { item: { amount: 37.2, currency: "EUR" } } }
    });
  });
});

describe("production build of the manifest icons", () => {
  it("declares the toolbar and store icon sizes", () => {
    expect(Object.keys(MANIFEST.icons)).toEqual(["16", "32", "48", "128"]);
    expect(Object.keys(MANIFEST.action.default_icon)).toEqual(["16", "32", "48"]);
  });

  it.each(MANIFEST_ICONS)("$key $size is a $size x $size PNG at $file", async ({ size, file }) => {
    const png = await readFile(builtPath(file));

    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.toString("latin1", 12, 16)).toBe("IHDR");
    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: size, height: size });
  });

  it("ships the 48 px icon the popup header references from the extension root", async () => {
    expect(await readBuiltFile("popup.js")).toContain('"/icons/icon-48.png"');
    const png = await readFile(builtPath("icons/icon-48.png"));

    expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({ width: 48, height: 48 });
  });
});
