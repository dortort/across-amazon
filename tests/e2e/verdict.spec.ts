import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { MARKETPLACE_CODES } from "../../src/shared/markets";
import { CANCEL_COMPARISON, LOAD_SOURCE, RUN_COMPARISON } from "../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  CANCELLED,
  DEFAULT_SETTINGS,
  FX_FAILURE,
  MINUS,
  NBSP,
  cheapBaseline,
  completeRun,
  emitProgress,
  emitResult,
  emittedTypes,
  es,
  finalStep,
  fr,
  jp,
  listRow,
  listRows,
  mx,
  openPopup,
  openedUrls,
  productUrl,
  progressStep,
  progressSteps,
  resultPayload,
  runButton,
  scenario,
  sentMessages,
  source,
  startRun,
  storedSettings,
  toast,
  verdictCard
} from "./harness";

test.use({ viewport: { width: 400, height: 560 } });

const RUN_REQUEST = { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } };
const TOAST_HIDE_TIMEOUT = 5_000;

const USD_ROWS = {
  names: [/^🇩🇪\s*Germany/, /^🇮🇹\s*Italy/, /^🇬🇧\s*United Kingdom/, /^🇨🇦\s*Canada/, /^🇺🇸\s*United States/, /^🇦🇺\s*Australia/],
  locals: [
    `323,19${NBSP}€ incl. shipping & import`,
    `334,60${NBSP}€ incl. shipping & import`,
    "£293.59 incl. shipping & import",
    "$534.60 incl. shipping & import",
    "$399.99 incl. shipping & import",
    "$672.30 incl. shipping & import"
  ],
  totals: ["$349.05", "$361.37", "$372.16", "$391.44", "$399.99", "$438.72"],
  deltas: [`${MINUS}$50.94`, `${MINUS}$38.62`, `${MINUS}$27.83`, `${MINUS}$8.55`, "the page you are on", "+$38.73"]
};

function dial(page: Page) {
  return {
    ring: page.locator(".dB-dial"),
    count: page.locator(".dB-dial-num"),
    nowline: page.locator(".dB-nowline"),
    nowsub: page.locator(".dB-nowsub"),
    chips: page.locator(".dB-chk")
  };
}

async function expectToastShown(page: Page, text: string): Promise<void> {
  await expect(toast(page)).toHaveText(text);
  await expect(toast(page)).toHaveClass(/\bis-on\b/);
  await expect(toast(page)).toHaveCSS("opacity", "1");
}

async function expectToastHidden(page: Page): Promise<void> {
  await expect(toast(page)).not.toHaveClass(/\bis-on\b/, { timeout: TOAST_HIDE_TIMEOUT });
  await expect(toast(page)).toHaveCSS("opacity", "0");
}

