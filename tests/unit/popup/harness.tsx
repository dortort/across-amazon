import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../../../src/popup/App";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../../../src/shared/messages";
import {
  ACTIVE_TAB_ID,
  DEFAULT_SETTINGS,
  GENERATED_AT,
  SETTINGS_KEY,
  baseline,
  fxTable,
  mockupResults,
  source
} from "../../fixtures/popup";
import type {
  ExtensionSettings,
  LoadSourcePayload,
  RunComparisonProgressPayload,
  RunComparisonResultPayload
} from "../../../src/shared/types";

export {
  ACTIVE_TAB_ID,
  DEFAULT_SETTINGS,
  MINUS,
  NBSP,
  SETTINGS_KEY,
  TARGET_ORDER,
  au,
  baseline,
  ca,
  de,
  es,
  fr,
  fxTable,
  it_,
  jp,
  mockupResults,
  money,
  mx,
  productUrl,
  source,
  uk
} from "../../fixtures/popup";

export function resultPayload(overrides: Partial<RunComparisonResultPayload> = {}): RunComparisonResultPayload {
  return {
    source,
    baseline,
    results: mockupResults,
    generatedAt: GENERATED_AT,
    fxTable,
    ...overrides
  };
}

export interface ChromeMockOptions {
  loadSource?: LoadSourcePayload;
  pendingLoadSource?: boolean;
  runResponse?: () => Promise<unknown>;
  tabs?: Array<{ id?: number; url?: string }>;
  settings?: Partial<ExtensionSettings>;
  withStorage?: boolean;
}

interface SentMessage {
  type: string;
  payload?: { activeTabId?: number; runId?: string };
}

type Listener = (message: unknown) => void;

export function installChrome(options: ChromeMockOptions = {}) {
  const listeners = new Set<Listener>();
  const store: Record<string, unknown> = options.settings
    ? { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...options.settings } }
    : {};

  const sendMessage = vi.fn(async (message: SentMessage): Promise<unknown> => {
    if (message.type === LOAD_SOURCE) {
      return options.pendingLoadSource ? new Promise(() => undefined) : (options.loadSource ?? { source, baseline });
    }
    if (message.type === RUN_COMPARISON && options.runResponse) {
      return options.runResponse();
    }
    return { ok: true };
  });
  const query = vi.fn(async () => options.tabs ?? [{ id: ACTIVE_TAB_ID, url: source.sourceUrl }]);
  const create = vi.fn(async (properties: { url?: string; active?: boolean }) => ({ id: 99, ...properties }));
  const get = vi.fn(async (key: string) => ({ [key]: store[key] }));
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  const addListener = vi.fn((listener: Listener) => {
    listeners.add(listener);
  });
  const removeListener = vi.fn((listener: Listener) => {
    listeners.delete(listener);
  });

  vi.stubGlobal("chrome", {
    tabs: { query, create },
    runtime: { sendMessage, onMessage: { addListener, removeListener } },
    ...(options.withStorage === false ? {} : { storage: { local: { get, set } } })
  });

  const emit = (message: unknown): void => {
    act(() => {
      listeners.forEach((listener) => listener(message));
    });
  };

  const sentOfType = (type: string): SentMessage[] =>
    sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === type);

  const runId = (index: number): string => {
    const id = sentOfType(RUN_COMPARISON)[index]?.payload?.runId;
    if (!id) {
      throw new Error(`no run id for run request ${index}`);
    }
    return id;
  };

  return {
    store,
    listeners,
    sendMessage,
    query,
    create,
    get,
    set,
    addListener,
    removeListener,
    sentOfType,
    runRequests: () => sentOfType(RUN_COMPARISON),
    runId,
    cancelRequests: () => sentOfType(CANCEL_COMPARISON),
    progress: (payload: RunComparisonProgressPayload) => emit({ type: RUN_COMPARISON_PROGRESS, payload }),
    result: (payload: RunComparisonResultPayload) => emit({ type: RUN_COMPARISON_RESULT, payload })
  };
}

export function renderApp(options: ChromeMockOptions = {}) {
  const chromeMock = installChrome(options);
  const user = userEvent.setup();
  const view = render(<App />);
  return { ...chromeMock, ...view, user };
}

export async function renderLoaded(options: ChromeMockOptions = {}) {
  const app = renderApp(options);
  await screen.findByRole("heading", { name: (options.loadSource?.source ?? source).title });
  return app;
}

export async function renderRunning(options: ChromeMockOptions = {}) {
  const app = await renderLoaded(options);
  await app.user.click(screen.getByRole("button", { name: /^Check \d+ other Amazons?$/ }));
  return app;
}

export async function renderDone(
  payload: RunComparisonResultPayload = resultPayload(),
  options: ChromeMockOptions = {}
) {
  const app = await renderRunning(options);
  app.result(payload);
  return app;
}

export function rowElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".dB-list .dB-row"));
}

export function rowSummary(row: HTMLElement) {
  return {
    name: row.querySelector(".who strong")?.firstChild?.textContent,
    local: row.querySelector(".who > span")?.textContent,
    total: row.querySelector(".amt strong")?.textContent,
    delta: row.querySelector(".amt > span")?.textContent,
    deltaClass: row.querySelector(".amt > span")?.className,
    best: row.classList.contains("best"),
    pill: row.querySelector(".dB-flag-pill")?.textContent ?? null
  };
}
