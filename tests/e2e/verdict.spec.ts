import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { MARKETPLACE_CODES } from "../../src/shared/markets";
import { CANCEL_COMPARISON, LOAD_SOURCE, RUN_COMPARISON } from "../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  AMAZON_NON_PRODUCT_URL,
  BACKGROUND_UNREACHABLE,
  CANCELLED,
  DEFAULT_SETTINGS,
  EXTRACTION_FAILURE,
  FX_FAILURE,
  MINUS,
  NBSP,
  NON_AMAZON_URL,
  OTHER_TAB_ID,
  cheapBaseline,
  completeRun,
  emitProgress,
  emitResult,
  emittedMessages,
  emittedTypes,
  es,
  failRun,
  finalStep,
  finishedStep,
  fr,
  fxTable,
  jp,
  listRow,
  listRows,
  loadingHint,
  mx,
  openPopup,
  openedUrls,
  productUrl,
  progressStep,
  progressSteps,
  releaseLoadSource,
  resultPayload,
  runButton,
  runIds,
  scenario,
  scrollArea,
  sentMessages,
  sortedResults,
  source,
  startRun,
  storedSettings,
  toast,
  verdictCard
} from "./harness";
import type { RunFailure } from "./harness";

test.use({ viewport: { width: 400, height: 560 } });

const RUN_REQUEST = { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId: expect.any(String) } };
const TOAST_HIDE_TIMEOUT = 5_000;
const TOAST_GUTTER = 16;
const POPUP_WIDTH = 400;

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

const ISSUES_IN_ORDER = {
  flags: ["🇲🇽", "🇫🇷", "🇪🇸", "🇯🇵"],
  titles: [
    "Mexico — No confident match",
    "France — Delivered total not quotable",
    "Spain — Could not read the page",
    "Japan — Could not set delivery location"
  ],
  notes: [
    "No listing scored above the confidence floor.",
    "Amazon did not show a delivered price to United States.",
    "The product page could not be read.",
    "Could not set this store's delivery location to United States, so its price is for another place."
  ]
};

const CONFIDENT_TRUST = "We are 91% sure this is the same product — title, brand and variant all line up.";
const SOURCE_TRUST = "This is the page you are on. Prices are what Amazon showed when we checked.";
const MATCH_CHECK_SENTENCE = "Confirm it is the same product before you buy.";
const NOTICE_TITLE = "Open an Amazon product page";

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
  const shown = toast(page);
  await expect(shown).toHaveText(text);
  await expect(shown).toHaveClass(/\bis-on\b/);
  await expect(shown).not.toHaveAttribute("aria-hidden");
  await expect(page.getByRole("status")).toHaveText(text);
  await expect(shown).toHaveCSS("opacity", "1");
  const box = await shown.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? 0).toBeGreaterThanOrEqual(TOAST_GUTTER - 0.5);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(POPUP_WIDTH - TOAST_GUTTER + 0.5);
}

async function expectToastHidden(page: Page): Promise<void> {
  await expect(toast(page)).not.toHaveClass(/\bis-on\b/, { timeout: TOAST_HIDE_TIMEOUT });
  await expect(toast(page)).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(toast(page)).toHaveCSS("opacity", "0");
}

