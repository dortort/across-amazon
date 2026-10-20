import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../../src/shared/storage";

function stubStoredSettings(value: unknown): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: value }))
      }
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSettings", () => {
  it("loads settings saved with the retired disclosure flag and drops it", async () => {
    stubStoredSettings({
      enabledMarketplaces: ["US", "UK"],
      comparisonCurrency: "CHF",
      disclosureAcknowledged: true
    });

    await expect(loadSettings()).resolves.toEqual({
      enabledMarketplaces: ["US", "UK"],
      comparisonCurrency: "CHF"
    });
  });
});
