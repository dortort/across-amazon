import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_COMPARISON, RUN_COMPARISON } from "../../../src/shared/messages";
import type { ComparisonPhase, Marketplace, RunComparisonProgressPayload } from "../../../src/shared/types";
import {
  ACTIVE_TAB_ID,
  au,
  ca,
  de,
  fxTable,
  it_,
  jp,
  mx,
  renderLoaded,
  renderRunning,
  resultPayload,
  uk
} from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function now(
  ...entries: Array<[Marketplace, ComparisonPhase]>
): Pick<RunComparisonProgressPayload, "inFlight" | "latest"> {
  const inFlight = entries.map(([marketplace, phase]) => ({ marketplace, phase }));
  return { inFlight, latest: inFlight[0] };
}

function runningState(container: HTMLElement) {
  return {
    dial: container.querySelector<HTMLElement>(".dB-dial")?.style.getPropertyValue("--p"),
    count: container.querySelector(".dB-dial-num")?.textContent,
    nowline: container.querySelector(".dB-nowline")?.textContent,
    market: container.querySelector(".dB-nowline b")?.textContent,
    domain: container.querySelector(".dB-nowsub")?.textContent,
    chips: Array.from(container.querySelectorAll(".dB-chk")).map((chip) => [chip.className, chip.textContent])
  };
}