function dispatchEscape(page: Page) {
  return page.evaluate(() => {
    let reachedWindow = false;
    const onWindowKeyDown = (): void => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", onWindowKeyDown);
    const target = document.activeElement ?? document.body;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const notCancelled = target.dispatchEvent(event);
    window.removeEventListener("keydown", onWindowKeyDown);
    return {
      defaultPrevented: event.defaultPrevented,
      notCancelled,
      reachedWindow,
      fromSheet: target.classList.contains("dB-sheet")
    };
  });
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
        "Takes about 15 seconds. Each Amazon’s pages are downloaded in the background, so we can read its real delivered price to United States. Its delivery location may be set to United States and is left that way after the check."
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
    await expect(running.nowline).toHaveText("Checking Canada +2");
    await expect(running.nowline).toHaveAttribute("aria-live", "polite");
    await expect(running.nowsub).toHaveText("amazon.ca");
    await expect(running.chips).toHaveText(["🇨🇦 CA …", "🇲🇽 MX …", "🇬🇧 UK …"]);
    await expect(running.chips).toHaveClass(["dB-chk now", "dB-chk now", "dB-chk now"]);
    await expect(page.getByText("ECB daily rates")).toBeVisible();

    await emitProgress(page, progressStep(scn, "CA", "SEARCH"));
    await expect(running.nowline).toHaveText("Searching Canada +2");
    await expect(running.count).toHaveText("0/9");
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();
    await expect(page.getByText("ECB daily rates")).toHaveCount(0);

    await emitProgress(page, progressStep(scn, "FR", "MATCH"));
    await expect(running.count).toHaveText("3/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*33%/);
    await expect(running.nowline).toHaveText("Matching product France +2");
    await expect(page.locator(".dB-nowline b")).toHaveText("France");
    await expect(running.nowsub).toHaveText("amazon.fr");
    await expect(running.chips).toHaveText([
      "🇨🇦 CA $391.44",
      "🇲🇽 MX —",
      "🇬🇧 UK $372.16",
      "🇩🇪 DE …",
      "🇫🇷 FR …",
      "🇮🇹 IT …"
    ]);
    await expect(running.chips).toHaveClass([
      "dB-chk ok",
      "dB-chk bad",
      "dB-chk ok",
      "dB-chk now",
      "dB-chk now",
      "dB-chk now"
    ]);

    await emitProgress(page, progressStep(scn, "AU", "READ"));
    await expect(running.count).toHaveText("6/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*67%/);
    await expect(running.nowline).toHaveText("Reading cost stack Australia +2");
    await expect(running.nowsub).toHaveText("amazon.com.au");
    await expect(running.chips).toHaveCount(9);
    await expect(running.chips.last()).toHaveText("🇦🇺 AU …");

    await emitProgress(page, finalStep(scn));
    await expect(running.count).toHaveText("9/9");
    await expect(running.ring).toHaveAttribute("style", /--p:\s*100%/);
    await expect(page.locator(".dB-chk.now")).toHaveCount(0);
    await expect(running.chips).toHaveText([
      "🇨🇦 CA $391.44",
      "🇲🇽 MX —",
      "🇬🇧 UK $372.16",
      "🇩🇪 DE $349.05",
      "🇫🇷 FR —",
      "🇮🇹 IT $361.37",
      "🇪🇸 ES —",
      "🇯🇵 JP —",
      "🇦🇺 AU $438.72"
    ]);
    await expect(running.chips).toHaveClass([
      "dB-chk ok",
      "dB-chk bad",
      "dB-chk ok",
      "dB-chk ok",
      "dB-chk bad",
      "dB-chk ok",
      "dB-chk bad",
      "dB-chk bad",
      "dB-chk ok"
    ]);
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();

    await emitResult(page, resultPayload(scn));

    const card = verdictCard(page);
    await expect(card.locator(".eyebrow")).toHaveText("Cheapest delivered to United States");
    await expect(card.locator(".dB-flag-pill")).toHaveCount(0);
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
    await expect(sheet.locator(".sub")).toHaveText("amazon.de");
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
    await expect(trust).toHaveText(CONFIDENT_TRUST);
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
    await expect(issues.locator(".flag")).toHaveText(ISSUES_IN_ORDER.flags);
    await expect(issues.locator("strong")).toHaveText(ISSUES_IN_ORDER.titles);
    await expect(issues.locator("p")).toHaveText(ISSUES_IN_ORDER.notes);
    for (const issue of await issues.all()) {
      await expect(issue).toBeVisible();
    }

    await accordion.click();
    await expect(accordion).toHaveAttribute("aria-expanded", "false");
    await expect(issues.first()).toBeHidden();

    await page.getByRole("button", { name: "Check again" }).click();
    expect(await sentMessages(page, RUN_COMPARISON)).toEqual([RUN_REQUEST, RUN_REQUEST]);
    expect(new Set(await runIds(page)).size).toBe(2);
    await expect(running.count).toHaveText("0/9");
    await expect(running.nowline).toHaveText("Checking Canada +2");
    await expect(running.chips).toHaveText(["🇨🇦 CA …", "🇲🇽 MX …", "🇬🇧 UK …"]);
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
    expect(progressSteps(scn)).toHaveLength(9 * 4 + 8 + 1);

    const [runId] = await runIds(page);
    const payloads = (await emittedMessages(page)).map((message) => message.payload);
    expect(payloads).toEqual(
      payloads.map(() => expect.objectContaining({ activeTabId: ACTIVE_TAB_ID, runId, fxTable }))
    );
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
    await expect(sheet.locator(".sub")).toHaveText("amazon.it");
    await expect(sheet.locator(".dB-trust")).toHaveClass(/\bwarn\b/);
    await expect(sheet.locator(".dB-trust")).toHaveText("We are 76% sure this is the same product.");
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
    await expect(sheet.locator(".sub")).toHaveText(`${source.title} — Black`);
    await expect(sheet.locator(".dB-line > b")).toHaveText([
      "$399.99",
      "Free",
      "—",
      "$399.99",
      "$399.99 at today’s rate"
    ]);
    await expect(sheet.locator(".dB-trust")).toHaveText(SOURCE_TRUST);
    await expect(sheet.locator(".dB-trust")).not.toHaveClass(/\bwarn\b/);
    await expect(sheet.getByRole("button", { name: /^Open on/ })).toHaveCount(0);

    await sheet.getByRole("button", { name: "Close" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await openedUrls(page)).toEqual([]);
  });

  test("consumes Escape while open and leaves it to the page once closed", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await listRow(page, "Germany").click();
    await expect(page.getByRole("dialog", { name: "🇩🇪 Germany" })).toBeFocused();

    expect(await dispatchEscape(page)).toEqual({
      defaultPrevented: true,
      notCancelled: false,
      reachedWindow: false,
      fromSheet: true
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(listRow(page, "Germany")).toBeFocused();

    expect(await dispatchEscape(page)).toEqual({
      defaultPrevented: false,
      notCancelled: true,
      reachedWindow: true,
      fromSheet: false
    });
    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
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
    expect(new Set(await runIds(page)).size).toBe(2);
    await expect(dial(page).count).toHaveText("0/9");
  });
});

test.describe("a low-confidence best match", () => {
  const withoutGermany = sortedResults.filter((result) => result.marketplace !== "DE");

  test("flags the saving verdict with a Check match pill and asks to confirm the product", async ({ page }) => {
    const scn = scenario({ results: withoutGermany });
    await openPopup(page, scn);
    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card).not.toHaveClass(/\bis-muted\b/);
    await expect(card.locator(".eyebrow")).toContainText("Cheapest delivered to United States");
    await expect(card.locator(".eyebrow .dB-flag-pill")).toHaveText("Check match");
    await expect(card.locator(".dB-save")).toHaveText("Save $38.62");
    await expect(card.locator(".lede")).toHaveText(
      `Buy from Italy for $361.37 delivered — 10% less than the $399.99 you would pay here. Item, shipping and import fees included. ${MATCH_CHECK_SENTENCE}`
    );
    await expect(card.getByRole("button", { name: "Open on amazon.it" })).toBeVisible();

    const best = page.locator(".dB-row.best");
    await expect(best).toHaveCount(1);
    await expect(best).toContainText("Italy");
    await expect(best.locator(".dB-flag-pill")).toHaveText("Check match");
  });

  test("flags the cheapest verdict too when the page price could not be read", async ({ page }) => {
    const scn = scenario({ baseline: undefined, results: withoutGermany });
    await openPopup(page, scn);
    await completeRun(page, scn);

    const card = verdictCard(page);
    await expect(card.locator(".eyebrow .dB-flag-pill")).toHaveText("Check match");
    await expect(card.locator(".dB-save")).toHaveText("$361.37");
    await expect(card.locator(".lede")).toHaveText(
      `Buy from Italy for $361.37 delivered. Item, shipping and import fees included. We could not read the price on this page to compare. ${MATCH_CHECK_SENTENCE}`
    );
  });
});

