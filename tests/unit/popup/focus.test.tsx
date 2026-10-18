import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLoaded, renderRunning, resultPayload } from "./harness";

afterEach(() => {
  vi.unstubAllGlobals();
});

function scrollContainer(container: HTMLElement): HTMLElement {
  const scroll = container.querySelector<HTMLElement>(".dB-scroll");
  if (!scroll) {
    throw new Error("scroll container missing");
  }
  return scroll;
}

function expectFocusAtTopOf(container: HTMLElement, marker: string): void {
  const scroll = scrollContainer(container);
  expect(scroll.querySelector(marker)).not.toBeNull();
  expect(scroll).toHaveAttribute("tabindex", "-1");
  expect(scroll).toHaveFocus();
}

describe("focus after a view swap", () => {
  it("leaves focus alone when the popup first opens", async () => {
    await renderLoaded();

    expect(document.body).toHaveFocus();
  });

  it("lands on the running view when a check starts", async () => {
    const app = await renderRunning();

    expectFocusAtTopOf(app.container, ".dB-run");
  });

  it("lands on the done view when the result arrives", async () => {
    const app = await renderRunning();

    app.result(resultPayload({ runId: app.runId(0) }));

    expectFocusAtTopOf(app.container, ".dB-verdict");
  });

  it("lands on the idle view after Stop", async () => {
    const app = await renderRunning();

    await app.user.click(screen.getByRole("button", { name: "Stop checking" }));

    expectFocusAtTopOf(app.container, ".dB-prod");
  });

  it("lands on the settings view when it opens and on the previous view when it closes", async () => {
    const app = await renderLoaded();

    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    expectFocusAtTopOf(app.container, ".dB-set");

    await app.user.click(screen.getByRole("button", { name: "Close settings" }));
    expectFocusAtTopOf(app.container, ".dB-prod");
  });

  it("keeps focus in settings while a run finishes behind it", async () => {
    const app = await renderRunning();
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    const usd = screen.getByRole("button", { name: "USD" });
    usd.focus();

    app.result(resultPayload({ runId: app.runId(0) }));

    expect(usd).toHaveFocus();
  });

  it("does not move focus when only the progress changes", async () => {
    const app = await renderRunning();
    const stop = screen.getByRole("button", { name: "Stop checking" });
    stop.focus();

    app.progress({ completed: 3, total: 9, currentMarketplace: "DE", phase: "READ", runId: app.runId(0), results: [] });

    expect(stop).toHaveFocus();
  });
});