describe("running view", () => {
  it("shows the first target being checked before any progress arrives", async () => {
    const app = await renderRunning();

    expect(runningState(app.container)).toEqual({
      dial: "0%",
      count: "0/9",
      nowline: "Checking Canada",
      market: "Canada",
      domain: "amazon.ca",
      chips: [["dB-chk now", "🇨🇦 CA …"]]
    });
  });

  it("follows each progress message: dial, count, phase, market, domain and chips", async () => {
    const app = await renderRunning();

    app.progress({ completed: 0, total: 9, ...now(["CA", "SEARCH"], ["MX", "OPEN"], ["UK", "OPEN"]), results: [] });
    expect(runningState(app.container)).toEqual({
      dial: "0%",
      count: "0/9",
      nowline: "Searching Canada +2",
      market: "Canada",
      domain: "amazon.ca",
      chips: [
        ["dB-chk now", "🇨🇦 CA …"],
        ["dB-chk now", "🇲🇽 MX …"],
        ["dB-chk now", "🇬🇧 UK …"]
      ]
    });

    app.progress({
      completed: 4,
      total: 9,
      ...now(["FR", "MATCH"], ["IT", "SEARCH"], ["ES", "OPEN"]),
      results: [de, uk, ca, mx]
    });
    expect(runningState(app.container)).toEqual({
      dial: "44%",
      count: "4/9",
      nowline: "Matching product France +2",
      market: "France",
      domain: "amazon.fr",
      chips: [
        ["dB-chk ok", "🇨🇦 CA $391.44"],
        ["dB-chk bad", "🇲🇽 MX —"],
        ["dB-chk ok", "🇬🇧 UK $372.16"],
        ["dB-chk ok", "🇩🇪 DE $349.05"],
        ["dB-chk now", "🇫🇷 FR …"],
        ["dB-chk now", "🇮🇹 IT …"],
        ["dB-chk now", "🇪🇸 ES …"]
      ]
    });

    app.progress({ completed: 8, total: 9, ...now(["AU", "READ"]), results: [de, it_, uk, ca, mx, jp] });
    const state = runningState(app.container);
    expect(state.dial).toBe("89%");
    expect(state.count).toBe("8/9");
    expect(state.nowline).toBe("Reading cost stack Australia");
    expect(state.domain).toBe("amazon.com.au");
    expect(state.chips).toEqual([
      ["dB-chk ok", "🇨🇦 CA $391.44"],
      ["dB-chk bad", "🇲🇽 MX —"],
      ["dB-chk ok", "🇬🇧 UK $372.16"],
      ["dB-chk ok", "🇩🇪 DE $349.05"],
      ["dB-chk ok", "🇮🇹 IT $361.37"],
      ["dB-chk bad", "🇯🇵 JP —"],
      ["dB-chk now", "🇦🇺 AU …"]
    ]);
  });

  it("keeps chips in check order when a cheaper market is reported later", async () => {
    const app = await renderRunning();
    const okChips = () => runningState(app.container).chips.filter(([className]) => className !== "dB-chk now");

    app.progress({ completed: 1, total: 9, ...now(["MX", "OPEN"]), results: [ca] });
    app.progress({ completed: 3, total: 9, ...now(["DE", "OPEN"]), results: [uk, ca, mx] });
    const before = okChips();
    app.progress({ completed: 4, total: 9, ...now(["FR", "OPEN"]), results: [de, uk, ca, mx] });

    expect(before.map(([, text]) => text)).toEqual(["🇨🇦 CA $391.44", "🇲🇽 MX —", "🇬🇧 UK $372.16"]);
    expect(okChips().slice(0, 3)).toEqual(before);
    expect(okChips()[3]).toEqual(["dB-chk ok", "🇩🇪 DE $349.05"]);
  });

  it("places each running store's chip among the finished ones in check order", async () => {
    const app = await renderRunning();

    app.progress({
      completed: 3,
      total: 9,
      ...now(["MX", "MATCH"], ["FR", "SEARCH"], ["IT", "OPEN"]),
      results: [de, uk, ca]
    });

    expect(runningState(app.container).chips).toEqual([
      ["dB-chk ok", "🇨🇦 CA $391.44"],
      ["dB-chk now", "🇲🇽 MX …"],
      ["dB-chk ok", "🇬🇧 UK $372.16"],
      ["dB-chk ok", "🇩🇪 DE $349.05"],
      ["dB-chk now", "🇫🇷 FR …"],
      ["dB-chk now", "🇮🇹 IT …"]
    ]);
  });

  it("follows the order of the marketplaces the run checks", async () => {
    const app = await renderRunning({ settings: { enabledMarketplaces: ["US", "UK", "DE", "AU"] } });

    app.progress({ completed: 3, total: 3, inFlight: [], results: [de, au, uk] });

    expect(runningState(app.container).chips.map(([, text]) => text)).toEqual([
      "🇬🇧 UK $372.16",
      "🇩🇪 DE $349.05",
      "🇦🇺 AU $438.72"
    ]);
  });

  it("announces the current step politely", async () => {
    const app = await renderRunning();

    expect(app.container.querySelector(".dB-nowline")).toHaveAttribute("aria-live", "polite");
  });

  it("names the store that last moved on, else the first one still running", async () => {
    const app = await renderRunning();

    app.progress({
      completed: 0,
      total: 9,
      ...now(["CA", "SEARCH"], ["MX", "OPEN"], ["UK", "MATCH"]),
      latest: { marketplace: "UK", phase: "MATCH" },
      results: []
    });
    expect(runningState(app.container)).toMatchObject({
      nowline: "Matching product United Kingdom +2",
      market: "United Kingdom",
      domain: "amazon.co.uk"
    });

    app.progress({ completed: 1, total: 9, inFlight: now(["MX", "OPEN"], ["UK", "MATCH"]).inFlight, results: [ca] });
    expect(runningState(app.container)).toMatchObject({
      count: "1/9",
      nowline: "Checking Mexico +1",
      market: "Mexico",
      domain: "amazon.com.mx"
    });
  });

  it("names the first store when a message names none", async () => {
    const app = await renderRunning();

    app.progress({ completed: 1, total: 9, inFlight: now(["MX", "SEARCH"], ["UK", "OPEN"]).inFlight, results: [ca] });

    expect(runningState(app.container).nowline).toBe("Searching Mexico +1");
    expect(runningState(app.container).count).toBe("1/9");
  });

  it("drops every running chip on the final progress message", async () => {
    const app = await renderRunning();

    app.progress({ completed: 7, total: 9, ...now(["JP", "READ"], ["AU", "SEARCH"]), results: [de, uk] });
    app.progress({ completed: 9, total: 9, inFlight: [], results: [de, uk] });

    const state = runningState(app.container);
    expect(state.dial).toBe("100%");
    expect(state.count).toBe("9/9");
    expect(state.nowline).toBe("");
    expect(state.domain).toBe("");
    expect(state.chips.map(([className]) => className)).toEqual(["dB-chk ok", "dB-chk ok"]);
  });

  it("switches to the done view when the result arrives", async () => {
    const app = await renderRunning();

    app.progress({ completed: 4, total: 9, ...now(["FR", "OPEN"]), results: [de] });
    app.result(resultPayload());

    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop checking" })).not.toBeInTheDocument();
  });

  it("adopts a run already in flight when progress arrives while idle", async () => {
    const app = await renderLoaded();

    app.progress({ completed: 2, total: 5, ...now(["DE", "SEARCH"]), results: [uk, ca] });

    expect(runningState(app.container).count).toBe("2/5");
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeInTheDocument();
  });
});