test.describe("when the background service cannot be reached", () => {
  const failures: Array<{ failure: RunFailure; label: string }> = [
    { failure: "reject", label: "the run request is rejected" },
    { failure: "no-response", label: "the run request gets no response" }
  ];

  for (const { failure, label } of failures) {
    test(`shows the error card with the markets checked so far when ${label}`, async ({ page }) => {
      const scn = scenario();
      await openPopup(page, scn);
      await startRun(page);
      await emitProgress(page, finishedStep(scn, "MX"));
      await expect(dial(page).count).toHaveText("2/9");

      await failRun(page, failure);

      const card = verdictCard(page);
      await expect(card).toHaveClass(/\bis-muted\b/);
      await expect(card.locator(".eyebrow")).toHaveText("Something went wrong");
      await expect(card.locator(".dB-save")).toHaveText("Couldn't compare");
      await expect(card.locator(".lede")).toHaveText(BACKGROUND_UNREACHABLE);
      await expect(page.getByRole("button", { name: "Stop checking" })).toHaveCount(0);
      await expect(listRows(page)).toHaveText([/Canada/, /United States/]);
      await expect(listRows(page).locator(".amt strong")).toHaveText(["$391.44", "$399.99"]);
      await expect(page.getByRole("button", { name: "1 marketplace could not be compared" })).toBeVisible();

      await page.getByRole("button", { name: "Check again" }).click();

      expect(await sentMessages(page, RUN_COMPARISON)).toEqual([RUN_REQUEST, RUN_REQUEST]);
      await expect(dial(page).count).toHaveText("0/9");
      await expect(page.getByText(BACKGROUND_UNREACHABLE)).toHaveCount(0);
    });
  }
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
    await expectToastShown(page, "Stopped.");

    await emitProgress(page, progressStep(scn, "FR", "OPEN"));
    await emitResult(page, resultPayload(scenario({ results: step.results ?? [], error: CANCELLED })));

    await expect(runButton(page)).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    await expect(page.getByText("Every marketplace")).toHaveCount(0);
    await expect(dial(page).count).toHaveCount(0);

    await expectToastHidden(page);
  });

  test("ignores a late result from the stopped run once the user has started a new one", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await startRun(page);
    const stopped = progressStep(scn, "DE", "READ");
    await emitProgress(page, stopped);
    await expect(dial(page).count).toHaveText("3/9");

    await page.getByRole("button", { name: "Stop checking" }).click();
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");

    await startRun(page);
    const [stoppedRun, currentRun] = await runIds(page);
    expect(currentRun).not.toBe(stoppedRun);

    await emitResult(page, {
      ...resultPayload(scenario({ results: stopped.results ?? [], error: CANCELLED })),
      runId: stoppedRun
    });
    await emitProgress(page, { ...progressStep(scn, "FR", "OPEN"), runId: stoppedRun });

    const running = dial(page);
    await expect(running.count).toHaveText("0/9");
    await expect(running.nowline).toHaveText("Checking Canada +2");
    await expect(running.chips).toHaveText(["🇨🇦 CA …", "🇲🇽 MX …", "🇬🇧 UK …"]);
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    await expect(page.getByText(CANCELLED)).toHaveCount(0);

    await emitProgress(page, progressStep(scn, "CA", "SEARCH"));
    await expect(running.nowline).toHaveText("Searching Canada +2");

    await emitResult(page, resultPayload(scn));
    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
    await expect(listRows(page).locator(".amt strong")).toHaveText(USD_ROWS.totals);
  });
});

