import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractProductDataWithOffers } from "../../src/content/product-extractor";
import { extractSearchCandidates } from "../../src/content/search-extractor";
import { handleOffscreenMessage } from "../../src/offscreen/page-reader";
import {
  OFFSCREEN_CANCEL_RUN,
  OFFSCREEN_PAGE_JOB,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS
} from "../../src/shared/messages";
import type {
  LocationRequest,
  PageJob,
  PageJobResult,
  ProductExtractionRequest,
  SearchExtractionRequest
} from "../../src/shared/types";
import {
  ADDRESS_CHANGE_PATH,
  LOCATION_FORM_PATH,
  OFFERS_PATH,
  PAGE_TOKEN,
  POST_TOKEN,
  applyLocation,
  offerOnlyOtherSellers,
  offersUrl,
  removeElement
} from "./amazon-pages";

const FIXTURE_ROOT = join(process.cwd(), "tests", "fixtures");
const EXTENSION_ID = "across-amazon-test";
const WORKER: chrome.runtime.MessageSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/background/service-worker.js`
};
const ORIGIN = "https://www.amazon.de";
const PRODUCT_URL = `${ORIGIN}/dp/B000000005`;
const SEARCH_URL = `${ORIGIN}/s?k=Acme+Ultra+Widget`;
const PRODUCT_REQUEST: ProductExtractionRequest = {
  marketplace: "DE",
  sourceDestinationCountryCode: "CH",
  readOtherOffers: true
};
const SEARCH_REQUEST: SearchExtractionRequest = { marketplace: "DE", limit: 8 };
const PRODUCT_PAGE = { kind: "product", request: PRODUCT_REQUEST } as const;
const SHOWN_US_PRODUCT_PAGE = { kind: "product", request: { ...PRODUCT_REQUEST, sourceDestinationCountryCode: "US" } } as const;
const SEARCH_PAGE = { kind: "search", request: SEARCH_REQUEST } as const;
const TO_SWITZERLAND: LocationRequest = { marketplace: "DE", countryCode: "CH" };
const SHAPELESS_HTML =
  "<!doctype html><html><head><title>Amazon.co.uk</title></head><body><div><p>Something went wrong</p></div></body></html>";
const SHIFT_JIS_TITLE = [0x90, 0x56, 0x95, 0x69];
const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "text/html,*/*" };
const HELD = new Promise<never>(() => undefined);

interface Answer {
  ok: boolean;
  status: number;
  url?: string;
  headers?: Headers;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  text?: () => Promise<string>;
}

interface HtmlOptions {
  status?: number;
  url?: string;
  contentType?: string | null;
}

type Served = Answer | Promise<Answer>;

interface StoreOptions {
  page: Served;
  form?: Served;
  change?: Served;
  offers?: Served[];
}

type Router = (url: URL, init: RequestInit) => Served;

let runCount = 0;

function fixture(file: string): string {
  return readFileSync(join(FIXTURE_ROOT, file), "utf8");
}

function offersPanel(file = "DE-four-new-offers.html"): string {
  return new JSDOM(fixture(join("offers-live", file))).window.document.body.innerHTML;
}

function productHtml(prepare?: (document: Document) => void): string {
  const dom = new JSDOM(fixture("product/DE.html"), { url: PRODUCT_URL });
  prepare?.(dom.window.document);
  return dom.serialize();
}

function onlyOtherSellers(destination: string): string {
  return productHtml((document) => {
    applyLocation(document, destination);
    offerOnlyOtherSellers(document);
  });
}

function htmlAnswer(
  body: string | Uint8Array,
  { status = 200, url, contentType = "text/html;charset=UTF-8" }: HtmlOptions = {}
): Answer {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(contentType === null ? undefined : { "content-type": contentType }),
    arrayBuffer: async () => bytes.slice().buffer
  };
}

function textAnswer(body: string, status = 200): Answer {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function later(answer: Answer, delayMs: number): Promise<Answer> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(answer), delayMs);
  });
}

function serve(router: Router) {
  const fetchMock = vi.fn(
    (input: string, init: RequestInit = {}) =>
      new Promise<Answer>((resolve, reject) => {
        const abort = (): void => reject(new DOMException("This operation was aborted", "AbortError"));
        if (init.signal?.aborted) {
          abort();
          return;
        }
        init.signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => router(new URL(input), init))
          .then((answer) => resolve({ url: input, ...answer }), reject);
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function store({ page, form, change, offers = [] }: StoreOptions): Router {
  const offerAnswers = [...offers];
  return (url) => {
    if (url.pathname === LOCATION_FORM_PATH) {
      return form ?? textAnswer(fixture("location/DE-modal.html"));
    }
    if (url.pathname === ADDRESS_CHANGE_PATH) {
      return change ?? textAnswer(fixture("location/address-change-CH.json"));
    }
    if (url.pathname === OFFERS_PATH) {
      return offerAnswers.shift() ?? textAnswer("", 404);
    }
    return page;
  };
}

function jobMessage(job: Omit<PageJob, "runKey">, runKey: string): unknown {
  return JSON.parse(JSON.stringify({ target: "offscreen", type: OFFSCREEN_PAGE_JOB, payload: { runKey, ...job } }));
}

function runJob(job: Omit<PageJob, "runKey">, runKey = `run-${(runCount += 1)}`): Promise<PageJobResult> {
  return new Promise((resolve) => {
    const handled = handleOffscreenMessage(jobMessage(job, runKey), WORKER, (answer) => {
      expect(answer).toEqual(JSON.parse(JSON.stringify(answer)));
      resolve(answer as PageJobResult);
    });
    expect(handled).toBe(true);
  });
}

function settling(job: Promise<PageJobResult>): { answer?: PageJobResult } {
  const settled: { answer?: PageJobResult } = {};
  void job.then((answer) => {
    settled.answer = answer;
  });
  return settled;
}

function cancelRun(runKey: string) {
  const sendResponse = vi.fn();
  const message = { target: "offscreen", type: OFFSCREEN_CANCEL_RUN, payload: { runKey } };
  const handled = handleOffscreenMessage(message, WORKER, sendResponse);
  return { handled, sendResponse };
}

function shiftJisPage(head: string): Uint8Array {
  const ascii = (text: string): number[] => Array.from(text, (character) => character.charCodeAt(0));
  return new Uint8Array([
    ...ascii(`<!doctype html><html><head>${head}</head><body><span id="productTitle">`),
    ...SHIFT_JIS_TITLE,
    ...ascii("</span></body></html>")
  ]);
}

function requestedPaths(fetchMock: ReturnType<typeof serve>): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
}

function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

beforeEach(() => {
  vi.stubGlobal("chrome", { runtime: { id: EXTENSION_ID } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("offscreen message handling", () => {
  it.each([
    [
      "a page job without the offscreen target",
      { type: OFFSCREEN_PAGE_JOB, payload: { runKey: "run-x", url: PRODUCT_URL, page: PRODUCT_PAGE } }
    ],
    ["a progress broadcast", { type: RUN_COMPARISON_PROGRESS, payload: { completed: 0, total: 9 } }],
    ["the popup's run request", { type: RUN_COMPARISON, payload: { activeTabId: 1, runId: "run-1" } }],
    ["an unknown offscreen type", { target: "offscreen", type: "OFFSCREEN_UNKNOWN", payload: { runKey: "run-x" } }],
    [
      "a page job of an unknown kind",
      { target: "offscreen", type: OFFSCREEN_PAGE_JOB, payload: { runKey: "run-x", url: PRODUCT_URL, page: { kind: "offers" } } }
    ]
  ])("ignores %s without answering it", (_name, message) => {
    const fetchMock = serve(() => htmlAnswer(fixture("product/DE.html")));
    const sendResponse = vi.fn();

    expect(handleOffscreenMessage(message, WORKER, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a content script in an Amazon tab", { id: EXTENSION_ID, tab: { id: 7 } as chrome.tabs.Tab, frameId: 0, url: PRODUCT_URL }],
    ["another extension", { id: "another-extension", url: "chrome-extension://another-extension/background.js" }]
  ])("ignores a page job and a cancel from %s", async (_name, sender) => {
    const fetchMock = serve(() => htmlAnswer(fixture("product/DE.html")));
    const sendResponse = vi.fn();
    const runKey = `run-${(runCount += 1)}`;
    const cancel = { target: "offscreen", type: OFFSCREEN_CANCEL_RUN, payload: { runKey } };

    expect(
      handleOffscreenMessage(jobMessage({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND }, runKey), sender, sendResponse)
    ).toBe(false);
    expect(handleOffscreenMessage(cancel, sender, sendResponse)).toBe(false);
    await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }, runKey)).resolves.toMatchObject({ outcome: "read" });
    expect(sendResponse).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("offscreen page job", () => {
  it("reads a product page into what the extractor reads from the same page in a tab", async () => {
    const html = fixture("product/DE.html");
    const fetchMock = serve(() => htmlAnswer(html));

    const answer = await runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE });
    const inTab = await extractProductDataWithOffers(
      new JSDOM(html, { url: PRODUCT_URL }).window.document,
      PRODUCT_REQUEST,
      PRODUCT_URL,
      () => Promise.reject(new Error("Unexpected request"))
    );

    expect(answer).toEqual({ outcome: "read", finalUrl: PRODUCT_URL, product: inTab });
    expect(inTab).toMatchObject({ canonicalUrl: PRODUCT_URL, breakdown: { item: { amount: 37.2, currency: "EUR" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads a search page into candidates with absolute URLs", async () => {
    const html = fixture("search/DE.html");
    serve(() => htmlAnswer(html));

    const answer = await runJob({ url: SEARCH_URL, page: SEARCH_PAGE });

    expect(answer).toEqual({
      outcome: "read",
      finalUrl: SEARCH_URL,
      candidates: extractSearchCandidates(new JSDOM(html, { url: SEARCH_URL }).window.document, SEARCH_REQUEST, ORIGIN)
    });
    expect(answer).toMatchObject({
      candidates: [
        { asin: "B000000005", url: `${ORIGIN}/dp/B000000005`, imageUrl: `${ORIGIN}/image.jpg` },
        { asin: "D000000005", url: `${ORIGIN}/dp/D000000005` }
      ]
    });
  });

  it("resolves a relative canonical link, product links and images against the page it downloaded", async () => {
    const searchHtml = fixture("search/DE.html").replace(`src="${ORIGIN}/image.jpg"`, 'src="images/I/widget.jpg"');
    const productPage = fixture("product/DE.html").replace(`href="${PRODUCT_URL}"`, 'href="/dp/B000000005"');
    serve((url) => htmlAnswer(url.pathname === "/s" ? searchHtml : productPage));

    const search = await runJob({ url: SEARCH_URL, page: SEARCH_PAGE });
    const product = await runJob({ url: `${ORIGIN}/dp/B000000001`, page: PRODUCT_PAGE });

    expect(search).toMatchObject({
      candidates: [
        { url: `${ORIGIN}/dp/B000000005`, imageUrl: `${ORIGIN}/images/I/widget.jpg` },
        { url: `${ORIGIN}/dp/D000000005` }
      ]
    });
    expect(product).toMatchObject({ outcome: "read", product: { canonicalUrl: PRODUCT_URL, asin: "B000000005" } });
  });

  it("reads the page at the address a redirect on the same store ended at", async () => {
    const finalUrl = `${PRODUCT_URL}?th=1`;
    serve(() => htmlAnswer(productHtml((document) => removeElement(document, "link[rel='canonical']")), { url: finalUrl }));

    const answer = await runJob({ url: `${ORIGIN}/dp/B000000001`, page: PRODUCT_PAGE });

    expect(answer).toMatchObject({ outcome: "read", finalUrl, product: { canonicalUrl: PRODUCT_URL } });
  });

  it("hands a page that a redirect took to another store to a tab", async () => {
    const finalUrl = "https://www.amazon.co.uk/dp/B000000005";
    serve(() => htmlAnswer(fixture("product/UK.html"), { url: finalUrl }));

    await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toEqual({
      outcome: "fallback",
      reason: "off-host",
      detail: finalUrl
    });
  });

  it.each([
    ["a store page over plain HTTP", "http://www.amazon.de/dp/B000000005"],
    ["a page off the stores", "https://www.example.com/dp/B000000005"],
    ["a host that only begins like a store's", "https://www.amazon.de.example.com/dp/B000000005"],
    ["an address that is not a URL", "/dp/B000000005"]
  ])("hands %s to a tab without downloading it", async (_name, url) => {
    const fetchMock = serve(() => htmlAnswer(fixture("product/DE.html")));

    await expect(runJob({ url, page: PRODUCT_PAGE, location: TO_SWITZERLAND })).resolves.toEqual({
      outcome: "fallback",
      reason: "off-host",
      detail: url
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("character sets", () => {
    it.each([
      ["the Content-Type charset", "", "text/html; charset=Shift_JIS"],
      ["a <meta charset>", '<meta charset="Shift_JIS">', "text/html"],
      ["an unquoted <meta charset>", "<meta charset=Shift_JIS>", "text/html"],
      ["a <meta http-equiv> content type", '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">', null]
    ])("decodes a Shift_JIS page by %s", async (_name, head, contentType) => {
      serve(() => htmlAnswer(shiftJisPage(head), { contentType }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toMatchObject({
        outcome: "read",
        product: { title: "新品" }
      });
    });

    it("ignores a <meta> charset after the first 1024 bytes and reads the page as UTF-8", async () => {
      const late = shiftJisPage(`<!--${"x".repeat(1_100)}--><meta charset="Shift_JIS">`);
      serve(() => htmlAnswer(late, { contentType: "text/html" }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toMatchObject({
        outcome: "read",
        product: { title: "\uFFFDV\uFFFDi" }
      });
    });

    it("reads a page as UTF-8 when neither the header nor the page names a charset", async () => {
      serve(() => htmlAnswer('<html><body><span id="productTitle">新品</span></body></html>', { contentType: "text/html" }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toMatchObject({
        outcome: "read",
        product: { title: "新品" }
      });
    });

    it("hands a page in a charset it cannot decode to a tab", async () => {
      serve(() => htmlAnswer(shiftJisPage(""), { contentType: "text/html; charset=x-unknown" }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toEqual({
        outcome: "fallback",
        reason: "charset",
        detail: "x-unknown"
      });
    });
  });

  describe("robot checks and missing pages", () => {
    it.each([
      ["the robot check page served with HTTP 200", PRODUCT_URL, fixture("robot-check.html"), 200],
      ["the page Amazon serves with HTTP 503", PRODUCT_URL, fixture("service-unavailable.html"), 503],
      ["a page under /checkpoint/", `${ORIGIN}/checkpoint/continue?token=TEST-TOKEN`, SHAPELESS_HTML, 200],
      ["a page under /errors/validateCaptcha", `${ORIGIN}/errors/validateCaptcha?amzn=TEST`, SHAPELESS_HTML, 200]
    ])("answers a robot check for %s", async (_name, finalUrl, html, status) => {
      serve(() => htmlAnswer(html, { status, url: finalUrl }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toEqual({
        outcome: "robot-check",
        finalUrl,
        status
      });
    });

    it("answers not found for a product page served with HTTP 404, without the location step", async () => {
      const fetchMock = serve(() => htmlAnswer(fixture("product/not-found.html"), { status: 404 }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND })).resolves.toEqual({
        outcome: "not-found",
        finalUrl: PRODUCT_URL,
        status: 404
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a search page served with HTTP 404", SEARCH_URL, SEARCH_PAGE, 404],
      ["a product page served with HTTP 500", PRODUCT_URL, PRODUCT_PAGE, 500]
    ] as const)("hands %s to a tab", async (_name, url, page, status) => {
      serve(() => htmlAnswer(fixture("product/not-found.html"), { status }));

      await expect(runJob({ url, page })).resolves.toEqual({
        outcome: "fallback",
        reason: "http-status",
        detail: `HTTP ${status}`
      });
    });
  });

  describe("page shapes", () => {
    it.each([
      ["a product page with no product on it", PRODUCT_URL, PRODUCT_PAGE, SHAPELESS_HTML],
      [
        "a search page with neither results nor a results container",
        SEARCH_URL,
        SEARCH_PAGE,
        '<!doctype html><html><body><div id="search"><p>Nothing here</p></div></body></html>'
      ]
    ] as const)("hands %s to a tab", async (_name, url, page, html) => {
      serve(() => htmlAnswer(html));

      await expect(runJob({ url, page })).resolves.toEqual({ outcome: "fallback", reason: "shape" });
    });

    it("reads a search page with only Amazon's results container as no candidates", async () => {
      serve(() => htmlAnswer('<!doctype html><html><body><div class="s-main-slot s-result-list"></div></body></html>'));

      await expect(runJob({ url: SEARCH_URL, page: SEARCH_PAGE })).resolves.toEqual({
        outcome: "read",
        finalUrl: SEARCH_URL,
        candidates: []
      });
    });
  });

  describe("failed downloads and time limits", () => {
    it("hands a page whose download fails to a tab", async () => {
      serve(() => {
        throw new TypeError("Failed to fetch");
      });

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toEqual({
        outcome: "fallback",
        reason: "network",
        detail: "Failed to fetch"
      });
    });

    it("hands a page that has not arrived after 15 seconds to a tab", async () => {
      useFakeTimers();
      const fetchMock = serve(() => HELD);
      const job = settling(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }));

      await vi.advanceTimersByTimeAsync(14_999);
      expect(job.answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(job.answer).toEqual({ outcome: "fallback", reason: "timeout" });
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    });

    it("hands a job still running after 25 seconds to a tab", async () => {
      useFakeTimers();
      serve(store({ page: later(htmlAnswer(onlyOtherSellers("CH")), 14_000), offers: [HELD] }));
      const job = settling(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }));

      await vi.advanceTimersByTimeAsync(24_999);
      expect(job.answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(job.answer).toEqual({ outcome: "fallback", reason: "timeout" });
    });
  });

  describe("delivery location", () => {
    it("reads a page that already delivers to the destination, without a request", async () => {
      const fetchMock = serve(store({ page: htmlAnswer(productHtml((document) => applyLocation(document, "CH"))) }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND })).resolves.toMatchObject({
        outcome: "read",
        finalUrl: PRODUCT_URL,
        product: { destinationCountryCode: "CH" },
        location: { status: "ALREADY_SET", countryCode: "CH" },
        locationRequested: false
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("answers that the location was set without reading the page it set it from", async () => {
      const fetchMock = serve(store({ page: htmlAnswer(onlyOtherSellers("US")), offers: [textAnswer(offersPanel())] }));

      await expect(runJob({ url: PRODUCT_URL, page: SHOWN_US_PRODUCT_PAGE, location: TO_SWITZERLAND })).resolves.toEqual({
        outcome: "location-set",
        finalUrl: PRODUCT_URL,
        location: { status: "SET", countryCode: "CH" }
      });
      expect(requestedPaths(fetchMock)).toEqual(["/dp/B000000005", LOCATION_FORM_PATH, ADDRESS_CHANGE_PATH]);
    });

    it("reads the page and says the change was requested when Amazon refuses it", async () => {
      serve(
        store({ page: htmlAnswer(productHtml((document) => applyLocation(document, "US"))), change: textAnswer("", 403) })
      );

      const answer = await runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND });

      expect(answer).toMatchObject({
        outcome: "read",
        finalUrl: PRODUCT_URL,
        location: { status: "FAILED", reason: "Amazon answered HTTP 403" },
        locationRequested: true
      });
      expect(answer).toHaveProperty("product.marketplace", "DE");
    });

    it("reads the page without a request when the destination is the store's own country", async () => {
      const fetchMock = serve(store({ page: htmlAnswer(productHtml((document) => applyLocation(document, "US"))) }));

      await expect(
        runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: { marketplace: "DE", countryCode: "DE" } })
      ).resolves.toMatchObject({
        outcome: "read",
        location: { status: "FAILED", reason: "a postcode is needed for an address in the store's own country" },
        locationRequested: false
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("gives up on a location form that has not answered after 10 seconds and reads the page", async () => {
      useFakeTimers();
      const fetchMock = serve(store({ page: htmlAnswer(productHtml((document) => applyLocation(document, "US"))), form: HELD }));
      const job = settling(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND }));

      await vi.advanceTimersByTimeAsync(9_999);
      expect(job.answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(job.answer).toMatchObject({
        outcome: "read",
        location: { status: "FAILED", reason: "timed out after 10 seconds" },
        locationRequested: true
      });
      expect(requestedPaths(fetchMock)).toEqual(["/dp/B000000005", LOCATION_FORM_PATH]);
    });
  });

  describe("expected destination", () => {
    it("hands a page that shows another destination to a tab", async () => {
      serve(() => htmlAnswer(productHtml((document) => applyLocation(document, "US"))));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, expectDestination: "CH" })).resolves.toEqual({
        outcome: "fallback",
        reason: "destination",
        detail: "US"
      });
    });

    it.each([
      ["shows the expected destination", productHtml((document) => applyLocation(document, "CH"))],
      ["shows no destination it can read", fixture("product/DE.html")]
    ])("reads a page that %s", async (_name, html) => {
      serve(() => htmlAnswer(html));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, expectDestination: "CH" })).resolves.toMatchObject({
        outcome: "read",
        finalUrl: PRODUCT_URL
      });
    });
  });

  describe("other sellers' offers", () => {
    it("quotes another seller's offer from the offers list it downloads", async () => {
      const fetchMock = serve(store({ page: htmlAnswer(onlyOtherSellers("CH")), offers: [textAnswer(offersPanel())] }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toMatchObject({
        outcome: "read",
        product: {
          breakdown: { item: { amount: 651.25, currency: "EUR" }, shipping: { amount: 55.26, currency: "EUR" } },
          otherSeller: { seller: "Star Brick City", offerCount: 4, readCount: 4, readComplete: true }
        }
      });
      expect(fetchMock.mock.calls[1][0]).toBe(offersUrl(ORIGIN, "B000000005"));
    });

    it.each([
      ["refused", textAnswer("", 403), "Amazon answered HTTP 403"],
      ["answered with a robot check", textAnswer(fixture("robot-check.html")), "Amazon showed a robot check"]
    ])("hands the page to a tab when the first offers request is %s", async (_name, refusal, detail) => {
      serve(store({ page: htmlAnswer(onlyOtherSellers("CH")), offers: [refusal] }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE })).resolves.toEqual({
        outcome: "fallback",
        reason: "offers",
        detail
      });
    });

    it("keeps the offers it read when Amazon refuses a later page of the list", async () => {
      const eightOffers = offersPanel().replace('value="4" id="aod-total-offer-count"', 'value="8" id="aod-total-offer-count"');
      const fetchMock = serve(
        store({ page: htmlAnswer(onlyOtherSellers("CH")), offers: [textAnswer(eightOffers), textAnswer("", 403)] })
      );

      const answer = await runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE });

      expect(answer).toMatchObject({
        outcome: "read",
        product: { otherSeller: { seller: "Star Brick City", offerCount: 8, readCount: 4, readComplete: false } }
      });
      expect(answer).toHaveProperty("product.otherOffers.length", 4);
      expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("pageno"))).toEqual([null, "1", "2"]);
    });
  });

  describe("location carried on a fallback", () => {
    it("carries a destination that was already set onto a refused offers request", async () => {
      serve(store({ page: htmlAnswer(onlyOtherSellers("CH")), offers: [textAnswer("", 403)] }));

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE, location: TO_SWITZERLAND })).resolves.toEqual({
        outcome: "fallback",
        reason: "offers",
        detail: "Amazon answered HTTP 403",
        location: { status: "ALREADY_SET", countryCode: "CH" },
        locationRequested: false
      });
    });

    it("carries a location step that failed before any request onto a job that ran out of time", async () => {
      useFakeTimers();
      serve(store({ page: later(htmlAnswer(onlyOtherSellers("US")), 14_000), offers: [HELD] }));
      const job = settling(
        runJob({ url: PRODUCT_URL, page: SHOWN_US_PRODUCT_PAGE, location: { marketplace: "DE", countryCode: "DE" } })
      );

      await vi.advanceTimersByTimeAsync(25_000);

      expect(job.answer).toEqual({
        outcome: "fallback",
        reason: "timeout",
        location: { status: "FAILED", reason: "a postcode is needed for an address in the store's own country" },
        locationRequested: false
      });
    });
  });

  it("sends every request with the user's cookies and a signal, keeping each request's own headers and body", async () => {
    const fetchMock = serve(
      store({ page: htmlAnswer(onlyOtherSellers("US")), change: textAnswer("", 403), offers: [textAnswer(offersPanel())] })
    );

    await runJob({ url: PRODUCT_URL, page: SHOWN_US_PRODUCT_PAGE, location: TO_SWITZERLAND });

    const calls = fetchMock.mock.calls.map(([url, init = {}]) => ({ path: new URL(url).pathname, init }));
    expect(calls.map(({ path }) => path)).toEqual(["/dp/B000000005", LOCATION_FORM_PATH, ADDRESS_CHANGE_PATH, OFFERS_PATH]);
    for (const { init } of calls) {
      expect(init).toMatchObject({ credentials: "include", signal: expect.any(AbortSignal) });
    }
    expect(calls[1].init.headers).toEqual({ ...XHR_HEADERS, "anti-csrftoken-a2z": PAGE_TOKEN });
    expect(calls[2].init).toMatchObject({
      method: "POST",
      headers: { ...XHR_HEADERS, "Content-Type": "application/json", "anti-csrftoken-a2z": POST_TOKEN }
    });
    expect(JSON.parse(String(calls[2].init.body))).toMatchObject({ locationType: "COUNTRY", countryCode: "CH" });
    expect(calls[3].init.headers).toEqual(XHR_HEADERS);
  });

  describe("cancellation", () => {
    it("answers a stopped run's held job as cancelled and refuses its later jobs, but not another run's", async () => {
      const fetchMock = serve(() => HELD);
      const job = runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }, "run-stopped");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const { handled, sendResponse } = cancelRun("run-stopped");

      expect(handled).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      await expect(job).resolves.toEqual({ outcome: "cancelled" });
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);

      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }, "run-stopped")).resolves.toEqual({ outcome: "cancelled" });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      serve(() => htmlAnswer(fixture("product/DE.html")));
      await expect(runJob({ url: PRODUCT_URL, page: PRODUCT_PAGE }, "run-running")).resolves.toMatchObject({ outcome: "read" });
    });
  });
});