describe("stopping a run", () => {
  it("sends CANCEL_COMPARISON, returns to idle and confirms in a toast", async () => {
    const app = await renderRunning();
    app.progress({ completed: 3, total: 9, ...now(["DE", "READ"]), results: [ca, mx, uk] });

    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));

    expect(app.cancelRequests()).toEqual([{ type: CANCEL_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } }]);
    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeEnabled();
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Stopped. No background tabs left open.");
    expect(screen.getByRole("status")).toHaveClass("is-on");
  });

  it("ignores the cancelled run's late result and progress messages", async () => {
    const app = await renderRunning();

    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));
    app.progress({ completed: 4, total: 9, ...now(["FR", "OPEN"]), results: [de] });
    app.result(resultPayload({ results: [ca, mx, uk], error: "Comparison cancelled by user" }));

    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    expect(screen.queryByText("Every marketplace")).not.toBeInTheDocument();
    expect(app.container.querySelector(".dB-run")).toBeNull();
  });

  it("accepts messages again once a new run starts", async () => {
    const app = await renderRunning();
    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));

    await app.user.click(screen.getByRole("button", { name: "Check 9 other Amazons" }));
    app.progress({ completed: 1, total: 9, ...now(["MX", "SEARCH"]), results: [ca] });
    expect(runningState(app.container).count).toBe("1/9");

    app.result(resultPayload());
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(app.runRequests()).toEqual([
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId: expect.any(String) } },
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID, runId: expect.any(String) } }
    ]);
    expect(app.runId(1)).not.toBe(app.runId(0));
  });
});

describe("run correlation", () => {
  it("ignores a late result from a cancelled run after a re-run", async () => {
    const app = await renderRunning();
    const cancelledRun = app.runId(0);
    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));
    await app.user.click(screen.getByRole("button", { name: "Check 9 other Amazons" }));
    const currentRun = app.runId(1);

    app.progress({ completed: 6, total: 9, ...now(["ES", "OPEN"]), runId: cancelledRun, results: [ca, mx] });
    app.result(resultPayload({ runId: cancelledRun, activeTabId: ACTIVE_TAB_ID }));

    expect(runningState(app.container).count).toBe("0/9");
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeInTheDocument();
    expect(screen.queryByText("Save $50.94")).not.toBeInTheDocument();

    app.progress({ completed: 1, total: 9, ...now(["MX", "OPEN"]), runId: currentRun, results: [ca] });
    expect(runningState(app.container).count).toBe("1/9");
    app.result(resultPayload({ runId: currentRun, activeTabId: ACTIVE_TAB_ID }));
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
  });

  it("ignores messages after Stop that carry the cancelled run id", async () => {
    const app = await renderRunning();
    const cancelledRun = app.runId(0);
    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));

    app.progress({ completed: 2, total: 9, ...now(["UK", "OPEN"]), runId: cancelledRun, results: [ca, mx] });
    app.result(resultPayload({ runId: cancelledRun }));

    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeInTheDocument();
    expect(app.container.querySelector(".dB-run")).toBeNull();
    expect(app.container.querySelector(".dB-verdict")).toBeNull();
  });

  it("ignores progress and results for another tab", async () => {
    const app = await renderRunning();
    const runId = app.runId(0);

    app.progress({ completed: 5, total: 9, ...now(["IT", "OPEN"]), activeTabId: 7, runId, results: [ca] });
    app.result(resultPayload({ activeTabId: 7, runId }));

    expect(runningState(app.container).count).toBe("0/9");
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeInTheDocument();

    app.progress({ completed: 1, total: 9, ...now(["MX", "OPEN"]), activeTabId: ACTIVE_TAB_ID, runId, results: [ca] });
    expect(runningState(app.container).count).toBe("1/9");
  });

  it("does not adopt another tab's run while idle", async () => {
    const app = await renderLoaded();

    app.progress({ completed: 2, total: 5, ...now(["DE", "OPEN"]), activeTabId: 7, runId: "other-tab", results: [] });
    app.result(resultPayload({ activeTabId: 7, runId: "other-tab" }));

    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeInTheDocument();
    expect(app.container.querySelector(".dB-run")).toBeNull();
    expect(app.container.querySelector(".dB-verdict")).toBeNull();
  });

  it("adopts a run in flight for its own tab and then follows only that run", async () => {
    const app = await renderLoaded();

    app.progress({
      completed: 2,
      total: 5,
      ...now(["DE", "SEARCH"]),
      activeTabId: ACTIVE_TAB_ID,
      runId: "in-flight",
      results: [uk, ca]
    });
    expect(runningState(app.container).count).toBe("2/5");

    app.progress({ completed: 4, total: 5, ...now(["AU", "OPEN"]), runId: "someone-else", results: [uk, ca, de] });
    app.result(resultPayload({ runId: "someone-else", activeTabId: ACTIVE_TAB_ID }));
    expect(runningState(app.container).count).toBe("2/5");

    app.result(resultPayload({ runId: "in-flight", activeTabId: ACTIVE_TAB_ID }));
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(app.runRequests()).toEqual([]);
  });

  it("ignores progress that arrives after the run's result", async () => {
    const app = await renderRunning();
    const runId = app.runId(0);

    app.result(resultPayload({ runId }));
    app.progress({ completed: 9, total: 9, inFlight: [], runId, results: [de] });

    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(app.container.querySelector(".dB-run")).toBeNull();
  });

  it("converts chip amounts with the progress rates after switching currency mid-run", async () => {
    const app = await renderRunning();
    const runId = app.runId(0);
    const results = [
      { ...ca, normalizedTotal: undefined },
      { ...de, normalizedTotal: undefined }
    ];
    app.progress({ completed: 2, total: 9, ...now(["FR", "OPEN"]), runId, results, fxTable });
    expect(runningState(app.container).chips.slice(0, 2).map(([, text]) => text)).toEqual([
      "🇨🇦 CA $391.44",
      "🇩🇪 DE $349.05"
    ]);
    expect(screen.getByText(`Rates ${fxTable.date}`)).toBeInTheDocument();

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await app.user.click(screen.getByRole("button", { name: "EUR" }));
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(runningState(app.container).chips.map(([, text]) => text)).toEqual([
      "🇨🇦 CA €362.44",
      "🇩🇪 DE €323.19",
      "🇫🇷 FR …"
    ]);
  });
});

