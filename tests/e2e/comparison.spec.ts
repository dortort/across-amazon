import { expect, test } from "@playwright/test";

type ScenarioName = "default" | "destination_mismatch" | "no_confident_match" | "fx_fallback";

async function installChromeMock(page: import("@playwright/test").Page, scenarioName: ScenarioName): Promise<void> {
  await page.addInitScript((selectedScenario) => {
    const listeners: Array<(message: unknown) => void> = [];

    const scenarios = {
      default: {
        source: {
          marketplace: "US",
          asin: "B00TEST000",
          title: "Acme Ultra Widget Model X100 2 Pack Blue",
          variationTokens: ["x100", "2 pack", "blue"],
          destinationCountryCode: "US",
          sourceUrl: "https://www.amazon.com/dp/B00TEST000"
        },
        results: [
          {
            marketplace: "UK",
            status: "OK",
            confidence: 0.93,
            productUrl: "https://www.amazon.co.uk/dp/B00TEST001",
            breakdown: {
              item: { amount: 30, currency: "GBP" },
              shipping: { amount: 3, currency: "GBP" },
              importFees: { amount: 2, currency: "GBP" }
            },
            normalizedTotal: { amount: 41.2, currency: "USD" }
          },
          {
            marketplace: "DE",
            status: "OK",
            confidence: 0.89,
            productUrl: "https://www.amazon.de/dp/B00TEST002",
            breakdown: {
              item: { amount: 35, currency: "EUR" },
              shipping: { amount: 4, currency: "EUR" },
              importFees: { amount: 3, currency: "EUR" }
            },
            normalizedTotal: { amount: 45.1, currency: "USD" }
          },
          {
            marketplace: "FR",
            status: "DESTINATION_MISMATCH",
            confidence: 0.81,
            productUrl: "https://www.amazon.fr/dp/B00TEST003"
          },
          {
            marketplace: "JP",
            status: "NO_CONFIDENT_MATCH",
            confidence: 0
          }
        ],
        generatedAt: "2026-02-08T10:00:00.000Z"
      },
      destination_mismatch: {
        source: {
          marketplace: "US",
          asin: "B00TEST000",
          title: "Acme Ultra Widget",
          variationTokens: [],
          destinationCountryCode: "US",
          sourceUrl: "https://www.amazon.com/dp/B00TEST000"
        },
        results: [
          {
            marketplace: "DE",
            status: "DESTINATION_MISMATCH",
            confidence: 0.82,
            productUrl: "https://www.amazon.de/dp/B00TEST100"
          }
        ],
        generatedAt: "2026-02-08T10:05:00.000Z"
      },
      no_confident_match: {
        source: {
          marketplace: "US",
          asin: "B00TEST000",
          title: "Acme Ultra Widget",
          variationTokens: [],
          destinationCountryCode: "US",
          sourceUrl: "https://www.amazon.com/dp/B00TEST000"
        },
        results: [
          {
            marketplace: "UK",
            status: "NO_CONFIDENT_MATCH",
            confidence: 0
          }
        ],
        generatedAt: "2026-02-08T10:10:00.000Z"
      },
      fx_fallback: {
        source: {
          marketplace: "US",
          asin: "B00TEST000",
          title: "Acme Ultra Widget",
          variationTokens: [],
          destinationCountryCode: "US",
          sourceUrl: "https://www.amazon.com/dp/B00TEST000"
        },
        results: [
          {
            marketplace: "ES",
            status: "OK",
            confidence: 0.88,
            productUrl: "https://www.amazon.es/dp/B00TEST200",
            breakdown: {
              item: { amount: 31, currency: "EUR" },
              shipping: { amount: 4, currency: "EUR" },
              importFees: { amount: 2, currency: "EUR" }
            },
            normalizedTotal: { amount: 40.9, currency: "USD" },
            notes: ["FX source fallback: FRANKFURTER"]
          }
        ],
        generatedAt: "2026-02-08T10:15:00.000Z"
      }
    } as const;

    const scenarioPayload = scenarios[selectedScenario as keyof typeof scenarios] ?? scenarios.default;

    (window as Window & { __openedUrls?: string[] }).__openedUrls = [];

    const chromeMock = {
      tabs: {
        query: async () => [{ id: 42 }],
        create: async ({ url }: { url: string }) => {
          (window as Window & { __openedUrls?: string[] }).__openedUrls?.push(url);
          return { id: 99, url };
        }
      },
      runtime: {
        onMessage: {
          addListener: (listener: (message: unknown) => void) => {
            listeners.push(listener);
          },
          removeListener: (listener: (message: unknown) => void) => {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
              listeners.splice(index, 1);
            }
          }
        },
        sendMessage: async (message: { type?: string }) => {
          if (message.type === "RUN_COMPARISON") {
            setTimeout(() => {
              listeners.forEach((listener) => {
                listener({
                  type: "RUN_COMPARISON_PROGRESS",
                  payload: {
                    completed: 1,
                    total: 3,
                    currentMarketplace: "UK"
                  }
                });
              });
            }, 20);

            setTimeout(() => {
              listeners.forEach((listener) => {
                listener({
                  type: "RUN_COMPARISON_RESULT",
                  payload: scenarioPayload
                });
              });
            }, 400);

            return { ok: true };
          }

          return { ok: true };
        }
      }
    };

    Object.defineProperty(window, "chrome", {
      configurable: true,
      writable: true,
      value: chromeMock
    });
  }, scenarioName);
}

test("renders progress and final comparison rows with cheapest highlighted", async ({ page }) => {
  await installChromeMock(page, "default");
  await page.goto("/popup.html");

  await page.getByRole("button", { name: "Compare delivered prices" }).click();

  await expect(page.getByText("Progress: 1/3 (United Kingdom)")).toBeVisible();
  await expect(page.getByText("Cheapest")).toBeVisible();
  await expect(page.getByText("Destination mismatch")).toBeVisible();
  await expect(page.getByText("1 marketplace(s) omitted due to low-confidence product matching.")).toBeVisible();

  const firstRowMarketplace = await page.locator("tbody tr").first().locator("td").first().innerText();
  expect(firstRowMarketplace).toContain("United Kingdom");

  await page.getByRole("button", { name: "Open" }).first().click();
  const openedUrls = await page.evaluate(() => (window as Window & { __openedUrls?: string[] }).__openedUrls ?? []);
  expect(openedUrls[0]).toContain("amazon.co.uk");
});

test("shows destination mismatch status rows", async ({ page }) => {
  await installChromeMock(page, "destination_mismatch");
  await page.goto("/popup.html");
  await page.getByRole("button", { name: "Compare delivered prices" }).click();

  await expect(page.getByText("Destination mismatch")).toBeVisible();
});

test("hides low-confidence-only runs from result table", async ({ page }) => {
  await installChromeMock(page, "no_confident_match");
  await page.goto("/popup.html");
  await page.getByRole("button", { name: "Compare delivered prices" }).click();

  await expect(page.getByText("Run a comparison to see cross-market delivered totals.")).toBeVisible();
});

test("still renders comparable totals when fx fallback scenario is returned", async ({ page }) => {
  await installChromeMock(page, "fx_fallback");
  await page.goto("/popup.html");
  await page.getByRole("button", { name: "Compare delivered prices" }).click();

  await expect(page.getByText("Spain")).toBeVisible();
  await expect(page.getByText("$40.90")).toBeVisible();
});