test.describe("a full comparison", () => {
  test("runs from the product card through every phase to the verdict, sheet, issues and a re-run", async ({
    page
  }) => {
    const scn = scenario();
    await openPopup(page, scn);

    await expect(page.getByRole("heading", { level: 3, name: source.title })).toBeVisible();
    await expect(page.getByText("Black · $399.99 on amazon.com")).toBeVisible();
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");
    await expect(runButton(page)).toBeEnabled();
    await expect(
      page.getByText(
        "Takes about 27 seconds. Each Amazon opens briefly in a background tab so we can read its real delivered price to United States."
      )
    ).toBeVisible();
    await expect(page.getByText("ECB daily rates")).toBeVisible();
    expect(await sentMessages(page, LOAD_SOURCE)).toEqual([
      { type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } }
    ]);

    await startRun(page);
    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([RUN_REQUEST]);

    const running = dial(page);
    await expect(running.count).toHaveText("0/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*0%/);
    await expect(running.nowline).toHaveText("Opening tab Canada");
    await expect(running.nowsub).toHaveText("amazon.ca");
    await expect(running.chips).toHaveText(["🇨🇦 CA …"]);
    await expect(running.chips).toHaveClass(["dB-chk now"]);

    await emitProgress(page, progressStep(scn, "CA", "SEARCH"));
    await expect(running.nowline).toHaveText("Searching Canada");
    await expect(running.count).toHaveText("0/9");

    await emitProgress(page, progressStep(scn, "FR", "MATCH"));
    await expect(running.count).toHaveText("4/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*44%/);
    await expect(running.nowline).toHaveText("Matching product France");
    await expect(page.locator(".dB-nowline b")).toHaveText("France");
    await expect(running.nowsub).toHaveText("amazon.fr");
    await expect(running.chips).toHaveText([
      "🇩🇪 DE $349.05",
      "🇬🇧 UK $372.16",
      "🇨🇦 CA $391.44",
      "🇲🇽 MX —",
      "🇫🇷 FR …"
    ]);
    await expect(running.chips).toHaveClass([
      "dB-chk ok",
      "dB-chk ok",
      "dB-chk ok",
      "dB-chk bad",
      "dB-chk now"
    ]);

    await emitProgress(page, progressStep(scn, "AU", "READ"));
    await expect(running.count).toHaveText("8/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*89%/);
    await expect(running.nowline).toHaveText("Reading cost stack Australia");
    await expect(running.nowsub).toHaveText("amazon.com.au");
    await expect(running.chips).toHaveCount(9);
    await expect(running.chips.last()).toHaveText("🇦🇺 AU …");

    await emitProgress(page, finalStep(scn));
    await expect(running.count).toHaveText("9/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*100%/);
    await expect(page.locator(".dB-chk.now")).toHaveCount(0);
    await expect(running.chips).toHaveText([
      "🇩🇪 DE $349.05",
      "🇮🇹 IT $361.37",
      "🇬🇧 UK $372.16",
      "🇨🇦 CA $391.44",
      "🇦🇺 AU $438.72",
      "🇪🇸 ES —",
      "🇫🇷 FR —",
      "🇯🇵 JP —",
      "🇲🇽 MX —"
    ]);
    await expect(page.getByText("ECB daily rates")).toBeVisible();

    await emitResult(page, resultPayload(scn));

    const card = verdictCard(page);
    await expect(card.locator(".eyebrow")).toHaveText("Cheapest delivered to United States");
    await expect(card.getByText("Save $50.94")).toBeVisible();
    await expect(card.locator(".lede")).toHaveText(
      "Buy from Germany for $349.05 delivered — 13% less than the $399.99 you would pay here. Item, shipping and import fees included."
    );
    await expect(card.locator(".lede b")).toHaveText(["Germany", "$349.05"]);
    await expect(page.getByRole("button", { name: "Stop checking" })).toHaveCount(0);
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();
    await expect(page.getByText("ECB daily rates")).toHaveCount(0);

    await expect(page.getByText("Every marketplace")).toBeVisible();
    await expect(page.getByText("USD delivered")).toBeVisible();
    const rows = listRows(page);
    await expect(rows).toHaveText(USD_ROWS.names);
    await expect(rows.locator(".who > span")).toHaveText(USD_ROWS.locals);
    await expect(rows.locator(".amt strong")).toHaveText(USD_ROWS.totals);
    await expect(rows.locator(".amt > span")).toHaveText(USD_ROWS.deltas);
    await expect(rows.first()).toHaveClass(/\bbest\b/);
    await expect(page.locator(".dB-row.best")).toHaveCount(1);
    await expect(page.getByText("Check match")).toHaveCount(1);
    await expect(listRow(page, "Italy").getByText("Check match")).toBeVisible();
    await expect(listRow(page, "Australia").getByText("Check match")).toHaveCount(0);

    await listRow(page, "Germany").click();
    const sheet = page.getByRole("dialog", { name: "🇩🇪 Germany" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect(sheet).toBeFocused();
    await expect(sheet.locator(".sub")).toHaveText("www.amazon.de");
    await expect(sheet.locator(".dB-line > span")).toHaveText([
      "Item price",
      "Shipping to United States",
      "Import fees deposit",
      "Delivered total",
      "Roughly"
    ]);
    await expect(sheet.locator(".dB-line > b")).toHaveText([
      `279,00${NBSP}€`,
      `12,99${NBSP}€`,
      `31,20${NBSP}€`,
      `323,19${NBSP}€`,
      "$349.05 at today’s rate"
    ]);
    const trust = sheet.locator(".dB-trust");
    await expect(trust).toHaveText(
      "We are 91% sure this is the same product — title, brand and variant all line up. Import fees deposit quoted on the product page. Delivery 6–10 days."
    );
    await expect(trust).not.toHaveClass(/\bwarn\b/);

    await sheet.getByRole("button", { name: "Open on amazon.de" }).click();
    await expect.poll(() => openedUrls(page)).toEqual([productUrl("DE")]);
    await expectToastShown(page, "Opening amazon.de — you complete the purchase on Amazon.");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const accordion = page.getByRole("button", { name: "4 marketplaces could not be compared" });
    const issues = page.locator(".dB-issue");
    await expect(accordion).toHaveAttribute("aria-expanded", "false");
    await expect(issues.first()).toBeHidden();

    await accordion.click();
    await expect(accordion).toHaveAttribute("aria-expanded", "true");
    await expect(issues).toHaveCount(4);
    await expect(issues.locator(".flag")).toHaveText(["🇪🇸", "🇫🇷", "🇯🇵", "🇲🇽"]);
    await expect(issues.locator("strong")).toHaveText([
      "Spain — Could not read the page",
      "France — Delivered total not quotable",
      "Japan — Does not ship here",
      "Mexico — No confident match"
    ]);
    await expect(issues.locator("p")).toHaveText([
      "Import fees are only revealed at checkout, so the delivered total cannot be quoted.",
      "Out of stock — no delivery date offered.",
      "Match found, but the seller does not ship to the United States.",
      "Closest listing scored 31% — below the confidence floor."
    ]);
    for (const issue of await issues.all()) {
      await expect(issue).toBeVisible();
    }

    await accordion.click();
    await expect(accordion).toHaveAttribute("aria-expanded", "false");
    await expect(issues.first()).toBeHidden();

    await page.getByRole("button", { name: "Check again" }).click();
    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([RUN_REQUEST, RUN_REQUEST]);
    await expect(running.count).toHaveText("0/9");
    await expect(running.nowline).toHaveText("Opening tab Canada");
    await expect(running.chips).toHaveText(["🇨🇦 CA …"]);
    await expect(page.getByRole("button", { name: "Stop checking" })).toBeVisible();

    await emitResult(page, resultPayload(scn));
    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
  });

  test("follows a timer-paced stream of every phase the background sends", async ({ page }) => {
    const scn = scenario({ stepMs: 15 });
    await openPopup(page, scn);

    await runButton(page).click();

    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
    await expect(listRows(page).locator(".amt strong")).toHaveText(USD_ROWS.totals);
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();
    expect(await emittedTypes(page)).toEqual([
      ...progressSteps(scn).map(() => "RUN_COMPARISON_PROGRESS"),
      "RUN_COMPARISON_RESULT"
    ]);
    expect(progressSteps(scn)).toHaveLength(9 * 4 + 1);
  });

  test("opens the cheapest marketplace straight from the verdict card", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await verdictCard(page).getByRole("button", { name: "Open on amazon.de" }).click();

    await expect.poll(() => openedUrls(page)).toEqual([productUrl("DE")]);
    await expectToastShown(page, "Opening amazon.de — you complete the purchase on Amazon.");
    await expectToastHidden(page);
  });
});

test.describe("the detail sheet", () => {
  test("flags a low-confidence match and closes from the scrim", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await listRow(page, "Italy").click();
    const sheet = page.getByRole("dialog", { name: "🇮🇹 Italy" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".dB-trust")).toHaveClass(/\bwarn\b/);
    await expect(sheet.locator(".dB-trust")).toHaveText(
      "We are 76% sure this is the same product. Colour is not stated in the listing title — confirm it is the black variant before buying."
    );
    await expect(page.locator(".dB-scrim")).toHaveClass(/\bis-on\b/);

    await page.locator(".dB-scrim").click({ position: { x: 200, y: 24 } });

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".dB-scrim")).not.toHaveClass(/\bis-on\b/);
    expect(await openedUrls(page)).toEqual([]);
  });

  test("shows the page you are on with a Close button instead of Open", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await listRow(page, "United States").click();
    const sheet = page.getByRole("dialog", { name: "🇺🇸 United States" });
    await expect(sheet.locator(".sub")).toHaveText(source.title);
    await expect(sheet.locator(".dB-line > b")).toHaveText([
      "$399.99",
      "Free",
      "—",
      "$399.99",
      "$399.99 at today’s rate"
    ]);
    await expect(sheet.getByRole("button", { name: /^Open on/ })).toHaveCount(0);

    await sheet.getByRole("button", { name: "Close" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await openedUrls(page)).toEqual([]);
  });
});

test.describe("other verdicts", () => {
  test("says stay here when nothing beats the page price", async ({ page }) => {
    const scn = scenario({ baseline: cheapBaseline });
    await openPopup(page, scn);
    await expect(page.getByText("Black · $299.99 on amazon.com")).toBeVisible();

    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card).toHaveClass(/\bis-muted\b/);
    await expect(card.locator(".eyebrow")).toHaveText("Result");
    await expect(card.getByText("Stay here")).toBeVisible();
    await expect(card.locator(".lede")).toHaveText("Nothing came in under the $299.99 you would pay on amazon.com.");
    await expect(page.getByRole("button", { name: /^Open on/ })).toHaveCount(0);

    const rows = listRows(page);
    await expect(rows).toHaveText([/United States/, /Germany/, /Italy/, /United Kingdom/, /Canada/, /Australia/]);
    await expect(rows.first()).toHaveClass(/\bbest\b/);
    await expect(rows.locator(".amt > span")).toHaveText([
      "the page you are on",
      "+$49.06",
      "+$61.38",
      "+$72.17",
      "+$91.45",
      "+$138.73"
    ]);
  });

  test("names the cheapest marketplace when the page price could not be read", async ({ page }) => {
    const scn = scenario({ baseline: undefined });
    await openPopup(page, scn);
    await expect(page.getByText("Black · amazon.com", { exact: true })).toBeVisible();

    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card).not.toHaveClass(/\bis-muted\b/);
    await expect(card.locator(".eyebrow")).toHaveText("Cheapest delivered to United States");
    await expect(card.locator(".dB-save")).toHaveText("$349.05");
    await expect(card.locator(".lede")).toHaveText(
      "Buy from Germany for $349.05 delivered. Item, shipping and import fees included. We could not read the price on this page to compare."
    );

    const rows = listRows(page);
    await expect(rows).toHaveText([/Germany/, /Italy/, /United Kingdom/, /Canada/, /Australia/]);
    await expect(rows.locator(".amt > span")).toHaveText(["", "", "", "", ""]);
    await expect(rows.first()).toHaveClass(/\bbest\b/);

    await card.getByRole("button", { name: "Open on amazon.de" }).click();
    await expect.poll(() => openedUrls(page)).toEqual([productUrl("DE")]);
  });

  test("reports no delivered price when every marketplace failed", async ({ page }) => {
    const scn = scenario({ results: [es, fr, jp, mx] });
    await openPopup(page, scn);
    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card).toHaveClass(/\bis-muted\b/);
    await expect(card.locator(".eyebrow")).toHaveText("Result");
    await expect(card.getByText("No delivered price")).toBeVisible();
    await expect(card.locator(".lede")).toHaveText(
      "None of the marketplaces we checked could quote a delivered price to United States."
    );
    await expect(page.getByRole("button", { name: /^Open on/ })).toHaveCount(0);
    await expect(listRows(page)).toHaveText([/United States/]);
    await expect(page.getByRole("button", { name: "4 marketplaces could not be compared" })).toBeVisible();
  });

  test("explains a failed run and lets the user try again", async ({ page }) => {
    const scn = scenario({ results: [], fxTable: undefined, error: FX_FAILURE });
    await openPopup(page, scn);
    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card).toHaveClass(/\bis-muted\b/);
    await expect(card.locator(".eyebrow")).toHaveText("Something went wrong");
    await expect(card.getByText("Couldn't compare")).toBeVisible();
    await expect(card.locator(".lede")).toHaveText(FX_FAILURE);
    await expect(listRows(page)).toHaveText([/United States/]);
    await expect(listRows(page).locator(".amt > span")).toHaveText(["the page you are on"]);
    await expect(page.getByRole("button", { name: /could not be compared/ })).toHaveCount(0);
    await expect(page.getByText("ECB daily rates")).toBeVisible();

    await page.getByRole("button", { name: "Check again" }).click();

    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([RUN_REQUEST, RUN_REQUEST]);
    await expect(dial(page).count).toHaveText("0/9");
  });
});