describe("run delivery", () => {
  it("shows an error instead of spinning forever when the background cannot be reached", async () => {
    const app = await renderRunning({
      runResponse: async () => {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
    });

    expect(await screen.findByText("Could not reach the background service")).toHaveClass("lede");
    expect(app.container.querySelector(".dB-verdict")).toHaveClass("is-muted");
    expect(screen.getByText("Couldn't compare")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop checking" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("treats a response without ok as undelivered", async () => {
    const app = await renderRunning({ runResponse: async () => ({ ok: false, error: "Unsupported message" }) });

    expect(await screen.findByText("Could not reach the background service")).toBeInTheDocument();
    expect(app.container.querySelector(".dB-run")).toBeNull();
  });

  it("treats a missing response as undelivered", async () => {
    await renderRunning({ runResponse: async () => undefined });

    expect(await screen.findByText("Could not reach the background service")).toBeInTheDocument();
  });

  it("keeps the marketplaces checked so far when the background stops answering", async () => {
    let fail: (error: Error) => void = () => undefined;
    const app = await renderRunning({
      runResponse: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    });
    app.progress({ completed: 2, total: 9, ...now(["UK", "SEARCH"]), results: [ca, de] });

    fail(new Error("The message port closed before a response was received."));

    expect(await screen.findByText("Could not reach the background service")).toBeInTheDocument();
    expect(Array.from(app.container.querySelectorAll(".dB-row .who strong")).map((name) => name.textContent)).toEqual([
      "Germany",
      "Canada",
      "United States"
    ]);
  });

  it("ignores a delivery failure that arrives after the result", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const app = await renderRunning({
      runResponse: () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    });
    app.result(resultPayload({ runId: app.runId(0) }));

    await act(async () => {
      answer({ ok: false });
    });

    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(screen.queryByText("Could not reach the background service")).not.toBeInTheDocument();
  });

  it("ignores a delivery failure after Stop", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const app = await renderRunning({
      runResponse: () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    });
    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));

    await act(async () => {
      answer(undefined);
    });

    expect(screen.getByRole("button", { name: "Check 9 other Amazons" })).toBeInTheDocument();
    expect(screen.queryByText("Could not reach the background service")).not.toBeInTheDocument();
  });
});

describe("settings during a run", () => {
  it("stays in settings while progress and the result arrive, then returns to done", async () => {
    const app = await renderRunning();
    app.progress({ completed: 1, total: 9, ...now(["MX", "OPEN"]), results: [ca] });

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    app.progress({ completed: 5, total: 9, ...now(["IT", "MATCH"]), results: [ca, mx, uk, de] });

    expect(screen.getByRole("heading", { name: "Show prices in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop checking" })).not.toBeInTheDocument();

    app.result(resultPayload());
    expect(screen.getByRole("heading", { name: "Show prices in" })).toBeInTheDocument();
    expect(screen.queryByText("Save $50.94")).not.toBeInTheDocument();

    await app.user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
  });

  it("returns to the running view with the latest progress when closed mid-run", async () => {
    const app = await renderRunning();
    app.progress({ completed: 1, total: 9, ...now(["MX", "OPEN"]), results: [ca] });

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    app.progress({ completed: 5, total: 9, ...now(["IT", "MATCH"]), results: [ca, mx, uk, de] });
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(runningState(app.container)).toMatchObject({
      count: "5/9",
      dial: "56%",
      nowline: "Matching product Italy"
    });
  });
});
