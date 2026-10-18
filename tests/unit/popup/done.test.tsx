import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_COMPARISON } from "../../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  MINUS,
  NBSP,
  baseline,
  de,
  es,
  fr,
  fxTable,
  jp,
  mx,
  productUrl,
  renderDone,
  resultPayload,
  rowElements,
  rowSummary,
  source,
  uk
} from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function verdictCard(container: HTMLElement) {
  const card = container.querySelector<HTMLElement>(".dB-verdict");
  if (!card) {
    throw new Error("verdict card missing");
  }
  return {
    card,
    eyebrow: card.querySelector(".eyebrow")?.textContent,
    headline: card.querySelector(".dB-save"),
    lede: card.querySelector(".lede")?.textContent
  };
}

const cheapBaseline = {
  ...baseline,
  breakdown: { item: { amount: 299.99, currency: "USD" } },
  normalizedTotal: undefined
};

describe("done view verdicts", () => {
  it("states the saving first with a button that opens the cheapest marketplace", async () => {
    const app = await renderDone();
    const { card, eyebrow, headline, lede } = verdictCard(app.container);

    expect(card).not.toHaveClass("is-muted");
    expect(eyebrow).toBe("Cheapest delivered to United States");
    expect(headline).toHaveTextContent("Save $50.94");
    expect(headline).not.toHaveClass("is-small");
    expect(lede).toBe(
      "Buy from Germany for $349.05 delivered — 13% less than the $399.99 you would pay here. Item, shipping and import fees included."
    );
    expect(Array.from(card.querySelectorAll(".lede b")).map((bold) => bold.textContent)).toEqual([
      "Germany",
      "$349.05"
    ]);

    await app.user.click(within(card).getByRole("button", { name: "Open on amazon.de" }));

    expect(app.create).toHaveBeenCalledWith({ url: productUrl("DE"), active: true });
    expect(screen.getByRole("status")).toHaveTextContent("Opening amazon.de — you complete the purchase on Amazon.");
  });

  it("says stay here when nothing beats the page price", async () => {
    const app = await renderDone(resultPayload({ baseline: cheapBaseline }));
    const { card, eyebrow, headline, lede } = verdictCard(app.container);

    expect(card).toHaveClass("is-muted");
    expect(eyebrow).toBe("Result");
    expect(headline).toHaveTextContent("Stay here");
    expect(headline).toHaveClass("is-small");
    expect(lede).toBe("Nothing came in under the $299.99 you would pay on amazon.com.");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(rowSummary(rowElements(app.container)[0])).toMatchObject({
      name: "United States",
      best: true,
      delta: "the page you are on"
    });
  });

  it("names the cheapest marketplace when the page price could not be read", async () => {
    const app = await renderDone(resultPayload({ baseline: undefined }), {
      loadSource: { source }
    });
    const { card, eyebrow, headline, lede } = verdictCard(app.container);

    expect(card).not.toHaveClass("is-muted");
    expect(eyebrow).toBe("Cheapest delivered to United States");
    expect(headline).toHaveTextContent("$349.05");
    expect(lede).toBe(
      "Buy from Germany for $349.05 delivered. Item, shipping and import fees included. We could not read the price on this page to compare."
    );
    expect(within(card).getByRole("button", { name: "Open on amazon.de" })).toBeEnabled();

    const rows = rowElements(app.container).map(rowSummary);
    expect(rows.map((row) => row.name)).toEqual(["Germany", "Italy", "United Kingdom", "Canada", "Australia"]);
    expect(rows.every((row) => row.delta === "" && row.deltaClass === "flat")).toBe(true);
  });

  it("reports no delivered price when no marketplace could quote one", async () => {
    const app = await renderDone(resultPayload({ results: [jp, fr, es, mx] }));
    const { card, eyebrow, headline, lede } = verdictCard(app.container);

    expect(card).toHaveClass("is-muted");
    expect(eyebrow).toBe("Result");
    expect(headline).toHaveTextContent("No delivered price");
    expect(headline).toHaveClass("is-small");
    expect(lede).toBe("None of the marketplaces we checked could quote a delivered price to United States.");
    expect(rowElements(app.container).map((row) => rowSummary(row).name)).toEqual(["United States"]);
    expect(screen.getByRole("button", { name: "4 marketplaces could not be compared" })).toBeInTheDocument();
  });

  it("explains a failed run and still lists the partial results", async () => {
    const app = await renderDone(
      resultPayload({ results: [de, jp], error: "Exchange rates are unavailable right now." })
    );
    const { card, eyebrow, headline, lede } = verdictCard(app.container);

    expect(card).toHaveClass("is-muted");
    expect(eyebrow).toBe("Something went wrong");
    expect(headline).toHaveTextContent("Couldn't compare");
    expect(headline).toHaveClass("is-small");
    expect(lede).toBe("Exchange rates are unavailable right now.");
    expect(rowElements(app.container).map((row) => rowSummary(row).name)).toEqual(["Germany", "United States"]);
    expect(screen.getByRole("button", { name: "1 marketplace could not be compared" })).toBeInTheDocument();
  });

  it("keeps the preloaded source and baseline when an error payload carries none", async () => {
    const app = await renderDone({
      results: [],
      generatedAt: "2026-07-30T09:00:00.000Z",
      error: "Unable to extract required source product metadata"
    });

    expect(verdictCard(app.container).lede).toBe("Unable to extract required source product metadata");
    expect(rowElements(app.container).map(rowSummary)).toEqual([
      expect.objectContaining({ name: "United States", total: "$399.99", delta: "the page you are on" })
    ]);
    expect(screen.queryByRole("button", { name: /could not be compared/ })).not.toBeInTheDocument();
    expect(screen.getByText("ECB daily rates")).toBeInTheDocument();
  });

  it("lets the result payload's baseline win over the preloaded one", async () => {
    const app = await renderDone(resultPayload({ baseline: cheapBaseline }));

    expect(verdictCard(app.container).headline).toHaveTextContent("Stay here");
    expect(rowSummary(rowElements(app.container)[0]).total).toBe("$299.99");
  });
});

