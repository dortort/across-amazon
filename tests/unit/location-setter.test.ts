import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { readDestinationIso, setDeliveryLocation } from "../../src/content/location-setter";
import type { LocationRequest, Marketplace } from "../../src/shared/types";
import { destinationFields } from "./destination-fields";

const LOCATION_FIXTURES = join(process.cwd(), "tests", "fixtures", "location");
const FORM_PATH = "/portal-migration/hz/glow/get-rendered-address-selections";
const ADDRESS_CHANGE_URL = "https://www.amazon.de/portal-migration/hz/glow/address-change?actionSource=glow";
const SUCCESS = readFileSync(join(LOCATION_FIXTURES, "address-change-CH.json"), "utf8");

interface Answer {
  ok?: boolean;
  status?: number;
  body: string;
}

function fixture(file: string): string {
  return readFileSync(join(LOCATION_FIXTURES, file), "utf8");
}

function pageWith(body: string, url = "https://www.amazon.de/dp/B09LCMVB3F"): JSDOM {
  return new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url });
}

function navSwitzerlandWith(countryCode: string, storeContext = "industrial", url?: string): JSDOM {
  const html = fixture("nav-switzerland.html")
    .replace('id="countryCode" value="CH"', `id="countryCode" value="${countryCode}"`)
    .replace("storeContext=industrial", `storeContext=${storeContext}`);
  return new JSDOM(html, { url: url ?? "https://www.amazon.de/dp/B09LCMVB3F" });
}

