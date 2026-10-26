import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  NON_AMAZON_URL,
  brandMark,
  cheapBaseline,
  completeRun,
  emitProgress,
  emitResult,
  listRow,
  openPopup,
  progressStep,
  resultPayload,
  runButton,
  scenario,
  scrollArea,
  sortedResults,
  startRun,
  verdictCard
} from "./harness";

test.use({ viewport: { width: 400, height: 560 } });

const POPUP_WIDTH = 400;
const POPUP_HEIGHT = 560;
const ACCENT = "rgb(14, 124, 102)";
const WHITE = "rgb(255, 255, 255)";
const IDENTITY = "matrix(1, 0, 0, 1, 0, 0)";
const SHEET_TRANSITION_MS = 260;
const SNAPSHOT = { animations: "disabled", caret: "hide" } as const;
const TOAST_GUTTER = 16;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ScrollMetrics {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

interface SheetOpening {
  transitionDurations: number[];
  transformAfterTwoFrames: string;
  scrimOpacityAfterTwoFrames: string;
}

function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

function scrollMetrics(locator: Locator): Promise<ScrollMetrics> {
  return locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight
  }));
}

function computed(locator: Locator, property: string): Promise<string> {
  return locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name).trim(), property);
}

function parseMatrix(transform: string): number[] {
  const match = /^matrix\((.+)\)$/.exec(transform);
  if (!match) {
    throw new Error(`Expected a 2D matrix transform, received "${transform}"`);
  }
  return match[1].split(",").map((part) => Number(part.trim()));
}

function sheet(page: Page): Locator {
  return page.locator(".dB-sheet");
}

function scrim(page: Page): Locator {
  return page.locator(".dB-scrim");
}

function sheetTransform(page: Page): Promise<string> {
  return computed(sheet(page), "transform");
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

async function expectNoPageScroll(page: Page): Promise<void> {
  const exact = {
    clientWidth: POPUP_WIDTH,
    clientHeight: POPUP_HEIGHT,
    scrollWidth: POPUP_WIDTH,
    scrollHeight: POPUP_HEIGHT
  };
  expect(await scrollMetrics(page.locator("html"))).toEqual(exact);
  expect(await scrollMetrics(page.locator("body"))).toEqual(exact);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
}

async function scrollToBottom(page: Page): Promise<void> {
  await scrollArea(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      scrollArea(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
    )
    .toBeLessThanOrEqual(1);
}

async function expectSheetClosed(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const [a, b, c, d, tx, ty] = parseMatrix(await sheetTransform(page));
      const height = await sheet(page).evaluate((element: HTMLElement) => element.offsetHeight);
      return { linear: [a, b, c, d, tx], shiftedBy: Number((ty / height).toFixed(2)) };
    })
    .toEqual({ linear: [1, 0, 0, 1, 0], shiftedBy: 1.02 });
  const box = await boxOf(sheet(page));
  expect(box.y).toBeGreaterThanOrEqual(POPUP_HEIGHT);
  await expect(scrim(page)).toHaveCSS("opacity", "0");
  await expect(scrim(page)).toHaveCSS("pointer-events", "none");
}

async function expectSheetOpen(page: Page): Promise<void> {
  await expect.poll(() => sheetTransform(page)).toBe(IDENTITY);
  const box = await boxOf(sheet(page));
  expect(box.y + box.height).toBeCloseTo(POPUP_HEIGHT, 1);
  expect(box.y).toBeGreaterThan(0);
  await expect(scrim(page)).toHaveCSS("opacity", "1");
  await expect(scrim(page)).toHaveCSS("pointer-events", "auto");
}

function openSheetFromBestRow(page: Page): Promise<SheetOpening> {
  return page.evaluate(async () => {
    const row = document.querySelector<HTMLButtonElement>(".dB-row.best");
    const panel = document.querySelector<HTMLElement>(".dB-sheet");
    const overlay = document.querySelector<HTMLElement>(".dB-scrim");
    if (!row || !panel || !overlay) {
      throw new Error("The done view is not rendered");
    }
    row.click();
    while (!panel.classList.contains("is-on")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const transitionDurations = panel
      .getAnimations()
      .map((animation) => Number(animation.effect?.getTiming().duration ?? 0));
    for (let frame = 0; frame < 2; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      transitionDurations,
      transformAfterTwoFrames: getComputedStyle(panel).transform,
      scrimOpacityAfterTwoFrames: getComputedStyle(overlay).opacity
    };
  });
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  const focused = (): Promise<boolean> => target.evaluate((element) => element === document.activeElement);
  for (let press = 0; press < 5 && !(await focused()); press += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

function matchesFocusVisible(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.matches(":focus-visible"));
}

async function finishRun(page: Page): Promise<void> {
  await emitResult(page, resultPayload(scenario()));
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
}

async function expectThumbnailLoaded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator(".dB-thumb img")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
    )
    .toBe(true);
}

