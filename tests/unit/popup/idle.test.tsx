import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../src/popup/App";
import { LOAD_SOURCE, RUN_COMPARISON } from "../../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  NBSP,
  SETTINGS_KEY,
  baseline,
  renderApp,
  renderLoaded,
  source
} from "./harness";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("idle view", () => {
  it("preloads the source product for the active tab on mount", async () => {
    const app = await renderLoaded();

    expect(app.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(app.sentOfType(LOAD_SOURCE)).toEqual([{ type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } }]);
    expect(app.get).toHaveBeenCalledWith(SETTINGS_KEY);
    expect(app.addListener).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent(source.title);
    expect(screen.getByText("Black · $399.99 on amazon.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeEnabled();
    expect(
      screen.getByText(
        "Takes about 27 seconds. Each Amazon opens briefly in a background tab so we can read its real delivered price to United States. Its delivery location may be set to United States and is left that way after the check."
      )
    ).toHaveClass("dB-hint");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveTextContent("⚙");
    expect(screen.queryByText("Open an Amazon product page")).not.toBeInTheDocument();
  });

  it("shows the product image when the page provided one", async () => {
    const { container } = await renderLoaded();
    const thumb = container.querySelector(".dB-thumb");

    expect(thumb).not.toHaveClass("is-placeholder");
    expect(thumb?.querySelector("img")).toHaveAttribute("src", source.imageUrl);
  });

  it("falls back to the placeholder thumbnail without an image", async () => {
    const { container } = await renderLoaded({
      loadSource: { source: { ...source, imageUrl: undefined }, baseline }
    });
    const thumb = container.querySelector(".dB-thumb");

    expect(thumb).toHaveClass("is-placeholder");
    expect(thumb?.querySelector("img")).toBeNull();
  });

  it("uses the brand when there are no variant tokens and the source locale for the price", async () => {
    await renderLoaded({
      loadSource: {
        source: { ...source, marketplace: "DE", variationTokens: [], destinationCountryCode: "DE" },
        baseline: {
          ...baseline,
          marketplace: "DE",
          breakdown: { item: { amount: 279, currency: "EUR" } }
        }
      }
    });

    expect(screen.getByRole("heading", { level: 3 }).nextElementSibling?.textContent).toBe(
      `Sony · 279,00${NBSP}€ on amazon.de`
    );
    expect(
      screen.getByText(/price to Germany\. Its delivery location may be set to Germany and is left that way after the check\.$/)
    ).toBeInTheDocument();
  });

  it("leaves out the delivery location sentence when the page's destination is unknown", async () => {
    await renderLoaded({
      loadSource: { source: { ...source, destinationCountryCode: undefined }, baseline }
    });

    expect(
      screen.getByText(
        "Takes about 27 seconds. Each Amazon opens briefly in a background tab so we can read its real delivered price to your address."
      )
    ).toHaveClass("dB-hint");
    expect(screen.queryByText(/delivery location/)).not.toBeInTheDocument();
  });

  it("joins several variant tokens and omits the price when no baseline was read", async () => {
    await renderLoaded({
      loadSource: { source: { ...source, variationTokens: ["black", "2 pack"] } }
    });

    expect(screen.getByText("Black · 2 pack · amazon.com")).toBeInTheDocument();
  });

  it("asks for an Amazon product page when LOAD_SOURCE fails", async () => {
    const app = renderApp({ loadSource: { error: "Unsupported marketplace hostname" } });

    expect(await screen.findByText("Open an Amazon product page")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Across Amazon compares the delivered price of the product you are looking at across other Amazon marketplaces."
      )
    ).toBeInTheDocument();
    expect(app.container.querySelector(".dB-notice")).not.toBeNull();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check other Amazons" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Check \d+ other/ })).not.toBeInTheDocument();
  });

  it("shows a reading hint instead of an empty pane while LOAD_SOURCE is pending", async () => {
    const app = renderApp({ pendingLoadSource: true });

    await waitFor(() => expect(app.sentOfType(LOAD_SOURCE)).toHaveLength(1));

    expect(screen.getByText("Reading this page…")).toHaveClass("dB-hint");
    expect(app.container.querySelector(".dB-scroll")?.children).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Check/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Open an Amazon product page")).not.toBeInTheDocument();
  });

  it.each([
    ["a non-Amazon site", "https://www.google.com/search?q=sony"],
    ["a look-alike host", "https://www.amazon.com.example.net/dp/B09XS7JWHH"],
    ["an unsupported Amazon host", "https://www.amazon.nl/dp/B09XS7JWHH"],
    ["a mobile Amazon host", "https://m.amazon.co.uk/dp/B09XS7JWHH"],
    ["a browser page", "chrome://extensions/"],
    ["a tab without a url", undefined]
  ])("does not read the page on %s and shows the notice directly", async (_label, url) => {
    const app = renderApp({ tabs: [{ id: ACTIVE_TAB_ID, url }] });

    expect(await screen.findByText("Open an Amazon product page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check other Amazons" })).toBeDisabled();
    expect(app.query).toHaveBeenCalledTimes(1);
    expect(app.sentOfType(LOAD_SOURCE)).toEqual([]);
  });

  it("reads the page on a supported marketplace", async () => {
    const app = await renderLoaded({ tabs: [{ id: ACTIVE_TAB_ID, url: "https://www.amazon.de/dp/B09XS7JWHH?th=1" }] });

    expect(app.sentOfType(LOAD_SOURCE)).toEqual([{ type: LOAD_SOURCE, payload: { activeTabId: ACTIVE_TAB_ID } }]);
    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeEnabled();
  });

  it("does not ask for the source when there is no active tab", async () => {
    const app = renderApp({ tabs: [] });

    expect(await screen.findByText("Open an Amazon product page")).toBeInTheDocument();
    expect(app.sentOfType(LOAD_SOURCE)).toEqual([]);
    expect(screen.getByRole("button", { name: "Check other Amazons" })).toBeDisabled();
  });

  it("renders the not-on-Amazon state when the chrome APIs are missing", async () => {
    vi.stubGlobal("chrome", undefined);
    render(<App />);

    expect(await screen.findByText("Open an Amazon product page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check other Amazons" })).toBeDisabled();
  });

  it("falls back to default settings when chrome.storage is missing", async () => {
    await renderLoaded({ withStorage: false });

    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeEnabled();
  });

  it("counts targets from the stored marketplaces, in the singular for one", async () => {
    await renderApp({ settings: { enabledMarketplaces: ["US", "DE"] } });

    expect(await screen.findByRole("button", { name: "Check 1 other Amazon" })).toBeEnabled();
    expect(screen.getByText(/^Takes about 5 seconds\./)).toBeInTheDocument();
  });

  it("starts a run with the active tab and shows the first target before any progress", async () => {
    const app = await renderLoaded();

    await app.user.click(screen.getByRole("button", { name: "Check 9 other Amazons" }));

    expect(app.runRequests()).toEqual([
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId: expect.any(String) } }
    ]);
    expect(screen.getByText("0/9")).toHaveClass("dB-dial-num");
    expect(app.container.querySelector<HTMLElement>(".dB-dial")?.style.getPropertyValue("--p")).toBe("0%");
    expect(app.container.querySelector(".dB-nowline")).toHaveTextContent("Opening tab Canada");
    expect(app.container.querySelector(".dB-nowsub")).toHaveTextContent("amazon.ca");
    expect(app.container.querySelector(".dB-chk.now")).toHaveTextContent("🇨🇦 CA …");
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeInTheDocument();
  });

  it("refuses to run with zero marketplaces and explains why in a toast", async () => {
    const app = renderApp({ settings: { enabledMarketplaces: ["US"] } });
    const cta = await screen.findByRole("button", { name: "Check 0 other Amazons" });

    await app.user.click(cta);

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent("Pick at least one marketplace to check.");
    expect(toast).toHaveClass("toast", "is-on");
    expect(app.runRequests()).toEqual([]);
    expect(screen.getByRole("button", { name: "Check 0 other Amazons" })).toBeInTheDocument();
  });
});