function fetchAnswering(...answers: Answer[]) {
  const queue = [...answers];
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const answer = queue.shift();
    if (!answer) {
      throw new Error("Unexpected request");
    }
    return { ok: answer.ok ?? true, status: answer.status ?? 200, text: async () => answer.body };
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function request(countryCode: string, marketplace: Marketplace = "DE"): LocationRequest {
  return { marketplace, countryCode };
}

function run(dom: JSDOM, locationRequest: LocationRequest, fetchMock: ReturnType<typeof fetchAnswering>) {
  return setDeliveryLocation(dom.window.document, locationRequest, dom.window.location.origin, fetchMock);
}

describe("readDestinationIso", () => {
  function readFields(fields: Parameters<typeof destinationFields>[0]): string | undefined {
    return readDestinationIso(pageWith(destinationFields(fields)).window.document);
  }

  it.each([
    ["the vas state", { vas: "CH" }, "CH"],
    ["the country input beside a null $Nav config, as on amazon.fr, .it and .es", { input: "CH", nav: null }, "CH"],
    ["the $Nav config without a country input, as on amazon.com.au", { nav: "CH" }, "CH"],
    ["the vas state of a domestic address beside a null $Nav config, as on amazon.com.mx", { vas: "MX", nav: null }, "MX"],
    ["the vas state ahead of the country input", { vas: "CH", input: "US" }, "CH"],
    ["the country input ahead of the $Nav config", { input: "CH", nav: "US" }, "CH"],
    ["a lowercase code in upper case", { input: "ch" }, "CH"],
    ["nothing from a null $Nav config alone", { nav: null }, undefined],
    ["nothing from a code that is not two letters", { input: "CHE" }, undefined],
    ["nothing when no field is present", {}, undefined]
  ] as const)("reads %s", (_label, fields, expected) => {
    expect(readFields(fields)).toBe(expected);
  });

  it("skips a malformed state block and reads the vas state after it", () => {
    const malformed = `<script type="a-state" data-a-state='{"key":'>{}</script>`;
    const unparsable = `<script type="a-state" data-a-state='{"key":"vas-base-vm"}'>{countryCode:</script>`;
    const document = pageWith(`${malformed}${unparsable}${destinationFields({ vas: "CH" })}`).window.document;

    expect(readDestinationIso(document)).toBe("CH");
  });
});

describe("setDeliveryLocation", () => {
  it("leaves a store that already delivers to the destination alone without a request", async () => {
    const fetchMock = fetchAnswering();

    await expect(run(navSwitzerlandWith("CH"), request("CH"), fetchMock)).resolves.toEqual({ status: "ALREADY_SET", countryCode: "CH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a page without the location widget, with the country it shows when it shows one", async () => {
    const fetchMock = fetchAnswering();

    await expect(run(pageWith(destinationFields({ input: "US" })), request("CH"), fetchMock)).resolves.toEqual({
      status: "NO_WIDGET",
      countryCode: "US"
    });
    await expect(run(pageWith("<p>Page not found</p>"), request("CH"), fetchMock)).resolves.toEqual({ status: "NO_WIDGET" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the form with the page token and posts the seven fields with the form's own token", async () => {
    const fetchMock = fetchAnswering({ body: fixture("DE-modal.html") }, { body: SUCCESS });

    await expect(run(navSwitzerlandWith("US"), request("CH"), fetchMock)).resolves.toEqual({ status: "SET", countryCode: "CH" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [formUrl, formInit] = fetchMock.mock.calls[0];
    expect(new URL(formUrl).origin + new URL(formUrl).pathname).toBe(`https://www.amazon.de${FORM_PATH}`);
    expect(Object.fromEntries(new URL(formUrl).searchParams)).toEqual({
      deviceType: "desktop",
      pageType: "Detail",
      storeContext: "industrial",
      actionSource: "desktop-modal"
    });
    expect(formInit?.method).toBeUndefined();
    expect(formInit?.credentials).toBe("same-origin");
    expect(headersOf(formInit)["anti-csrftoken-a2z"]).toBe("TEST-PAGE-TOKEN");

    const [changeUrl, changeInit] = fetchMock.mock.calls[1];
    expect(changeUrl).toBe(ADDRESS_CHANGE_URL);
    expect(changeInit?.method).toBe("POST");
    expect(changeInit?.credentials).toBe("same-origin");
    expect(headersOf(changeInit)).toEqual({
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/html,*/*",
      "Content-Type": "application/json",
      "anti-csrftoken-a2z": "TEST-POST-TOKEN"
    });
    expect(JSON.parse(String(changeInit?.body))).toEqual({
      locationType: "COUNTRY",
      district: "CH",
      countryCode: "CH",
      storeContext: "industrial",
      deviceType: "web",
      pageType: "Detail",
      actionSource: "glow"
    });
  });

  it("falls back to the validation token input when the widget carries no ajax headers", async () => {
    const dom = navSwitzerlandWith("US");
    const widget = dom.window.document.querySelector("#nav-global-location-data-modal-action");
    const config = JSON.parse(widget?.getAttribute("data-a-modal") ?? "{}") as Record<string, unknown>;
    widget?.setAttribute("data-a-modal", JSON.stringify({ ...config, ajaxHeaders: {} }));
    const fetchMock = fetchAnswering({ body: fixture("DE-modal.html") }, { body: SUCCESS });

    await expect(run(dom, request("CH"), fetchMock)).resolves.toEqual({ status: "SET", countryCode: "CH" });
    expect(headersOf(fetchMock.mock.calls[0][1])["anti-csrftoken-a2z"]).toBe("TEST-PAGE-TOKEN");
  });

  it("posts the store context of the form URL, electronics on amazon.co.jp", async () => {
    const dom = navSwitzerlandWith("JP", "electronics", "https://www.amazon.co.jp/dp/B09LCMVB3F");
    const fetchMock = fetchAnswering({ body: fixture("JP-modal.html") }, { body: SUCCESS });

    await expect(run(dom, request("CH", "JP"), fetchMock)).resolves.toEqual({ status: "SET", countryCode: "CH" });
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.amazon.co.jp/portal-migration/hz/glow/address-change?actionSource=glow");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ storeContext: "electronics", pageType: "Detail" });
  });

  it("posts on a store whose form has no country select and trusts its answer, as on amazon.ca", async () => {
    const dom = navSwitzerlandWith("CA", "industrial", "https://www.amazon.ca/dp/B09LCD851Z");
    const fetchMock = fetchAnswering({ body: fixture("CA-modal.html") }, { body: SUCCESS });

    await expect(run(dom, request("CH", "CA"), fetchMock)).resolves.toEqual({ status: "SET", countryCode: "CH" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("posts from the amazon.com form, which lists Switzerland", async () => {
    const dom = navSwitzerlandWith("US", "industrial", "https://www.amazon.com/dp/B09LCMVB3F");
    const fetchMock = fetchAnswering({ body: fixture("US-modal.html") }, { body: SUCCESS });

    await expect(run(dom, request("CH", "US"), fetchMock)).resolves.toEqual({ status: "SET", countryCode: "CH" });
  });

  it("sends nothing for a destination the store's select does not offer, as on amazon.com.au", async () => {
    const dom = navSwitzerlandWith("NZ", "industrial", "https://www.amazon.com.au/dp/B09LCMVB3F");
    const fetchMock = fetchAnswering({ body: fixture("AU-modal.html") });

    await expect(run(dom, request("CH", "AU"), fetchMock)).resolves.toEqual({ status: "NOT_OFFERED", countryCode: "CH" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails without posting when the form carries no token, as Amazon answers a request without the page token", async () => {
    const fetchMock = fetchAnswering({ body: fixture("degraded-modal.html") });

    await expect(run(navSwitzerlandWith("US"), request("CH"), fetchMock)).resolves.toEqual({
      status: "FAILED",
      reason: "Amazon's location form carried no token"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty body, as for a wrong token", ""],
    ["an unsuccessful change", JSON.stringify({ ...JSON.parse(SUCCESS), successful: 0 })],
    ["another country", JSON.stringify({ ...JSON.parse(SUCCESS), address: { countryCode: "US" } })]
  ])("fails when Amazon answers the change with %s", async (_label, body) => {
    const fetchMock = fetchAnswering({ body: fixture("DE-modal.html") }, { body });

    await expect(run(navSwitzerlandWith("US"), request("CH"), fetchMock)).resolves.toEqual({
      status: "FAILED",
      reason: "Amazon did not accept the change"
    });
  });

  it.each([
    ["the form", [{ ok: false, status: 503, body: "" }]],
    ["the change", [{ body: fixture("DE-modal.html") }, { ok: false, status: 415, body: "" }]]
  ])("fails with the HTTP status Amazon answers %s with", async (_label, answers) => {
    const fetchMock = fetchAnswering(...answers);
    const status = answers[answers.length - 1].status;

    await expect(run(navSwitzerlandWith("US"), request("CH"), fetchMock)).resolves.toEqual({
      status: "FAILED",
      reason: `Amazon answered HTTP ${status}`
    });
  });

  it.each([
    ["DE", "DE"],
    ["UK", "GB"]
  ] as const)("fails without a request for a destination in the %s store's own country", async (marketplace, countryCode) => {
    const fetchMock = fetchAnswering();

    await expect(run(navSwitzerlandWith("CH"), request(countryCode, marketplace), fetchMock)).resolves.toEqual({
      status: "FAILED",
      reason: "a postcode is needed for an address in the store's own country"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails with the message of a request that throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(run(navSwitzerlandWith("US"), request("CH"), fetchMock)).resolves.toEqual({ status: "FAILED", reason: "Failed to fetch" });
  });
});
