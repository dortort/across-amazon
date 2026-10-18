import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANCEL_COMPARISON, RUN_COMPARISON } from "../../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  ca,
  de,
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
  it("follows each progress message: dial, count, phase, market, domain and chips", async () => {
    const app = await renderRunning();

    app.progress({ completed: 0, total: 9, currentMarketplace: "CA", phase: "SEARCH", results: [] });
    expect(runningState(app.container)).toEqual({
      dial: "0%",
      count: "0/9",
      nowline: "Searching Canada",
      market: "Canada",
      domain: "amazon.ca",
      chips: [["dB-chk now", "🇨🇦 CA …"]]
    });

    app.progress({ completed: 4, total: 9, currentMarketplace: "FR", phase: "MATCH", results: [de, uk, ca, mx] });
    expect(runningState(app.container)).toEqual({
      dial: "44%",
      count: "4/9",
      nowline: "Matching product France",
      market: "France",
      domain: "amazon.fr",
      chips: [
        ["dB-chk ok", "🇩🇪 DE $349.05"],
        ["dB-chk ok", "🇬🇧 UK $372.16"],
        ["dB-chk ok", "🇨🇦 CA $391.44"],
        ["dB-chk bad", "🇲🇽 MX —"],
        ["dB-chk now", "🇫🇷 FR …"]
      ]
    });

    app.progress({
      completed: 8,
      total: 9,
      currentMarketplace: "AU",
      phase: "READ",
      results: [de, it_, uk, ca, mx, jp]
    });
    const state = runningState(app.container);
    expect(state.dial).toBe("89%");
    expect(state.count).toBe("8/9");
    expect(state.nowline).toBe("Reading cost stack Australia");
    expect(state.domain).toBe("amazon.com.au");
    expect(state.chips).toHaveLength(7);
    expect(state.chips[1]).toEqual(["dB-chk ok", "🇮🇹 IT $361.37"]);
    expect(state.chips[5]).toEqual(["dB-chk bad", "🇯🇵 JP —"]);
  });

  it("shows the opening phase when a progress message carries no phase", async () => {
    const app = await renderRunning();

    app.progress({ completed: 1, total: 9, currentMarketplace: "MX", results: [ca] });

    expect(runningState(app.container).nowline).toBe("Opening tab Mexico");
    expect(runningState(app.container).count).toBe("1/9");
  });

  it("drops the current-market chip on the final progress message", async () => {
    const app = await renderRunning();

    app.progress({ completed: 9, total: 9, results: [de, uk] });

    const state = runningState(app.container);
    expect(state.dial).toBe("100%");
    expect(state.count).toBe("9/9");
    expect(state.chips.map(([className]) => className)).toEqual(["dB-chk ok", "dB-chk ok"]);
  });

  it("switches to the done view when the result arrives", async () => {
    const app = await renderRunning();

    app.progress({ completed: 4, total: 9, currentMarketplace: "FR", phase: "OPEN", results: [de] });
    app.result(resultPayload());

    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop checking" })).not.toBeInTheDocument();
  });

  it("adopts a run already in flight when progress arrives while idle", async () => {
    const app = await renderLoaded();

    app.progress({ completed: 2, total: 5, currentMarketplace: "DE", phase: "SEARCH", results: [uk, ca] });

    expect(runningState(app.container).count).toBe("2/5");
    expect(screen.getByRole("button", { name: "Stop checking" })).toBeInTheDocument();
  });
});

describe("stopping a run", () => {
  it("sends CANCEL_COMPARISON, returns to idle and confirms in a toast", async () => {
    const app = await renderRunning();
    app.progress({ completed: 3, total: 9, currentMarketplace: "DE", phase: "READ", results: [ca, mx, uk] });

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
    app.progress({ completed: 4, total: 9, currentMarketplace: "FR", phase: "OPEN", results: [de] });
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
    app.progress({ completed: 1, total: 9, currentMarketplace: "MX", phase: "SEARCH", results: [ca] });
    expect(runningState(app.container).count).toBe("1/9");

    app.result(resultPayload());
    expect(screen.getByText("Save $50.94")).toBeInTheDocument();
    expect(app.runRequests()).toEqual([
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } },
      { type: RUN_COMPARISON, payload: { activeTabId: ACTIVE_TAB_ID } }
    ]);
  });
});

describe("settings during a run", () => {
  it("stays in settings while progress and the result arrive, then returns to done", async () => {
    const app = await renderRunning();
    app.progress({ completed: 1, total: 9, currentMarketplace: "MX", phase: "OPEN", results: [ca] });

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    app.progress({ completed: 5, total: 9, currentMarketplace: "IT", phase: "MATCH", results: [ca, mx, uk, de] });

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
    app.progress({ completed: 1, total: 9, currentMarketplace: "MX", phase: "OPEN", results: [ca] });

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    app.progress({ completed: 5, total: 9, currentMarketplace: "IT", phase: "MATCH", results: [ca, mx, uk, de] });
    await app.user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(runningState(app.container)).toMatchObject({
      count: "5/9",
      dial: "56%",
      nowline: "Matching product Italy"
    });
  });
});