test.describe("stopping a run", () => {
  test("sends CANCEL_COMPARISON, returns to idle, confirms in a toast and ignores the late reply", async ({
    page
  }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await startRun(page);
    const step = progressStep(scn, "DE", "READ");
    await emitProgress(page, step);
    await expect(dial(page).count).toHaveText("3/9");

    await page.getByRole("button", { name: "Stop checking" }).click();

    await expect.poll(() => sentMessages(page, CANCEL_COMPARISON)).toEqual([
      { type: CANCEL_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } }
    ]);
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");
    await expect(page.getByRole("heading", { level: 3, name: source.title })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop checking" })).toHaveCount(0);
    await expectToastShown(page, "Stopped. No background tabs left open.");

    await emitProgress(page, progressStep(scn, "FR", "OPEN"));
    await emitResult(page, resultPayload(scenario({ results: step.results ?? [], error: CANCELLED })));

    await expect(runButton(page)).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    await expect(page.getByText("Every marketplace")).toHaveCount(0);
    await expect(dial(page).count).toHaveCount(0);

    await expectToastHidden(page);
  });
});

test.describe("settings", () => {
  test("switching to EUR persists the choice and re-renders every total", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expect(page.locator("#b-seg").getByRole("button")).toHaveText(["USD", "EUR", "GBP", "JPY"]);
    await expect(page.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "EUR" }).click();

    await expect(page.getByRole("button", { name: "EUR" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => storedSettings(page)).toEqual({ ...DEFAULT_SETTINGS, comparisonCurrency: "EUR" });

    await page.getByRole("button", { name: "Close settings" }).click();

    await expect(verdictCard(page).getByText("Save €47.17")).toBeVisible();
    await expect(verdictCard(page).locator(".lede")).toHaveText(
      "Buy from Germany for €323.19 delivered — 13% less than the €370.36 you would pay here. Item, shipping and import fees included."
    );
    await expect(page.getByText("EUR delivered")).toBeVisible();
    await expect(listRows(page).locator(".amt strong")).toHaveText([
      "€323.19",
      "€334.60",
      "€344.59",
      "€362.44",
      "€370.36",
      "€406.22"
    ]);
    await expect(listRows(page).locator(".amt > span")).toHaveText([
      `${MINUS}€47.17`,
      `${MINUS}€35.76`,
      `${MINUS}€25.77`,
      `${MINUS}€7.92`,
      "the page you are on",
      "+€35.86"
    ]);

    await listRow(page, "Germany").click();
    await expect(page.getByRole("dialog").locator(".dB-line.conv b")).toHaveText("€323.19 at today’s rate");
  });

  test("a currency stored from an earlier session is used at load", async ({ page }) => {
    const scn = scenario({ settings: { comparisonCurrency: "GBP" } });
    await openPopup(page, scn);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "GBP" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Close settings" }).click();

    await completeRun(page, scn);

    await expect(verdictCard(page).getByText("Save £40.19")).toBeVisible();
    await expect(page.getByText("GBP delivered")).toBeVisible();
    await expect(listRows(page).first().locator(".amt strong")).toHaveText("£275.36");
  });

  test("toggling a marketplace persists the list and changes the run button count", async ({ page }) => {
    await openPopup(page);
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");

    await page.getByRole("button", { name: "Settings" }).click();
    const checkboxes = page.getByRole("checkbox");
    await expect(checkboxes).toHaveCount(9);
    const germany = page.getByRole("checkbox", { name: "🇩🇪 Germany" });
    await expect(germany).toBeChecked();

    await germany.uncheck();

    await expect(germany).not.toBeChecked();
    await expect(page.locator("label", { has: germany })).toHaveClass(/\boff\b/);
    await expect
      .poll(() => storedSettings(page))
      .toEqual({ ...DEFAULT_SETTINGS, enabledMarketplaces: MARKETPLACE_CODES.filter((code) => code !== "DE") });

    await page.getByRole("button", { name: "Close settings" }).click();

    await expect(runButton(page)).toHaveText("Check 8 other Amazons");
    await expect(page.getByText(/^Takes about 24 seconds\./)).toBeVisible();

    await startRun(page);
    await expect(dial(page).count).toHaveText("0/8");
  });

  test("stays open while progress and the result arrive, then returns to the latest view", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await startRun(page);
    await emitProgress(page, progressStep(scn, "MX", "OPEN"));

    await page.getByRole("button", { name: "Settings" }).click();
    await emitProgress(page, progressStep(scn, "IT", "MATCH"));

    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop checking" })).toHaveCount(0);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(dial(page).count).toHaveText("5/9");
    await expect(dial(page).nowline).toHaveText("Matching product Italy");

    await page.getByRole("button", { name: "Settings" }).click();
    await emitResult(page, resultPayload(scn));

    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expect(page.getByText("Save $50.94")).toHaveCount(0);
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
  });

  test("with no marketplace left the run button only shows a toast", async ({ page }) => {
    await openPopup(page, scenario({ settings: { enabledMarketplaces: ["US", "DE"] } }));
    await expect(runButton(page)).toHaveText("Check 1 other Amazon");

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("checkbox", { name: "🇩🇪 Germany" }).uncheck();
    await expect.poll(() => storedSettings(page)).toEqual({ ...DEFAULT_SETTINGS, enabledMarketplaces: ["US"] });
    await page.getByRole("button", { name: "Close settings" }).click();

    await expect(runButton(page)).toHaveText("Check 0 other Amazons");
    await runButton(page).click();

    await expectToastShown(page, "Pick at least one marketplace to check.");
    await expect(runButton(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop checking" })).toHaveCount(0);
    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([]);

    await expectToastHidden(page);
  });
});

test.describe("not on an Amazon product page", () => {
  test("shows the notice and a disabled run button when the page is not supported", async ({ page }) => {
    await openPopup(page, scenario({ loadSourceError: "Unsupported marketplace hostname" }));

    await expect(page.getByText("Open an Amazon product page")).toBeVisible();
    await expect(
      page.getByText(
        "Across Amazon compares the delivered price of the product you are looking at across other Amazon marketplaces."
      )
    ).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(page.getByText(/^Takes about/)).toHaveCount(0);
    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([]);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("checkbox")).toHaveCount(10);
  });

  test("shows the notice without asking the background when there is no active tab", async ({ page }) => {
    await openPopup(page, scenario({ activeTabId: null }));

    await expect(page.getByText("Open an Amazon product page")).toBeVisible();
    await expect(runButton(page)).toBeDisabled();
    expect(await sentMessages(page)).toEqual([]);
  });
});

test.describe("keyboard", () => {
  test("Tab reaches a row, Enter opens its sheet and Escape closes it back onto the row", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    const gear = page.getByRole("button", { name: "Settings" });
    const verdictOpen = verdictCard(page).getByRole("button", { name: "Open on amazon.de" });
    const germany = listRow(page, "Germany");

    await gear.focus();
    await page.keyboard.press("Tab");
    await expect(verdictOpen).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(germany).toBeFocused();

    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "🇩🇪 Germany" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(sheet.getByRole("button", { name: "Open on amazon.de" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(germany).toBeFocused();
    expect(await openedUrls(page)).toEqual([]);
  });
});