test.describe("another tab's comparison", () => {
  test("never moves this popup, whether idle or running", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);

    await emitProgress(page, { ...progressStep(scn, "DE", "MATCH"), activeTabId: OTHER_TAB_ID });
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");
    await expect(dial(page).count).toHaveCount(0);

    await startRun(page);
    await emitProgress(page, { ...progressStep(scn, "FR", "MATCH"), activeTabId: OTHER_TAB_ID });
    await emitResult(page, { ...resultPayload(scn), activeTabId: OTHER_TAB_ID });

    const running = dial(page);
    await expect(running.count).toHaveText("0/9");
    await expect(running.nowline).toHaveText("Checking Canada +2");
    await expect(running.chips).toHaveText(["🇨🇦 CA …", "🇲🇽 MX …", "🇬🇧 UK …"]);
    await expect(page.getByText("ECB daily rates")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);

    await emitProgress(page, progressStep(scn, "CA", "SEARCH"));
    await expect(running.nowline).toHaveText("Searching Canada +2");
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();
  });
});

test.describe("settings", () => {
  test("switching to EUR persists it, re-renders every total, and the page currency is saved as SOURCE", async ({
    page
  }) => {
    await openPopup(page);
    await completeRun(page);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    const segments = page.getByRole("group", { name: "Show prices in" }).getByRole("button");
    await expect(segments).toHaveText(["USD", "EUR", "GBP", "JPY"]);
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
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "USD" }).click();

    await expect(page.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => storedSettings(page)).toEqual({ ...DEFAULT_SETTINGS, comparisonCurrency: "SOURCE" });

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(verdictCard(page).getByText("Save $50.94")).toBeVisible();
    await expect(listRows(page).locator(".amt strong")).toHaveText(USD_ROWS.totals);
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

  test("offers and selects a stored currency outside the default choices", async ({ page }) => {
    const scn = scenario({ settings: { comparisonCurrency: "CAD" } });
    await openPopup(page, scn);

    await page.getByRole("button", { name: "Settings" }).click();
    const segments = page.getByRole("group", { name: "Show prices in" }).getByRole("button");
    await expect(segments).toHaveText(["USD", "EUR", "GBP", "JPY", "CAD"]);
    await expect(page.getByRole("button", { name: "CAD" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Close settings" }).click();

    await completeRun(page, scn);

    await expect(verdictCard(page).getByText("Save CA$69.57")).toBeVisible();
    await expect(page.getByText("CAD delivered")).toBeVisible();
    await expect(listRows(page).first().locator(".amt strong")).toHaveText("CA$476.71");
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
    await expect(page.getByText(/^Takes about 15 seconds\./)).toBeVisible();

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
    await expect(dial(page).count).toHaveText("3/9");
    await expect(dial(page).nowline).toHaveText("Matching product Italy +2");

    await page.getByRole("button", { name: "Settings" }).click();
    const japan = page.getByRole("checkbox", { name: "🇯🇵 Japan" });
    await japan.focus();
    await emitProgress(page, progressStep(scn, "AU", "OPEN"));
    await emitResult(page, resultPayload(scn));

    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expect(page.getByText("Save $50.94")).toHaveCount(0);
    await expect(page.getByText("Rates 2026-07-30")).toBeVisible();
    await expect(japan).toBeFocused();

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

test.describe("while the page is being read", () => {
  test("shows a reading hint until LOAD_SOURCE answers, then the product card", async ({ page }) => {
    await openPopup(page, scenario({ holdLoadSource: true }));

    await expect(loadingHint(page)).toBeVisible();
    await expect(runButton(page)).toHaveCount(0);
    await expect(page.getByText(NOTICE_TITLE)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);

    await releaseLoadSource(page);

    await expect(page.getByRole("heading", { level: 3, name: source.title })).toBeVisible();
    await expect(loadingHint(page)).toHaveCount(0);
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");
    await expect(runButton(page)).toBeEnabled();
  });
});

test.describe("not on an Amazon product page", () => {
  const unsupportedTabs: Array<{ label: string; tabUrl?: string }> = [
    { label: "a site that is not Amazon", tabUrl: NON_AMAZON_URL },
    { label: "a tab without a URL", tabUrl: undefined }
  ];

  for (const { label, tabUrl } of unsupportedTabs) {
    test(`shows the notice without asking the background for ${label}`, async ({ page }) => {
      await openPopup(page, scenario({ tabUrl }));

      await expect(page.getByText(NOTICE_TITLE)).toBeVisible();
      await expect(
        page.getByText(
          "Across Amazon compares the delivered price of the product you are looking at across other Amazon marketplaces."
        )
      ).toBeVisible();
      await expect(runButton(page)).toHaveText("Check other Amazons");
      await expect(runButton(page)).toBeDisabled();
      await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
      await expect(page.getByText(/^Takes about/)).toHaveCount(0);
      await expect(loadingHint(page)).toHaveCount(0);
      expect(await sentMessages(page)).toEqual([]);

      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByRole("checkbox")).toHaveCount(10);
    });
  }

  test("shows the notice when an Amazon page has no product to read", async ({ page }) => {
    await openPopup(page, scenario({ tabUrl: AMAZON_NON_PRODUCT_URL, loadSourceError: EXTRACTION_FAILURE }));

    await expect(page.getByText(NOTICE_TITLE)).toBeVisible();
    await expect(runButton(page)).toHaveText("Check other Amazons");
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
    await expect(page.getByText(EXTRACTION_FAILURE)).toHaveCount(0);
    expect(await sentMessages(page)).toEqual([{ type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } }]);
  });

  test("shows the notice without asking the background when there is no active tab", async ({ page }) => {
    await openPopup(page, scenario({ activeTabId: null }));

    await expect(page.getByText(NOTICE_TITLE)).toBeVisible();
    await expect(runButton(page)).toHaveText("Check other Amazons");
    await expect(runButton(page)).toBeDisabled();
    expect(await sentMessages(page)).toEqual([]);
  });
});

test.describe("focus", () => {
  test("lands on the new content after every view swap but not when the popup first opens", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await expect(runButton(page)).toBeEnabled();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);

    await startRun(page);
    await expect(scrollArea(page)).toBeFocused();
    await emitProgress(page, progressStep(scn, "UK", "SEARCH"));
    await expect(dial(page).nowline).toHaveText("Searching United Kingdom +2");
    await expect(scrollArea(page)).toBeFocused();

    await page.getByRole("button", { name: "Stop checking" }).click();
    await expect(runButton(page)).toBeVisible();
    await expect(scrollArea(page)).toBeFocused();

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expect(scrollArea(page)).toBeFocused();

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(runButton(page)).toBeVisible();
    await expect(scrollArea(page)).toBeFocused();

    await completeRun(page, scn);
    await expect(scrollArea(page)).toBeFocused();
    await expect(scrollArea(page)).toHaveAttribute("tabindex", "-1");
  });
});

test.describe("keyboard", () => {
  test("Tab from the verdict reaches a row, Enter opens its sheet and Escape closes it back onto the row", async ({
    page
  }) => {
    await openPopup(page);
    await completeRun(page);
    await expect(scrollArea(page)).toBeFocused();

    const verdictOpen = verdictCard(page).getByRole("button", { name: "Open on amazon.de" });
    const germany = listRow(page, "Germany");

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
