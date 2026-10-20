import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComparisonResult } from "../../../src/shared/types";
import {
  NBSP,
  baseline,
  deWithoutImportFees,
  fxTable,
  money,
  productUrl,
  renderDone,
  resultPayload,
  rowElements,
  rowSummary,
  source
} from "./harness";

const ukFromAnotherSeller: ComparisonResult = {
  marketplace: "UK",
  status: "OK",
  confidence: 0.96,
  productUrl: productUrl("UK"),
  breakdown: { item: money(574.97, "GBP"), shipping: money(252.53, "CHF") },
  normalizedTotal: money(1018.98, "USD"),
  notes: ["Matched by ASIN", "Quoted another seller's offer", "Import fees not displayed for destination"]
};
const fxTableWithFrancs = { ...fxTable, rates: { ...fxTable.rates, CHF: 0.94 } };
const switzerland = { ...source, destinationCountryCode: "CH" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function sheetElement(container: HTMLElement): HTMLElement {
  const sheet = container.querySelector<HTMLElement>(".dB-sheet");
  if (!sheet) {
    throw new Error("sheet missing");
  }
  return sheet;
}

function pressEscape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function endTransition(target: Element, propertyName: string): void {
  const event = new Event("transitionend", { bubbles: true });
  Object.defineProperty(event, "propertyName", { value: propertyName });
  act(() => {
    target.dispatchEvent(event);
  });
}

function sheetLines(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll(".dB-line")).map((line) => [
    line.className,
    line.querySelector("span")?.textContent,
    line.querySelector("b")?.textContent
  ]);
}

