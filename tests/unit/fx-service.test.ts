import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ECB_DAILY_RATES_URL, FRANKFURTER_LATEST_URL, getDailyFxTable } from "../../src/background/fx-service";

type StorageRecord = Record<string, unknown>;

function createChromeStorageMock(initialState: StorageRecord = {}): {
  storage: StorageRecord;
  chromeMock: typeof chrome;
} {
  const storage: StorageRecord = { ...initialState };

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (value: StorageRecord) => {
          Object.assign(storage, value);
        })
      }
    }
  } as unknown as typeof chrome;

  return { storage, chromeMock };
}

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-10-16'>
      <Cube currency='USD' rate='1.08'/>
      <Cube currency='JPY' rate='155.52'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const HOST_PERMISSIONS = (
  JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { host_permissions: string[] }
).host_permissions;

function isCoveredByHostPermission(url: string, patterns: string[]): boolean {
  const { protocol, hostname } = new URL(url);
  return patterns.some((pattern) => {
    if (pattern === "<all_urls>") {
      return true;
    }
    const match = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
    if (!match) {
      return false;
    }
    const [, scheme, host] = match;
    const schemeMatches = scheme === "*" ? protocol === "https:" || protocol === "http:" : protocol === `${scheme}:`;
    const hostMatches =
      host === "*" ||
      hostname === host ||
      (host.startsWith("*.") && (hostname === host.slice(2) || hostname.endsWith(host.slice(1))));
    return schemeMatches && hostMatches;
  });
}

function todayCacheKey(): string {
  const today = new Date();
  return `fx:${today.getUTCFullYear()}-${`${today.getUTCMonth() + 1}`.padStart(2, "0")}-${`${today.getUTCDate()}`.padStart(2, "0")}`;
}

describe("fx service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the ECB feed first and stores it under today's utc key", async () => {
    const { storage, chromeMock } = createChromeStorageMock();
    vi.stubGlobal("chrome", chromeMock);

    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => ECB_XML });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const table = await getDailyFxTable();

    expect(table).toEqual({
      base: "EUR",
      date: "2026-10-16",
      rates: { EUR: 1, USD: 1.08, JPY: 155.52 },
      source: "ECB"
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([ECB_DAILY_RATES_URL]);
    expect(storage[todayCacheKey()]).toEqual(table);
  });

  it("tries ECB then Frankfurter and fails with the known error when both are unreachable", async () => {
    const { chromeMock } = createChromeStorageMock();
    vi.stubGlobal("chrome", chromeMock);

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(getDailyFxTable()).rejects.toThrow("Unable to load FX reference rates from ECB or Frankfurter");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([ECB_DAILY_RATES_URL, FRANKFURTER_LATEST_URL]);
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });

  it("uses frankfurter fallback when ECB is unavailable", async () => {
    const { chromeMock } = createChromeStorageMock();
    vi.stubGlobal("chrome", chromeMock);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          base: "EUR",
          date: "2026-02-08",
          rates: {
            USD: 1.11,
            GBP: 0.84,
            JPY: 160.01
          }
        })
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const table = await getDailyFxTable();

    expect(table.source).toBe("FRANKFURTER");
    expect(table.rates.USD).toBe(1.11);
    expect(table.rates.EUR).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([ECB_DAILY_RATES_URL, FRANKFURTER_LATEST_URL]);
  });

  it("returns cached table for the current utc day", async () => {
    const { chromeMock } = createChromeStorageMock({
      [todayCacheKey()]: {
        base: "EUR",
        date: "2026-02-08",
        rates: {
          USD: 1.1,
          EUR: 1
        },
        source: "ECB"
      }
    });

    vi.stubGlobal("chrome", chromeMock);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const table = await getDailyFxTable();

    expect(table.source).toBe("ECB");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fx host permissions", () => {
  it("covers every fx endpoint with a manifest host permission", async () => {
    const { chromeMock } = createChromeStorageMock();
    vi.stubGlobal("chrome", chromeMock);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await getDailyFxTable().catch(() => undefined);

    const fetchedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    const endpoints = new Set([ECB_DAILY_RATES_URL, FRANKFURTER_LATEST_URL, ...fetchedUrls]);
    const uncovered = [...endpoints].filter((url) => !isCoveredByHostPermission(url, HOST_PERMISSIONS));

    expect(fetchedUrls.length).toBeGreaterThan(0);
    expect(uncovered).toEqual([]);
  });

  it("matches host permission patterns by scheme and host", () => {
    expect(isCoveredByHostPermission("https://api.frankfurter.app/latest?from=EUR", HOST_PERMISSIONS)).toBe(false);
    expect(isCoveredByHostPermission("http://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", HOST_PERMISSIONS)).toBe(false);
    expect(isCoveredByHostPermission("https://www.amazon.com/dp/B000000001", HOST_PERMISSIONS)).toBe(true);
    expect(isCoveredByHostPermission("https://api.example.com/rates", ["https://*.example.com/*"])).toBe(true);
    expect(isCoveredByHostPermission("https://example.com/rates", ["*://*.example.com/*"])).toBe(true);
    expect(isCoveredByHostPermission("https://notexample.com/rates", ["https://*.example.com/*"])).toBe(false);
  });
});