test.describe("popup frame", () => {
  test("sizes the document to exactly 400×560 even when the window is larger", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openPopup(page);
    await completeRun(page);

    for (const selector of ["html", "body", ".dB"]) {
      const frame = page.locator(selector);
      expect(await boxOf(frame)).toEqual({ x: 0, y: 0, width: POPUP_WIDTH, height: POPUP_HEIGHT });
      await expect(frame).toHaveCSS("width", `${POPUP_WIDTH}px`);
      await expect(frame).toHaveCSS("height", `${POPUP_HEIGHT}px`);
      await expect(frame).toHaveCSS("overflow", "hidden");
    }
    await expect(page.locator("body")).toHaveCSS("margin", "0px");
    await expect(page.locator("body")).toHaveCSS("background-color", WHITE);
    await expect(page.locator(".dB")).toHaveCSS("display", "flex");
    await expect(page.locator(".dB")).toHaveCSS("flex-direction", "column");
  });

  test("shows the 48 px extension icon as a 22 px header mark", async ({ page }) => {
    await openPopup(page);

    const mark = brandMark(page);
    await expect(mark).toHaveAttribute("alt", "");
    expect(await mark.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([
      48, 48
    ]);
    const box = await boxOf(mark);
    expect({ width: box.width, height: box.height }).toEqual({ width: 22, height: 22 });
    const name = await boxOf(page.locator(".dB-brand"));
    expect(box.y + box.height / 2).toBeCloseTo(name.y + name.height / 2, 0);
  });

  test("never scrolls the page itself in any view", async ({ page }) => {
    await openPopup(page);
    await expect(runButton(page)).toBeVisible();
    await expectNoPageScroll(page);

    await startRun(page);
    await emitProgress(page, progressStep(scenario(), "DE", "MATCH"));
    await expectNoPageScroll(page);

    await finishRun(page);
    await page.getByRole("button", { name: "4 marketplaces could not be compared" }).click();
    await scrollToBottom(page);
    await expectNoPageScroll(page);

    await listRow(page, "Germany").click();
    await expectSheetOpen(page);
    await expectNoPageScroll(page);

    await page.keyboard.press("Escape");
    await expectSheetClosed(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Show prices in" })).toBeVisible();
    await expectNoPageScroll(page);
  });

  test("keeps the top bar and footer fixed while only the content scrolls", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    const top = page.locator(".dB-top");
    const foot = page.locator(".dB-foot");
    const content = scrollArea(page);
    await expect(content).toHaveCSS("overflow-y", "auto");
    await expect(top).toHaveCSS("flex-shrink", "0");
    await expect(foot).toHaveCSS("flex-shrink", "0");

    const metrics = await scrollMetrics(content);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    const topBefore = await boxOf(top);
    const footBefore = await boxOf(foot);
    expect(topBefore.y).toBe(0);
    expect(footBefore.y + footBefore.height).toBeCloseTo(POPUP_HEIGHT, 1);

    const contentBox = await boxOf(content);
    await page.mouse.move(contentBox.x + contentBox.width / 2, contentBox.y + contentBox.height / 2);
    await page.mouse.wheel(0, 2_000);
    await expect
      .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1);
    expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    expect(await boxOf(top)).toEqual(topBefore);
    expect(await boxOf(foot)).toEqual(footBefore);
    await expect(page.getByRole("button", { name: "Check again" })).toBeInViewport();
    await expectNoPageScroll(page);
  });
});