function rowFor(container: HTMLElement, name: string): HTMLElement {
  const row = rowElements(container).find((element) => rowSummary(element).name === name);
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

describe("detail sheet", () => {
  it("is closed and has no dialog semantics until a row is chosen", async () => {
    const app = await renderDone();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(app.container.querySelector(".dB-sheet")).not.toHaveClass("is-on");
    expect(app.container.querySelector(".dB-sheet")).toBeEmptyDOMElement();
    expect(app.container.querySelector(".dB-scrim")).not.toHaveClass("is-on");
  });

  it("opens the breakdown for a remote marketplace and moves focus into it", async () => {
    const app = await renderDone();

    await app.user.click(rowFor(app.container, "Germany"));

    const dialog = screen.getByRole("dialog", { name: "🇩🇪 Germany" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("dB-sheet", "is-on");
    expect(dialog).toHaveFocus();
    expect(app.container.querySelector(".dB-scrim")).toHaveClass("is-on");
    expect(dialog.querySelector(".dB-grab")).not.toBeNull();
    expect(dialog.querySelector(".sub")?.textContent).toBe("amazon.de");
    expect(sheetLines(dialog)).toEqual([
      ["dB-line", "Item price", `279,00${NBSP}€`],
      ["dB-line", "Shipping to United States", `12,99${NBSP}€`],
      ["dB-line", "Import fees deposit", `31,20${NBSP}€`],
      ["dB-line total", "Delivered total", `323,19${NBSP}€`],
      ["dB-line conv", "Roughly", "$349.05 at today’s rate"]
    ]);
    const trust = dialog.querySelector(".dB-trust");
    expect(trust).not.toHaveClass("warn");
    expect(trust?.querySelector(".dot")).not.toBeNull();
    expect(trust?.textContent).toBe(
      "We are 91% sure this is the same product — title, brand and variant all line up."
    );

    await app.user.click(within(dialog).getByRole("button", { name: "Open on amazon.de" }));
    expect(app.create).toHaveBeenCalledWith({ url: productUrl("DE"), active: true });
    expect(screen.getByRole("status")).toHaveTextContent("Opening amazon.de — you complete the purchase on Amazon.");
  });

  it("flags a low-confidence match with the warning trust box", async () => {
    const app = await renderDone();

    await app.user.click(rowFor(app.container, "Italy"));

    const trust = screen.getByRole("dialog", { name: "🇮🇹 Italy" }).querySelector(".dB-trust");
    expect(trust).toHaveClass("warn");
    expect(trust?.textContent).toBe("We are 76% sure this is the same product.");
  });

  it("shows the page you are on with free shipping, no import fees and a Close button", async () => {
    const app = await renderDone();

    await app.user.click(rowFor(app.container, "United States"));

    const dialog = screen.getByRole("dialog", { name: "🇺🇸 United States" });
    expect(dialog.querySelector(".sub")?.textContent).toBe(`${source.title} — Black`);
    expect(dialog.querySelector(".dB-trust")).not.toHaveClass("warn");
    expect(dialog.querySelector(".dB-trust")?.textContent).toBe(
      "This is the page you are on. Prices are what Amazon showed when we checked."
    );
    expect(sheetLines(dialog)).toEqual([
      ["dB-line", "Item price", "$399.99"],
      ["dB-line", "Shipping to United States", "Free"],
      ["dB-line", "Import fees deposit", "—"],
      ["dB-line total", "Delivered total", "$399.99"],
      ["dB-line conv", "Roughly", "$399.99 at today’s rate"]
    ]);
    expect(within(dialog).queryByRole("button", { name: /^Open on/ })).not.toBeInTheDocument();

    await app.user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(app.create).not.toHaveBeenCalled();
  });

  it("says the import fees were not shown for a marketplace whose page showed none", async () => {
    const app = await renderDone(resultPayload({ results: [deWithoutImportFees] }));

    await app.user.click(rowFor(app.container, "Germany"));

    expect(sheetLines(screen.getByRole("dialog", { name: "🇩🇪 Germany" }))).toEqual([
      ["dB-line", "Item price", `279,00${NBSP}€`],
      ["dB-line", "Shipping to United States", `12,99${NBSP}€`],
      ["dB-line", "Import fees deposit", "Not shown"],
      ["dB-line total", "Delivered total", `291,99${NBSP}€`],
      ["dB-line conv", "Roughly", "$315.35 at today’s rate"]
    ]);
  });

  it("says when the run set the marketplace's delivery location", async () => {
    const switched = { ...deWithoutImportFees, notes: ["Matched by ASIN", "Delivery location set to Switzerland"] };
    const app = await renderDone(resultPayload({ source: { ...source, destinationCountryCode: "CH" }, results: [switched] }));

    await app.user.click(rowFor(app.container, "Germany"));

    expect(screen.getByRole("dialog", { name: "🇩🇪 Germany" }).querySelector(".dB-location")?.textContent).toBe(
      "Delivery location set to Switzerland"
    );
  });

  it("says nothing about the delivery location of a marketplace the run left as it was", async () => {
    const app = await renderDone(resultPayload({ results: [deWithoutImportFees] }));

    await app.user.click(rowFor(app.container, "Germany"));

    expect(screen.getByRole("dialog", { name: "🇩🇪 Germany" }).querySelector(".dB-location")).toBeNull();
  });

  it("totals an offer priced in pounds with delivery in Swiss francs in pounds at today's rate", async () => {
    const app = await renderDone(
      resultPayload({ source: switzerland, results: [ukFromAnotherSeller], fxTable: fxTableWithFrancs })
    );

    expect(rowSummary(rowFor(app.container, "United Kingdom")).local).toBe("£803.86 incl. shipping, import fees not shown");
    await app.user.click(rowFor(app.container, "United Kingdom"));

    expect(sheetLines(screen.getByRole("dialog", { name: "🇬🇧 United Kingdom" }))).toEqual([
      ["dB-line", "Item price", "£574.97"],
      ["dB-line", "Shipping to Switzerland", `CHF${NBSP}252.53`],
      ["dB-line", "Import fees deposit", "Not shown"],
      ["dB-line total", "Delivered total", "£803.86"],
      ["dB-line conv", "Roughly", "$1,018.98 at today’s rate"]
    ]);
  });

  it("shows no total in the store's currency for an offer priced in two currencies when there is no FX table", async () => {
    const app = await renderDone(resultPayload({ source: switzerland, results: [ukFromAnotherSeller], fxTable: undefined }));

    expect(rowSummary(rowFor(app.container, "United Kingdom")).local).toBeUndefined();
    await app.user.click(rowFor(app.container, "United Kingdom"));

    expect(sheetLines(screen.getByRole("dialog", { name: "🇬🇧 United Kingdom" })).slice(3)).toEqual([
      ["dB-line total", "Delivered total", "—"],
      ["dB-line conv", "Roughly", "$1,018.98 at today’s rate"]
    ]);
  });

  it("says who sells and dispatches an offer quoted from another seller", async () => {
    const quoted = {
      ...ukFromAnotherSeller,
      notes: [...ukFromAnotherSeller.notes!, "Delivery location set to Switzerland"],
      otherSeller: { seller: "BuyMyBricks", dispatcher: "Amazon", fulfilledByAmazon: true, offerCount: 2, deliveringNewCount: 2 }
    };
    const app = await renderDone(resultPayload({ source: switzerland, results: [quoted], fxTable: fxTableWithFrancs }));

    await app.user.click(rowFor(app.container, "United Kingdom"));

    const dialog = screen.getByRole("dialog", { name: "🇬🇧 United Kingdom" });
    expect(Array.from(dialog.querySelectorAll(".dB-hint"), (hint) => [hint.className, hint.textContent])).toEqual([
      [
        "dB-hint is-left dB-seller",
        "Sold by BuyMyBricks, dispatched by Amazon. Cheapest of the 2 offers Amazon lists that deliver new."
      ],
      ["dB-hint is-left dB-location", "Delivery location set to Switzerland"]
    ]);
  });

  it("says who sells the page you are on when its price came from another seller", async () => {
    const quotedBaseline = {
      ...baseline,
      otherSeller: { seller: "Acme Outlet", dispatcher: "Acme Outlet", fulfilledByAmazon: false, offerCount: 1, deliveringNewCount: 1 }
    };
    const app = await renderDone(resultPayload({ baseline: quotedBaseline }));

    await app.user.click(rowFor(app.container, "United States"));

    expect(screen.getByRole("dialog", { name: "🇺🇸 United States" }).querySelector(".dB-seller")?.textContent).toBe(
      "Sold by Acme Outlet, dispatched by Acme Outlet. The only offer Amazon lists that delivers new."
    );
  });

  it("says nothing about the seller of a marketplace whose page quoted its own price", async () => {
    const app = await renderDone();

    await app.user.click(rowFor(app.container, "Germany"));

    expect(screen.getByRole("dialog", { name: "🇩🇪 Germany" }).querySelector(".dB-seller")).toBeNull();
  });

  it("titles the page you are on with the product title alone when it has no variant", async () => {
    const plain = { ...source, variationTokens: [] };
    const app = await renderDone(resultPayload({ source: plain }), { loadSource: { source: plain, baseline } });

    await app.user.click(rowFor(app.container, "United States"));

    expect(screen.getByRole("dialog").querySelector(".sub")?.textContent).toBe(source.title);
  });

  it("joins several variant tokens in the subtitle of the page you are on", async () => {
    const variant = { ...source, variationTokens: ["black", "2 pack"] };
    const app = await renderDone(resultPayload({ source: variant }));

    await app.user.click(rowFor(app.container, "United States"));

    expect(screen.getByRole("dialog").querySelector(".sub")?.textContent).toBe(`${source.title} — Black · 2 pack`);
  });

  it("closes on Escape and returns focus to the row", async () => {
    const app = await renderDone();
    const row = rowFor(app.container, "United Kingdom");

    await app.user.click(row);
    expect(screen.getByRole("dialog", { name: "🇬🇧 United Kingdom" })).toHaveFocus();

    await app.user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(app.container.querySelector(".dB-sheet")).not.toHaveClass("is-on");
    expect(row).toHaveFocus();
  });

  it("closes when the scrim is clicked", async () => {
    const app = await renderDone();

    await app.user.click(rowFor(app.container, "Canada"));
    expect(screen.getByRole("dialog", { name: "🇨🇦 Canada" })).toBeInTheDocument();

    const scrim = app.container.querySelector<HTMLElement>(".dB-scrim");
    if (!scrim) {
      throw new Error("scrim missing");
    }
    await app.user.click(scrim);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(scrim).not.toHaveClass("is-on");
  });

  it("consumes Escape while open so the browser does not close the whole popup", async () => {
    const app = await renderDone();
    await app.user.click(rowFor(app.container, "Germany"));
    const dialog = screen.getByRole("dialog", { name: "🇩🇪 Germany" });
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);

    const event = pressEscape(dialog);

    window.removeEventListener("keydown", reachedWindow);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("leaves Escape to the browser while the sheet is closed", async () => {
    const app = await renderDone();
    const reachedWindow = vi.fn();
    window.addEventListener("keydown", reachedWindow);

    const event = pressEscape(rowFor(app.container, "Germany"));

    window.removeEventListener("keydown", reachedWindow);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedWindow).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard", async () => {
    const app = await renderDone();
    const row = rowFor(app.container, "Germany");
    row.focus();

    await app.user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "🇩🇪 Germany" })).toHaveFocus();
  });

  describe("closing animation", () => {
    it("keeps the last breakdown while the sheet slides down and clears it after 400 ms", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Germany"));
      const sheet = sheetElement(app.container);
      vi.useFakeTimers();

      pressEscape(sheet);

      expect(sheet).not.toHaveClass("is-on");
      expect(sheet).not.toHaveAttribute("role");
      expect(sheet).not.toHaveAttribute("aria-modal");
      expect(sheet).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(sheet.querySelector("h4")?.textContent).toBe("🇩🇪 Germany");
      expect(app.container.querySelector(".dB-scrim")).not.toHaveClass("is-on");

      act(() => {
        vi.advanceTimersByTime(399);
      });
      expect(sheet.querySelector("h4")?.textContent).toBe("🇩🇪 Germany");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(sheet).toBeEmptyDOMElement();
    });

    it("clears the breakdown as soon as the slide-down transform transition ends", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Canada"));
      const sheet = sheetElement(app.container);
      const openButton = within(sheet).getByRole("button", { name: "Open on amazon.ca" });
      pressEscape(sheet);

      endTransition(sheet, "opacity");
      endTransition(openButton, "transform");
      expect(sheet.querySelector("h4")?.textContent).toBe("🇨🇦 Canada");

      endTransition(sheet, "transform");
      expect(sheet).toBeEmptyDOMElement();
    });

    it("shows the newly chosen row when reopened mid-slide and keeps it", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Germany"));
      const sheet = sheetElement(app.container);
      vi.useFakeTimers();
      fireEvent.click(app.container.querySelector(".dB-scrim") ?? sheet);

      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.click(rowFor(app.container, "Italy"));
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(screen.getByRole("dialog", { name: "🇮🇹 Italy" })).toBe(sheet);
      expect(sheet).toHaveClass("is-on");
      expect(sheet).not.toHaveAttribute("aria-hidden");
    });
  });

  describe("focus trap", () => {
    it("cycles Tab between the dialog and its Open button without reaching the page behind", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Germany"));
      const dialog = screen.getByRole("dialog", { name: "🇩🇪 Germany" });
      const open = within(dialog).getByRole("button", { name: "Open on amazon.de" });

      await app.user.tab();
      expect(open).toHaveFocus();
      await app.user.tab();
      expect(dialog).toHaveFocus();
      await app.user.tab();
      expect(open).toHaveFocus();
      await app.user.tab();
      expect(dialog).toHaveFocus();
    });

    it("cycles Shift+Tab backwards through the same stops", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Germany"));
      const dialog = screen.getByRole("dialog", { name: "🇩🇪 Germany" });
      const open = within(dialog).getByRole("button", { name: "Open on amazon.de" });

      await app.user.tab({ shift: true });
      expect(open).toHaveFocus();
      await app.user.tab({ shift: true });
      expect(dialog).toHaveFocus();
      await app.user.tab({ shift: true });
      expect(open).toHaveFocus();
    });

    it("traps focus on the Close button of the page you are on", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "United States"));
      const dialog = screen.getByRole("dialog", { name: "🇺🇸 United States" });
      const close = within(dialog).getByRole("button", { name: "Close" });

      await app.user.tab();
      expect(close).toHaveFocus();
      await app.user.tab();
      expect(dialog).toHaveFocus();
      await app.user.tab({ shift: true });
      expect(close).toHaveFocus();
      await app.user.tab({ shift: true });
      expect(dialog).toHaveFocus();
    });

    it("pulls focus that wandered behind the sheet back into it on Tab", async () => {
      const app = await renderDone();
      await app.user.click(rowFor(app.container, "Germany"));
      const dialog = screen.getByRole("dialog", { name: "🇩🇪 Germany" });
      const checkAgain = screen.getByRole("button", { name: "Check again" });

      checkAgain.focus();
      await app.user.tab();
      expect(dialog).toHaveFocus();

      checkAgain.focus();
      await app.user.tab({ shift: true });
      expect(within(dialog).getByRole("button", { name: "Open on amazon.de" })).toHaveFocus();
    });

    it("releases the trap once the sheet closes", async () => {
      const app = await renderDone();
      const germany = rowFor(app.container, "Germany");
      germany.focus();
      await app.user.keyboard("{Enter}");
      await app.user.tab();
      await app.user.keyboard("{Escape}");
      expect(germany).toHaveFocus();

      await app.user.tab();

      expect(rowFor(app.container, "Italy")).toHaveFocus();
    });
  });
});
