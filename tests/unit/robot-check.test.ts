import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ROBOT_CHECK_MARKERS, inspectPage, isRobotCheck, robotCheckNote } from "../../src/shared/robot-check";
import type { PageInspection, RobotCheckMarkers } from "../../src/shared/robot-check";

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures");
const ORDINARY_FOLDERS = [
  "product",
  "product-live",
  "search",
  "search-live",
  "source",
  "offers-live",
  "location",
  "not-found-live"
];
const CAPTURED_URL = "https://www.amazon.co.uk/dp/B09XS7JWHH";
const CHECKPOINT_URL = "https://www.amazon.com/checkpoint/continue?token=TEST-TOKEN";
const PRODUCT_URL = "https://www.amazon.com/dp/B000000001";
const AUTOMATED_ACCESS_CONTACT = "api-services-support@amazon.com";
const OLDER_FORM =
  '<form method="get" action="/errors/validateCaptcha"><button type="submit">Continue shopping</button></form>';
const ROBOT_CHECK_PATHS = [
  CHECKPOINT_URL,
  "https://www.amazon.de/errors/validateCaptcha?amzn=",
  "https://www.amazon.es/errors_page/validateCaptcha"
];

const robotCheckHtml = readFileSync(join(FIXTURE_ROOT, "robot-check.html"), "utf8");

const ordinaryPages = ORDINARY_FOLDERS.flatMap((folder) =>
  readdirSync(join(FIXTURE_ROOT, folder))
    .sort()
    .map((file) => ({
      name: `${folder}/${file}`,
      url: folder.startsWith("search") ? "https://www.amazon.com/s?k=widget" : PRODUCT_URL,
      html: readFileSync(join(FIXTURE_ROOT, folder, file), "utf8")
    }))
);

const notFoundPages = ordinaryPages
  .filter((entry) => entry.name === "product/not-found.html" || entry.name.startsWith("not-found-live/"))
  .map((entry) => ({ ...entry, url: /<meta name="source-url" content="([^"]+)">/.exec(entry.html)?.[1] ?? entry.url }));

function page(body: string): string {
  return `<!doctype html><html><head><title>Amazon.com</title></head><body>${body}</body></html>`;
}

function inspectInPage(html: string, url: string, markers: RobotCheckMarkers = ROBOT_CHECK_MARKERS): PageInspection {
  const { window } = new JSDOM(html, { url });
  const injected = new Function("document", "location", "markers", `return (${inspectPage.toString()})(markers);`) as (
    document: Document,
    location: Location,
    markers: RobotCheckMarkers
  ) => PageInspection;
  return injected(window.document, window.location, structuredClone(markers));
}

describe("robot check", () => {
  it("covers every ordinary fixture folder", () => {
    expect(ordinaryPages.length).toBeGreaterThan(60);
    expect(notFoundPages.map((entry) => entry.name)).toEqual([
      "product/not-found.html",
      "not-found-live/DE.html",
      "not-found-live/JP.html",
      "not-found-live/MX.html",
      "not-found-live/UK.html"
    ]);
    expect(new Set(ordinaryPages.map((entry) => entry.name.split("/")[0]))).toEqual(new Set(ORDINARY_FOLDERS));
  });

  describe.each([
    ["in the page", (html: string, url: string) => inspectInPage(html, url).robotCheck],
    ["from the HTML", (html: string, url: string) => isRobotCheck(url, html)]
  ])("%s", (_how, check) => {
    it("recognises the robot check amazon.co.uk served at a product page's address", () => {
      expect(check(robotCheckHtml, CAPTURED_URL)).toBe(true);
    });

    it("recognises the older validateCaptcha form", () => {
      expect(check(page(OLDER_FORM), PRODUCT_URL)).toBe(true);
    });

    it.each(ROBOT_CHECK_PATHS)("recognises %s by its path", (url) => {
      expect(check(page("<p>Checking your browser</p>"), url)).toBe(true);
    });

    it("does not read a search for the word checkpoint as a robot check", () => {
      expect(check(page("<p>No results</p>"), "https://www.amazon.com/s?k=checkpoint")).toBe(false);
    });

    it.each(notFoundPages.map((entry) => [entry.name, entry]))(
      "does not read Amazon's automated access notice on the not-found page %s as a robot check",
      (_name, entry) => {
        expect(entry.html).toContain(AUTOMATED_ACCESS_CONTACT);
        expect(check(entry.html, entry.url)).toBe(false);
      }
    );

    it("does not read the captured page's automated access notice without its form as a robot check", () => {
      const withoutForm = new JSDOM(robotCheckHtml);
      withoutForm.window.document.querySelector("form")?.remove();
      expect(withoutForm.serialize()).toContain(AUTOMATED_ACCESS_CONTACT);
      expect(check(withoutForm.serialize(), CAPTURED_URL)).toBe(false);
    });

    it.each(ordinaryPages.map((entry) => [entry.name, entry]))("does not flag %s", (_name, entry) => {
      expect(check(entry.html, entry.url)).toBe(false);
    });
  });

  it("reports the address of the page it inspected", () => {
    expect(inspectInPage(robotCheckHtml, CAPTURED_URL)).toEqual({ url: CAPTURED_URL, robotCheck: true });
    expect(inspectInPage(page("<span id='productTitle'>Widget</span>"), PRODUCT_URL)).toEqual({
      url: PRODUCT_URL,
      robotCheck: false
    });
  });

  it("names the store in its note", () => {
    expect(robotCheckNote("amazon.co.uk")).toBe("Amazon showed a robot check on amazon.co.uk");
  });
});