test.describe("buttons", () => {
  test("renders the primary call to action in the accent colour", async ({ page }) => {
    await openPopup(page);
    await parkPointer(page);
    const cta = runButton(page);

    await expect(cta).toHaveClass("dB-cta");
    await expect(cta).toHaveCSS("background-color", ACCENT);
    await expect(cta).toHaveCSS("color", WHITE);
    await expect(cta).toHaveCSS("border-radius", "11px");
    await expect(cta).toHaveCSS("font-size", "15px");
    await expect(cta).toHaveCSS("font-weight", "600");
    await expect(cta).toHaveCSS("padding", "14px");
    await expect(cta).toHaveCSS("border-style", "none");
    await expect(cta).toHaveCSS("cursor", "pointer");
  });

  test("renders secondary calls to action as a pale accent tint", async ({ page }) => {
    await openPopup(page);
    await startRun(page);
    await parkPointer(page);

    const stop = page.getByRole("button", { name: "Stop checking" });
    await expect(stop).toHaveClass("dB-cta secondary");
    await expect(stop).toHaveCSS("background-color", "rgb(238, 244, 242)");
    await expect(stop).toHaveCSS("color", ACCENT);
    await expect(stop).toHaveCSS("border-radius", "11px");

    await finishRun(page);
    await parkPointer(page);
    const again = page.getByRole("button", { name: "Check again" });
    await expect(again).toHaveCSS("background-color", "rgb(238, 244, 242)");
    await expect(again).toHaveCSS("color", ACCENT);
    await expect(again).toHaveCSS("font-size", "15px");
    await expect(again).toHaveCSS("font-weight", "600");
  });

  test("dims the call to action when the tab is not an Amazon product page", async ({ page }) => {
    await openPopup(page, scenario({ tabUrl: NON_AMAZON_URL }));
    const cta = runButton(page);

    await expect(cta).toHaveText("Check other Amazons");
    await expect(cta).toBeDisabled();
    await expect(cta).toHaveCSS("opacity", "0.5");
    await expect(cta).toHaveCSS("cursor", "not-allowed");
    await expect(page.locator(".dB-notice")).toHaveCSS("border-radius", "11px");
    await expect(page.locator(".dB-notice b")).toHaveCSS("display", "block");
  });

  test("shows a 2px accent focus ring only once the keyboard reaches the call to action", async ({ page }) => {
    await openPopup(page);
    await parkPointer(page);
    const cta = runButton(page);
    await expect(cta).toBeEnabled();
    await expect(cta).toHaveCSS("outline-style", "none");

    await tabTo(page, cta);

    expect(await matchesFocusVisible(cta)).toBe(true);
    await expect(cta).toHaveCSS("outline-style", "solid");
    await expect(cta).toHaveCSS("outline-width", "2px");
    await expect(cta).toHaveCSS("outline-color", ACCENT);
    await expect(cta).toHaveCSS("outline-offset", "2px");
  });
});

