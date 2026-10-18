import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MARKETPLACE_CODES } from "../../../src/shared/markets";
import {
  DEFAULT_SETTINGS,
  MINUS,
  SETTINGS_KEY,
  baseline,
  renderApp,
  renderDone,
  renderLoaded,
  rowElements,
  rowSummary,
  source
} from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function currencyButtons(): HTMLElement[] {
  const segment = document.getElementById("b-seg");
  if (!segment) {
    throw new Error("segmented control missing");
  }
  return within(segment).getAllByRole("button");
}

describe("settings toggle", () => {
  it("swaps the gear for a close button and returns to idle", async () => {
    const app = await renderLoaded();

    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    const close = screen.getByRole("button", { name: "Close settings" });
    expect(close).toHaveTextContent("✕");
    expect(screen.getByRole("heading", { name: "Show prices in" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Marketplaces to check" })).toBeInTheDocument();
    expect(
      screen.getByText("Converted daily from European Central Bank rates. Amazon charges you in the local currency.")
    ).toHaveClass("dB-hint", "is-left");
    expect(
      screen.getByText("Fewer marketplaces means a faster check. Each one opens briefly in a background tab.")
    ).toHaveClass("dB-hint", "is-left");
    expect(screen.queryByRole("button", { name: /^Check/ })).not.toBeInTheDocument();

    await app.user.click(close);

    expect(screen.getByRole("button", { name: "Settings" })).toHaveTextContent("⚙");
    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeInTheDocument();
  });

  it("returns to the done view it was opened from", async () => {
    const app = await renderDone();

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText("Save $50.94")).not.toBeInTheDocument();

    await app.user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
  });
});

describe("currency setting", () => {
  it("offers the mockup currencies and presses the source currency by default", async () => {
    const app = await renderLoaded();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    expect(currencyButtons().map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["USD", "true"],
      ["EUR", "false"],
      ["GBP", "false"],
      ["JPY", "false"]
    ]);
  });

  it("puts a foreign source currency first", async () => {
    const app = await renderLoaded({
      loadSource: { source: { ...source, marketplace: "CA", destinationCountryCode: "CA" } }
    });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    expect(currencyButtons().map((button) => button.textContent)).toEqual(["CAD", "USD", "EUR", "GBP", "JPY"]);
    expect(screen.getByRole("button", { name: "CAD" })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves the chosen currency immediately and re-renders every total in it", async () => {
    const app = await renderDone();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    await app.user.click(screen.getByRole("button", { name: "EUR" }));

    expect(screen.getByRole("button", { name: "EUR" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "false");
    expect(app.set).toHaveBeenLastCalledWith({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, comparisonCurrency: "EUR" } });
    expect(app.store[SETTINGS_KEY]).toMatchObject({ comparisonCurrency: "EUR" });

    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(screen.getByText("Save €47.17")).toBeInTheDocument();
    expect(app.container.querySelector(".dB-sectitle")?.textContent).toBe("Every marketplaceEUR delivered");
    expect(rowElements(app.container).map((row) => [rowSummary(row).total, rowSummary(row).delta])).toEqual([
      ["€323.19", `${MINUS}€47.17`],
      ["€334.60", `${MINUS}€35.76`],
      ["€344.59", `${MINUS}€25.77`],
      ["€362.44", `${MINUS}€7.92`],
      ["€370.36", "the page you are on"],
      ["€406.22", "+€35.86"]
    ]);

    await app.user.click(rowElements(app.container)[0]);
    const conversion = screen.getByRole("dialog").querySelector(".dB-line.conv b");
    expect(conversion?.textContent).toBe("€323.19 at today’s rate");
  });

  it("states the saving in whole yen", async () => {
    const app = await renderDone();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await app.user.click(screen.getByRole("button", { name: "JPY" }));
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(screen.getByText("Save ¥7,336")).toBeInTheDocument();
    expect(rowSummary(rowElements(app.container)[0]).total).toBe("¥50,263");
  });

  it("uses a currency stored from an earlier session", async () => {
    const app = await renderDone(undefined, { settings: { comparisonCurrency: "GBP" } });

    expect(await screen.findByText("Save £40.19")).toBeInTheDocument();
    expect(app.container.querySelector(".dB-sectitle")?.textContent).toBe("Every marketplaceGBP delivered");
  });

  it("still switches currency when chrome.storage is unavailable", async () => {
    const app = await renderLoaded({ withStorage: false });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    await app.user.click(screen.getByRole("button", { name: "GBP" }));

    expect(screen.getByRole("button", { name: "GBP" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("marketplace setting", () => {
  it("lists every marketplace except the source, all checked by default", async () => {
    const app = await renderLoaded();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      " 🇨🇦 Canada",
      " 🇲🇽 Mexico",
      " 🇬🇧 United Kingdom",
      " 🇩🇪 Germany",
      " 🇫🇷 France",
      " 🇮🇹 Italy",
      " 🇪🇸 Spain",
      " 🇯🇵 Japan",
      " 🇦🇺 Australia"
    ]);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(boxes.every((box) => box.closest("label")?.className === "dB-mkt")).toBe(true);
  });

  it("lists all ten marketplaces when the source is unknown", async () => {
    const app = renderApp({ loadSource: { error: "Unsupported marketplace hostname" } });
    await screen.findByText("Open an Amazon product page");

    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getAllByRole("checkbox")).toHaveLength(MARKETPLACE_CODES.length);
  });

  it("saves a toggled marketplace immediately and updates the run button", async () => {
    const app = await renderLoaded();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const germany = screen.getByRole("checkbox", { name: "🇩🇪 Germany" });

    await app.user.click(germany);

    expect(germany).not.toBeChecked();
    expect(germany.closest("label")).toHaveClass("dB-mkt", "off");
    expect(app.set).toHaveBeenLastCalledWith({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, enabledMarketplaces: MARKETPLACE_CODES.filter((code) => code !== "DE") }
    });

    await app.user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByRole("button", { name: "Check 8 other Amazons" })).toBeInTheDocument();
    expect(screen.getByText(/^Takes about 24 seconds\./)).toBeInTheDocument();
  });

  it("re-enables a marketplace in its canonical position", async () => {
    const app = await renderLoaded({ settings: { enabledMarketplaces: ["US", "UK", "JP"] } });
    await screen.findByRole("button", { name: "Check 2 other Amazons" });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));

    await app.user.click(screen.getByRole("checkbox", { name: "🇨🇦 Canada" }));

    expect(app.store[SETTINGS_KEY]).toMatchObject({ enabledMarketplaces: ["US", "CA", "UK", "JP"] });
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByRole("button", { name: "Check 3 other Amazons" })).toBeInTheDocument();
  });

  it("runs only the remaining marketplaces after toggles", async () => {
    const app = await renderLoaded({ loadSource: { source, baseline } });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    for (const name of ["🇨🇦 Canada", "🇲🇽 Mexico", "🇬🇧 United Kingdom"]) {
      await app.user.click(screen.getByRole("checkbox", { name }));
    }
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    await app.user.click(screen.getByRole("button", { name: "Check 6 other Amazons" }));

    expect(app.container.querySelector(".dB-dial-num")?.textContent).toBe("0/6");
    expect(app.container.querySelector(".dB-nowline")?.textContent).toBe("Opening tab Germany");
  });
});