describe("toast", () => {
  it("hides itself 2200 ms after it appears", async () => {
    renderApp({ settings: { enabledMarketplaces: ["US"] } });
    const cta = await screen.findByRole("button", { name: "Check 0 other Amazons" });
    vi.useFakeTimers();

    fireEvent.click(cta);
    const toast = screen.getByRole("status");
    expect(toast).toHaveClass("is-on");

    act(() => {
      vi.advanceTimersByTime(2199);
    });
    expect(toast).toHaveClass("is-on");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toast).not.toHaveClass("is-on");
  });

  it("restarts the timer when a new toast replaces the current one", async () => {
    renderApp({ settings: { enabledMarketplaces: ["US"] } });
    const cta = await screen.findByRole("button", { name: "Check 0 other Amazons" });
    vi.useFakeTimers();

    fireEvent.click(cta);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fireEvent.click(cta);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status")).toHaveClass("is-on");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("status", { hidden: true })).not.toHaveClass("is-on");
  });

  it("is hidden from assistive technology while it is not shown", async () => {
    renderApp({ settings: { enabledMarketplaces: ["US"] } });
    const cta = await screen.findByRole("button", { name: "Check 0 other Amazons" });
    const toast = screen.getByRole("status", { hidden: true });
    expect(toast).toHaveAttribute("aria-hidden", "true");
    expect(toast).toBeEmptyDOMElement();
    vi.useFakeTimers();

    fireEvent.click(cta);
    expect(screen.getByRole("status")).toBe(toast);
    expect(toast).not.toHaveAttribute("aria-hidden");

    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(toast).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("re-renders a repeated identical message so it is announced again", async () => {
    renderApp({ settings: { enabledMarketplaces: ["US"] } });
    const cta = await screen.findByRole("button", { name: "Check 0 other Amazons" });

    fireEvent.click(cta);
    const first = screen.getByRole("status").firstElementChild;
    fireEvent.click(cta);
    const second = screen.getByRole("status").firstElementChild;

    expect(first).toHaveTextContent("Pick at least one marketplace to check.");
    expect(second).toHaveTextContent("Pick at least one marketplace to check.");
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
  });
});