test.describe("verdict card", () => {
  test("states the saving on an accent gradient in large white type", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    const card = verdictCard(page);

    await expect(card).toHaveClass("dB-verdict");
    await expect(card).toHaveCSS(
      "background-image",
      "linear-gradient(168deg, rgb(14, 124, 102) 0%, rgb(11, 100, 85) 100%)"
    );
    await expect(card).toHaveCSS("color", WHITE);
    await expect(card).toHaveCSS("border-radius", "14px");

    const save = card.locator(".dB-save");
    await expect(save).toHaveText("Save $50.94");
    await expect(save).toHaveCSS("font-size", "38px");
    await expect(save).toHaveCSS("font-weight", "660");
    await expect(save).toHaveCSS("line-height", "38px");

    const eyebrow = card.locator(".eyebrow");
    await expect(eyebrow).toHaveText("Cheapest delivered to United States");
    await expect(eyebrow).toHaveCSS("text-transform", "uppercase");
    await expect(eyebrow).toHaveCSS("font-size", "10.5px");
    await expect(eyebrow).toHaveCSS("color", "rgba(255, 255, 255, 0.72)");
    const tracking = Number.parseFloat(await computed(eyebrow, "letter-spacing"));
    expect(tracking / 10.5).toBeCloseTo(0.12, 3);

    const sectionTitle = page.locator(".dB-sectitle");
    await expect(sectionTitle).toHaveCSS("text-transform", "uppercase");
    const sectionTracking = Number.parseFloat(await computed(sectionTitle, "letter-spacing"));
    expect(sectionTracking / 10.5).toBeCloseTo(0.11, 3);

    await expect(card.locator(".dB-vbtn")).toHaveCSS("background-color", WHITE);
    await expect(card.locator(".dB-vbtn")).toHaveCSS("color", "rgb(11, 90, 75)");
  });

  test("keeps the Check match pill in sentence case inside the uppercase eyebrow", async ({ page }) => {
    const scn = scenario({ results: sortedResults.filter((result) => result.marketplace !== "DE") });
    await openPopup(page, scn);
    await completeRun(page, scn);
    const eyebrow = verdictCard(page).locator(".eyebrow");
    const pill = eyebrow.locator(".dB-flag-pill");

    await expect(eyebrow).toHaveCSS("text-transform", "uppercase");
    await expect(pill).toHaveText("Check match");
    await expect(pill).toHaveCSS("text-transform", "none");
    await expect(pill).toHaveCSS("background-color", "rgb(251, 240, 228)");
    await expect(pill).toHaveCSS("color", "rgb(153, 86, 44)");
    expect(await pill.evaluate((element: HTMLElement) => element.innerText)).toBe("Check match");
    expect(await eyebrow.evaluate((element: HTMLElement) => element.innerText)).toMatch(
      /^CHEAPEST DELIVERED TO UNITED STATES\s*Check match$/
    );
  });

  test("switches to the muted slate gradient and a smaller headline when staying is cheapest", async ({ page }) => {
    const scn = scenario({ baseline: cheapBaseline });
    await openPopup(page, scn);
    await completeRun(page, scn);
    const card = verdictCard(page);

    await expect(card).toHaveClass("dB-verdict is-muted");
    await expect(card).toHaveCSS("background-image", "linear-gradient(168deg, rgb(63, 76, 88), rgb(51, 62, 71))");
    await expect(card).toHaveCSS("color", WHITE);
    await expect(card.locator(".dB-save")).toHaveText("Stay here");
    await expect(card.locator(".dB-save")).toHaveCSS("font-size", "26px");
    await expect(card.locator(".dB-save")).toHaveCSS("font-weight", "660");
    await expect(card.locator(".eyebrow")).toHaveCSS("text-transform", "uppercase");
  });
});

test.describe("ranked list", () => {
  test("highlights only the cheapest row", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    await parkPointer(page);

    const best = page.locator(".dB-row.best");
    await expect(best).toHaveCount(1);
    await expect(best).toContainText("Germany");
    await expect(best).toHaveCSS("border-color", "rgb(182, 219, 208)");
    await expect(best).toHaveCSS("background-color", "rgb(244, 250, 248)");
    await expect(best).toHaveCSS("border-radius", "11px");

    const plain = listRow(page, "Canada");
    await expect(plain).not.toHaveClass(/\bbest\b/);
    await expect(plain).toHaveCSS("border-color", "rgb(236, 239, 238)");
    await expect(plain).toHaveCSS("background-color", WHITE);
  });

  test("colours each delta by direction", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    const down = listRow(page, "Germany").locator(".amt > span");
    await expect(down).toHaveClass("down");
    await expect(down).toHaveCSS("color", ACCENT);

    const up = listRow(page, "Australia").locator(".amt > span");
    await expect(up).toHaveClass("up");
    await expect(up).toHaveCSS("color", "rgb(152, 117, 106)");

    const flat = listRow(page, "United States").locator(".amt > span");
    await expect(flat).toHaveClass("flat");
    await expect(flat).toHaveText("the page you are on");
    await expect(flat).toHaveCSS("color", "rgb(138, 151, 147)");
  });

  test("marks the low-confidence match with an amber pill", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    const pill = listRow(page, "Italy").locator(".dB-flag-pill");
    await expect(pill).toHaveText("Check match");
    await expect(pill).toHaveCSS("background-color", "rgb(251, 240, 228)");
    await expect(pill).toHaveCSS("color", "rgb(153, 86, 44)");
    await expect(pill).toHaveCSS("border-radius", "999px");
    await expect(pill).toHaveCSS("font-size", "10px");
    await expect(page.locator(".dB-flag-pill")).toHaveCount(1);
  });
});