describe("ranked list", () => {
  it("ranks every marketplace with local totals, deltas, the best row and the match pill", async () => {
    const app = await renderDone();

    expect(app.container.querySelector(".dB-sectitle")?.textContent).toBe("Every marketplaceUSD delivered");
    expect(rowElements(app.container).map(rowSummary)).toEqual([
      {
        name: "Germany",
        local: `323,19${NBSP}€ incl. shipping & import`,
        total: "$349.05",
        delta: `${MINUS}$50.94`,
        deltaClass: "down",
        best: true,
        pill: null
      },
      {
        name: "Italy",
        local: `334,60${NBSP}€ incl. shipping & import`,
        total: "$361.37",
        delta: `${MINUS}$38.62`,
        deltaClass: "down",
        best: false,
        pill: "Check match"
      },
      {
        name: "United Kingdom",
        local: "£293.59 incl. shipping & import",
        total: "$372.16",
        delta: `${MINUS}$27.83`,
        deltaClass: "down",
        best: false,
        pill: null
      },
      {
        name: "Canada",
        local: "$534.60 incl. shipping & import",
        total: "$391.44",
        delta: `${MINUS}$8.55`,
        deltaClass: "down",
        best: false,
        pill: null
      },
      {
        name: "United States",
        local: "$399.99 incl. shipping & import",
        total: "$399.99",
        delta: "the page you are on",
        deltaClass: "flat",
        best: false,
        pill: null
      },
      {
        name: "Australia",
        local: "$672.30 incl. shipping & import",
        total: "$438.72",
        delta: "+$38.73",
        deltaClass: "up",
        best: false,
        pill: null
      }
    ]);
  });

  it("renders each row as a button that opens a dialog", async () => {
    const app = await renderDone();

    for (const row of rowElements(app.container)) {
      expect(row.tagName).toBe("BUTTON");
      expect(row).toHaveAttribute("aria-haspopup", "dialog");
    }
    expect(rowElements(app.container)[0].querySelector(".flag")?.textContent).toBe("🇩🇪");
  });

  it("shows the FX date in the footer once the result brings rates", async () => {
    await renderDone();

    expect(screen.getByText(`Rates ${fxTable.date}`)).toBeInTheDocument();
    expect(screen.queryByText("ECB daily rates")).not.toBeInTheDocument();
  });
});

describe("issues accordion", () => {
  it("folds the marketplaces that could not be compared into one toggle", async () => {
    const app = await renderDone();
    const toggle = screen.getByRole("button", { name: "4 marketplaces could not be compared" });
    const body = app.container.querySelector<HTMLElement>(".dB-acc-body");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("⌄");
    expect(body).not.toBeVisible();

    await app.user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("⌃");
    expect(body).toBeVisible();
    const issues = Array.from(body?.querySelectorAll(".dB-issue") ?? []).map((issue) => ({
      flag: issue.querySelector(".flag")?.textContent,
      title: issue.querySelector("strong")?.textContent,
      note: issue.querySelector("p")?.textContent
    }));
    expect(issues).toEqual([
      {
        flag: "🇲🇽",
        title: "Mexico — No confident match",
        note: "Closest listing scored 31% — below the confidence floor."
      },
      { flag: "🇫🇷", title: "France — Delivered total not quotable", note: "Out of stock — no delivery date offered." },
      {
        flag: "🇪🇸",
        title: "Spain — Could not read the page",
        note: "Import fees are only revealed at checkout, so the delivered total cannot be quoted."
      },
      {
        flag: "🇯🇵",
        title: "Japan — Does not ship here",
        note: "Match found, but the seller does not ship to the United States."
      }
    ]);

    await app.user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(body).not.toBeVisible();
  });

  it("falls back to the per-status note for the destination country", async () => {
    const app = await renderDone(resultPayload({ results: [de, { ...jp, notes: undefined }] }));

    await app.user.click(screen.getByRole("button", { name: "1 marketplace could not be compared" }));

    expect(app.container.querySelector(".dB-issue p")?.textContent).toBe(
      "Match found, but the seller does not ship to United States."
    );
  });

  it("is absent when every marketplace was compared", async () => {
    const app = await renderDone(resultPayload({ results: [de, uk] }));

    expect(app.container.querySelector(".dB-acc")).toBeNull();
  });
});

describe("check again", () => {
  it("re-runs the comparison from the done view", async () => {
    const app = await renderDone();

    await app.user.click(screen.getByRole("button", { name: "Check again" }));

    expect(app.runRequests()).toEqual([
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } },
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } }
    ]);
    expect(app.container.querySelector(".dB-dial-num")?.textContent).toBe("0/9");
    expect(app.container.querySelectorAll(".dB-chk")).toHaveLength(1);
  });
});
