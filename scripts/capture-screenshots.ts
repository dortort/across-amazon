import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { chromium, expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { createServer } from "vite";
import type * as Harness from "../tests/e2e/harness";

interface Shot {
  name: string;
  reach: (page: Page) => Promise<void>;
}

const ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "docs", "screenshots");
const HOST = "127.0.0.1";
const VIEWPORT = { width: 400, height: 560 };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function shots(h: typeof Harness): Shot[] {
  const thumbnailLoaded = (page: Page): Promise<void> =>
    expect
      .poll(() =>
        page.locator(".dB-thumb img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
      )
      .toBe(true);

  const scrollToBottom = async (page: Page): Promise<void> => {
    await h.scrollArea(page).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        h.scrollArea(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      )
      .toBeLessThanOrEqual(1);
  };

  const finished = async (page: Page, scn = h.scenario()): Promise<void> => {
    await h.openPopup(page, scn);
    await h.completeRun(page, scn);
  };

  return [
    {
      name: "idle",
      reach: async (page) => {
        await h.openPopup(page);
        await expect(h.runButton(page)).toHaveText("Check 9 other Amazons");
        await thumbnailLoaded(page);
      }
    },
    {
      name: "running",
      reach: async (page) => {
        const scn = h.scenario();
        await h.openPopup(page, scn);
        await h.startRun(page);
        await h.emitProgress(page, h.progressStep(scn, "FR", "SEARCH"));
        await expect(page.locator(".dB-dial-num")).toHaveText("4/9");
        await expect(page.locator(".dB-nowline")).toHaveText("Searching France");
        await expect(page.locator(".dB-chk")).toHaveText([
          "🇨🇦 CA $391.44",
          "🇲🇽 MX —",
          "🇬🇧 UK $372.16",
          "🇩🇪 DE $349.05",
          "🇫🇷 FR …"
        ]);
      }
    },
    {
      name: "done",
      reach: async (page) => {
        await finished(page);
        await expect(h.verdictCard(page).locator(".dB-save")).toHaveText("Save $50.94");
      }
    },
    {
      name: "done-list",
      reach: async (page) => {
        await finished(page);
        await h.scrollArea(page).evaluate((element) => {
          const title = element.querySelector(".dB-sectitle");
          if (!title) {
            throw new Error("The ranked list is not rendered");
          }
          element.scrollTop += title.getBoundingClientRect().top - element.getBoundingClientRect().top - 16;
        });
        await expect(page.locator(".dB-verdict")).not.toBeInViewport();
        await expect(page.locator(".dB-sectitle")).toBeInViewport({ ratio: 1 });
        await expect(h.listRows(page)).toHaveCount(6);
      }
    },
    {
      name: "issues-open",
      reach: async (page) => {
        await finished(page);
        await page.getByRole("button", { name: "4 marketplaces could not be compared" }).click();
        await expect(page.locator(".dB-issue")).toHaveCount(4);
        await scrollToBottom(page);
      }
    },
    {
      name: "sheet",
      reach: async (page) => {
        await finished(page);
        await h.listRow(page, "Germany").click();
        await expect(page.getByRole("dialog", { name: "🇩🇪 Germany" })).toBeVisible();
        await expect
          .poll(() => page.locator(".dB-sheet").evaluate((element) => getComputedStyle(element).transform))
          .toBe("matrix(1, 0, 0, 1, 0, 0)");
      }
    },
    {
      name: "stay",
      reach: async (page) => {
        await finished(page, h.scenario({ baseline: h.cheapBaseline }));
        await expect(h.verdictCard(page).locator(".dB-save")).toHaveText("Stay here");
      }
    },
    {
      name: "settings",
      reach: async (page) => {
        await h.openPopup(page);
        await page.getByRole("button", { name: "Settings" }).click();
        await expect(page.getByRole("button", { name: "Close settings" })).toBeVisible();
        await expect(page.getByRole("button", { name: "USD", exact: true })).toHaveAttribute("aria-pressed", "true");
      }
    },
    {
      name: "not-on-amazon",
      reach: async (page) => {
        await h.openPopup(page, h.scenario({ tabUrl: h.NON_AMAZON_URL }));
        await expect(page.getByText("Open an Amazon product page")).toBeVisible();
        await expect(h.runButton(page)).toBeDisabled();
      }
    }
  ];
}

function scrolledOutsideContent(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [document.documentElement, document.body, ...document.body.querySelectorAll("*")]
      .filter((element) => !element.classList.contains("dB-scroll"))
      .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
      .map((element) => element.className || element.tagName)
  );
}

async function capture(browser: Browser, baseURL: string, shot: Shot): Promise<string> {
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC"
  });
  try {
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    await shot.reach(page);
    await expect.poll(() => scrolledOutsideContent(page)).toEqual([]);
    await page.mouse.move(1, 1);
    const path = join(OUT_DIR, `${shot.name}.png`);
    await page.screenshot({ path, animations: "disabled", caret: "hide", scale: "device" });
    return path;
  } finally {
    await context.close();
  }
}

const port = await freePort();
const server = await createServer({
  root: ROOT,
  configFile: join(ROOT, "vite.config.ts"),
  logLevel: "warn",
  clearScreen: false,
  server: { host: HOST, port, strictPort: true }
});
let browser: Browser | undefined;

try {
  await server.listen();
  const harness = (await server.ssrLoadModule("/tests/e2e/harness.ts")) as typeof Harness;
  browser = await chromium.launch();
  await mkdir(OUT_DIR, { recursive: true });
  for (const shot of shots(harness)) {
    const path = await capture(browser, `http://${HOST}:${port}/`, shot);
    process.stdout.write(`${relative(ROOT, path)}\n`);
  }
} finally {
  await browser?.close();
  await server.close();
}