test.describe("progress dial", () => {
  test("fills the conic gradient to the share of marketplaces checked", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await startRun(page);

    const dialRing = page.locator(".dB-dial");
    await expect(dialRing).toHaveCSS("width", "108px");
    await expect(dialRing).toHaveCSS("height", "108px");
    await expect(dialRing).toHaveCSS("border-radius", "50%");
    await expect(dialRing).toHaveCSS("--p", "0%");
    expect(await computed(dialRing, "background-image")).toContain("conic-gradient");

    await emitProgress(page, progressStep(scn, "DE", "MATCH"));
    await expect(page.locator(".dB-dial-num")).toHaveText("3/9");
    await expect(dialRing).toHaveCSS("--p", "33%");
    const thirdDone = await computed(dialRing, "background-image");
    expect(thirdDone).toContain("conic-gradient");
    expect(thirdDone).toContain(`${ACCENT} 33%`);

    await emitProgress(page, progressStep(scn, "AU", "READ"));
    await expect(page.locator(".dB-dial-num")).toHaveText("6/9");
    await expect(dialRing).toHaveCSS("--p", "67%");
    expect(await computed(dialRing, "background-image")).toContain(`${ACCENT} 67%`);
  });
});

test.describe("detail sheet", () => {
  test("slides up from below the popup over a fading scrim", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await expect(sheet(page)).toHaveCSS("position", "absolute");
    await expect(sheet(page)).toHaveCSS("transition-duration", "0.26s");
    await expectSheetClosed(page);

    await listRow(page, "Germany").click();
    await expect(page.getByRole("dialog", { name: "🇩🇪 Germany" })).toBeVisible();
    await expectSheetOpen(page);
    await expect(sheet(page)).toHaveCSS("border-radius", "16px 16px 0px 0px");
    await expect(scrim(page)).toHaveCSS("background-color", "rgba(16, 32, 28, 0.38)");

    await page.keyboard.press("Escape");
    await expectSheetClosed(page);
  });

  test("animates the sheet over 260ms with normal motion", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    const opening = await openSheetFromBestRow(page);
    expect(opening.transitionDurations).toContain(SHEET_TRANSITION_MS);
    expect(opening.transformAfterTwoFrames).not.toBe(IDENTITY);
    await expectSheetOpen(page);
  });

  test("drops the focus outline on the sheet when the keyboard opens it", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await listRow(page, "Germany").focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "🇩🇪 Germany" });

    await expect(dialog).toBeFocused();
    expect(await matchesFocusVisible(dialog)).toBe(true);
    await expect(dialog).toHaveCSS("outline-style", "none");
  });

  test("opens the sheet instantly when the user prefers reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openPopup(page);
    await completeRun(page);

    expect(Number.parseFloat(await computed(sheet(page), "transition-duration"))).toBeLessThan(0.001);
    const opening = await openSheetFromBestRow(page);
    expect(opening.transitionDurations.every((duration) => duration < 1)).toBe(true);
    expect(opening.transformAfterTwoFrames).toBe(IDENTITY);
    expect(opening.scrimOpacityAfterTwoFrames).toBe("1");
  });
});

test.describe("content area", () => {
  test("drops the focus outline when it takes focus after a keyboard-started view swap", async ({ page }) => {
    await openPopup(page);
    await parkPointer(page);
    await tabTo(page, runButton(page));

    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Stop checking" })).toBeVisible();
    await expect(scrollArea(page)).toBeFocused();
    expect(await matchesFocusVisible(scrollArea(page))).toBe(true);
    await expect(scrollArea(page)).toHaveCSS("outline-style", "none");
  });
});

test.describe("toast", () => {
  test("fits the opening message on at most two lines within the popup gutters", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);

    await verdictCard(page).getByRole("button", { name: "Open on amazon.de" }).click();

    const shown = page.locator(".toast.is-on");
    await expect(shown).toHaveText("Opening amazon.de — you complete the purchase on Amazon.");
    await expect(shown).toHaveCSS("opacity", "1");
    const box = await boxOf(shown);
    expect(box.height).toBeLessThan(50);
    expect(box.width).toBeGreaterThan(200);
    expect(box.x).toBeGreaterThanOrEqual(TOAST_GUTTER - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(POPUP_WIDTH - TOAST_GUTTER + 0.5);
    await expect(shown).toHaveCSS("box-sizing", "border-box");
  });
});

