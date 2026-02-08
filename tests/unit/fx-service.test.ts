import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDailyFxTable } from "../../src/background/fx-service";

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

describe("fx service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns cached table for the current utc day", async () => {
    const today = new Date();
    const key = `fx:${today.getUTCFullYear()}-${`${today.getUTCMonth() + 1}`.padStart(2, "0")}-${`${today.getUTCDate()}`.padStart(2, "0")}`;

    const { chromeMock } = createChromeStorageMock({
      [key]: {
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