test.describe("settings", () => {
  test("lifts the selected currency segment onto white in the accent colour", async ({ page }) => {
    await openPopup(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await parkPointer(page);

    await expect(page.locator(".dB-seg")).toHaveCSS("background-color", "rgb(242, 245, 244)");
    const usd = page.getByRole("button", { name: "USD", exact: true });
    const eur = page.getByRole("button", { name: "EUR", exact: true });

    await expect(usd).toHaveAttribute("aria-pressed", "true");
    await expect(usd).toHaveCSS("background-color", WHITE);
    await expect(usd).toHaveCSS("color", ACCENT);
    expect(await computed(usd, "box-shadow")).toContain("rgba(20, 40, 34, 0.12)");
    await expect(eur).toHaveAttribute("aria-pressed", "false");
    await expect(eur).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(eur).toHaveCSS("color", "rgb(108, 122, 118)");

    await eur.click();
    await parkPointer(page);
    await expect(eur).toHaveAttribute("aria-pressed", "true");
    await expect(eur).toHaveCSS("background-color", WHITE);
    await expect(eur).toHaveCSS("color", ACCENT);
    await expect(usd).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("greys out a marketplace tile when it is switched off", async ({ page }) => {
    await openPopup(page);
    await page.getByRole("button", { name: "Settings" }).click();

    const japan = page.locator("label.dB-mkt").filter({ hasText: "Japan" });
    await expect(japan).toHaveCSS("color", "rgb(26, 28, 27)");
    await expect(japan).toHaveCSS("background-color", WHITE);

    await japan.getByRole("checkbox").uncheck();
    await expect(japan).toHaveClass("dB-mkt off");
    await expect(japan).toHaveCSS("color", "rgb(163, 174, 170)");
    await expect(japan).toHaveCSS("background-color", "rgb(251, 252, 252)");
  });
});

test.describe("visual snapshots", () => {
  test("idle", async ({ page }) => {
    await openPopup(page);
    await expect(runButton(page)).toHaveText("Check 9 other Amazons");
    await expectThumbnailLoaded(page);
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-idle.png", SNAPSHOT);
  });

  test("running", async ({ page }) => {
    const scn = scenario();
    await openPopup(page, scn);
    await startRun(page);
    await emitProgress(page, progressStep(scn, "DE", "MATCH"));
    await expect(page.locator(".dB-dial-num")).toHaveText("3/9");
    await expect(page.locator(".dB-chk")).toHaveText([
      "🇨🇦 CA $391.44",
      "🇲🇽 MX —",
      "🇬🇧 UK $372.16",
      "🇩🇪 DE …",
      "🇫🇷 FR …",
      "🇮🇹 IT …"
    ]);
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-running.png", SNAPSHOT);
  });

  test("done", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    await expect(verdictCard(page).locator(".dB-save")).toHaveText("Save $50.94");
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-done.png", SNAPSHOT);
  });

  test("done-scrolled-bottom", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    await parkPointer(page);
    await scrollToBottom(page);
    await expect(page.getByRole("button", { name: "Check again" })).toBeInViewport();
    await expect(page).toHaveScreenshot("verdict-done-scrolled-bottom.png", SNAPSHOT);
  });

  test("issues-open", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    await page.getByRole("button", { name: "4 marketplaces could not be compared" }).click();
    await expect(page.locator(".dB-issue")).toHaveCount(4);
    await parkPointer(page);
    await scrollToBottom(page);
    await expect(page).toHaveScreenshot("verdict-issues-open.png", SNAPSHOT);
  });

  test("sheet", async ({ page }) => {
    await openPopup(page);
    await completeRun(page);
    await listRow(page, "Germany").click();
    await expectSheetOpen(page);
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-sheet.png", SNAPSHOT);
  });

  test("stay", async ({ page }) => {
    const scn = scenario({ baseline: cheapBaseline });
    await openPopup(page, scn);
    await completeRun(page, scn);
    await expect(verdictCard(page).locator(".dB-save")).toHaveText("Stay here");
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-stay.png", SNAPSHOT);
  });

  test("settings", async ({ page }) => {
    await openPopup(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "Close settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "USD", exact: true })).toHaveAttribute("aria-pressed", "true");
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-settings.png", SNAPSHOT);
  });

  test("not-on-amazon", async ({ page }) => {
    await openPopup(page, scenario({ tabUrl: NON_AMAZON_URL }));
    await expect(page.getByText("Open an Amazon product page")).toBeVisible();
    await expect(runButton(page)).toHaveText("Check other Amazons");
    await expect(runButton(page)).toBeDisabled();
    await parkPointer(page);
    await expect(page).toHaveScreenshot("verdict-not-on-amazon.png", SNAPSHOT);
  });
});
