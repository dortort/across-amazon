import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ReactElement } from "react";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../shared/messages";
import type { ExtensionMessage } from "../shared/messages";
import { MARKETPLACE_CODES, countryName, getMarketplaceByDomain, marketDisplayDomain } from "../shared/markets";
import { loadSettings, saveSettings } from "../shared/storage";
import type {
  ComparisonResult,
  ExtensionSettings,
  FxTable,
  LoadSourcePayload,
  Marketplace,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SourceContext
} from "../shared/types";
import { DetailSheet } from "./components/DetailSheet";
import { DoneView } from "./components/DoneView";
import { Footer } from "./components/Footer";
import { IdleView } from "./components/IdleView";
import type { SourceStatus } from "./components/IdleView";
import { RunningView } from "./components/RunningView";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/Toast";
import type { ToastState } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { computeVerdict, issues, rankedRows, resolveDisplayCurrency, targetMarkets } from "./view-model";
import type { VerdictView } from "./view-model";

const TOAST_MS = 2200;
const BACKGROUND_UNREACHABLE = "Could not reach the background service";

const FALLBACK_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE"
};

type RunPhase = "none" | "active" | "finished" | "cancelled";

interface RunCorrelation {
  activeTabId?: number;
  runId?: string;
}

interface ActiveTab {
  id?: number;
  url?: string;
}

interface PopupState {
  view: VerdictView;
  returnView?: VerdictView;
  activeTabId?: number;
  sourceStatus: SourceStatus;
  source?: SourceContext;
  baseline?: ComparisonResult;
  results: ComparisonResult[];
  fxTable?: FxTable;
  progress?: RunComparisonProgressPayload;
  runTargets: Marketplace[];
  runId?: string;
  runPhase: RunPhase;
  error?: string;
  generatedAt?: string;
  sheet?: Marketplace;
  issuesOpen: boolean;
  toast?: ToastState;
  settings: ExtensionSettings;
}

type PopupAction =
  | { type: "tab-resolved"; activeTabId?: number; supported: boolean }
  | { type: "settings-changed"; settings: ExtensionSettings }
  | { type: "source-loaded"; payload: LoadSourcePayload }
  | { type: "run-started"; targets: Marketplace[]; runId: string }
  | { type: "run-cancelled" }
  | { type: "run-undelivered"; runId: string; generatedAt: string }
  | { type: "progress"; payload: RunComparisonProgressPayload }
  | { type: "result"; payload: RunComparisonResultPayload }
  | { type: "settings-toggled" }
  | { type: "sheet-opened"; marketplace: Marketplace }
  | { type: "sheet-closed" }
  | { type: "issues-toggled" }
  | { type: "toast-shown"; text: string }
  | { type: "toast-hidden"; id: number };

const initialState: PopupState = {
  view: "idle",
  sourceStatus: "loading",
  results: [],
  runTargets: [],
  runPhase: "none",
  issuesOpen: false,
  settings: FALLBACK_SETTINGS
};

function belongsToRun(state: PopupState, payload: RunCorrelation): boolean {
  if (payload.activeTabId !== undefined && payload.activeTabId !== state.activeTabId) {
    return false;
  }
  switch (state.runPhase) {
    case "none":
      return true;
    case "active":
      return payload.runId === undefined || state.runId === undefined || payload.runId === state.runId;
    default:
      return false;
  }
}

function applyResult(state: PopupState, payload: RunComparisonResultPayload): PopupState {
  const next: PopupState = {
    ...state,
    runPhase: "finished",
    runId: state.runId ?? payload.runId,
    source: payload.source ?? state.source,
    baseline: payload.baseline ?? state.baseline,
    fxTable: payload.fxTable ?? state.fxTable,
    results: payload.results,
    error: payload.error,
    generatedAt: payload.generatedAt,
    progress: undefined
  };
  return state.view === "settings" ? { ...next, returnView: "done" } : { ...next, view: "done" };
}

function reducer(state: PopupState, action: PopupAction): PopupState {
  switch (action.type) {
    case "tab-resolved":
      return {
        ...state,
        activeTabId: action.activeTabId,
        sourceStatus: action.activeTabId === undefined || !action.supported ? "failed" : state.sourceStatus
      };
    case "settings-changed":
      return { ...state, settings: action.settings };
    case "source-loaded": {
      const source = state.source ?? (action.payload.error ? undefined : action.payload.source);
      return {
        ...state,
        source,
        baseline: state.baseline ?? (source ? action.payload.baseline : undefined),
        sourceStatus: source ? "ready" : "failed"
      };
    }
    case "run-started":
      return {
        ...state,
        view: "running",
        returnView: undefined,
        runTargets: action.targets,
        runId: action.runId,
        runPhase: "active",
        progress: undefined,
        results: [],
        error: undefined,
        sheet: undefined,
        issuesOpen: false
      };
    case "run-cancelled":
      return { ...state, view: "idle", progress: undefined, results: [], error: undefined, runPhase: "cancelled" };
    case "run-undelivered":
      if (state.runPhase !== "active" || state.runId !== action.runId) {
        return state;
      }
      return applyResult(state, {
        results: state.progress?.results ?? [],
        generatedAt: action.generatedAt,
        error: BACKGROUND_UNREACHABLE
      });
    case "progress": {
      const { payload } = action;
      if (!belongsToRun(state, payload)) {
        return state;
      }
      const tracked: PopupState = {
        ...state,
        runPhase: "active",
        runId: state.runId ?? payload.runId,
        progress: payload,
        fxTable: payload.fxTable ?? state.fxTable
      };
      return state.view === "settings"
        ? { ...tracked, returnView: "running" }
        : { ...tracked, view: "running", sheet: undefined };
    }
    case "result":
      return belongsToRun(state, action.payload) ? applyResult(state, action.payload) : state;
    case "settings-toggled":
      if (state.view === "settings") {
        return {
          ...state,
          view: state.returnView ?? (state.results.length > 0 ? "done" : "idle"),
          returnView: undefined
        };
      }
      return { ...state, view: "settings", returnView: state.view, sheet: undefined };
    case "sheet-opened":
      return { ...state, sheet: action.marketplace };
    case "sheet-closed":
      return state.sheet ? { ...state, sheet: undefined } : state;
    case "issues-toggled":
      return { ...state, issuesOpen: !state.issuesOpen };
    case "toast-shown":
      return { ...state, toast: { id: (state.toast?.id ?? 0) + 1, text: action.text, visible: true } };
    case "toast-hidden":
      return state.toast?.id === action.id ? { ...state, toast: { ...state.toast, visible: false } } : state;
  }
}

function chromeApi(): typeof chrome | undefined {
  return typeof chrome === "undefined" ? undefined : chrome;
}

async function queryActiveTab(): Promise<ActiveTab> {
  try {
    const tabs = await chromeApi()?.tabs?.query({ active: true, currentWindow: true });
    return { id: tabs?.[0]?.id, url: tabs?.[0]?.url };
  } catch {
    return {};
  }
}

function isSupportedMarketplaceUrl(url?: string): boolean {
  if (!url) {
    return false;
  }
  try {
    return getMarketplaceByDomain(new URL(url).hostname) !== undefined;
  } catch {
    return false;
  }
}

function createRunId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function sendMessage(message: ExtensionMessage): Promise<unknown> {
  try {
    return await chromeApi()?.runtime?.sendMessage(message);
  } catch {
    return undefined;
  }
}

async function requestSource(activeTabId: number): Promise<LoadSourcePayload> {
  const response = await sendMessage({ type: LOAD_SOURCE, payload: { activeTabId } });
  return response && typeof response === "object" ? (response as LoadSourcePayload) : { error: "No response" };
}

async function requestRun(activeTabId: number, runId: string): Promise<boolean> {
  const response = await sendMessage({ type: RUN_COMPARISON, payload: { activeTabId, runId } });
  return Boolean(response && typeof response === "object" && (response as { ok?: unknown }).ok === true);
}

async function readSettings(): Promise<ExtensionSettings> {
  try {
    return await loadSettings();
  } catch {
    return FALLBACK_SETTINGS;
  }
}

async function writeSettings(settings: ExtensionSettings): Promise<void> {
  try {
    await saveSettings(settings);
  } catch {
    return;
  }
}

async function openTab(url: string): Promise<void> {
  try {
    await chromeApi()?.tabs?.create({ url, active: true });
  } catch {
    return;
  }
}

function subscribe(listener: (message: unknown) => void): () => void {
  const onMessage = chromeApi()?.runtime?.onMessage;
  if (!onMessage) {
    return () => undefined;
  }
  onMessage.addListener(listener);
  return () => onMessage.removeListener(listener);
}

function isMessageOf<T extends ExtensionMessage["type"]>(
  message: unknown,
  type: T
): message is Extract<ExtensionMessage, { type: T }> {
  if (!message || typeof message !== "object") {
    return false;
  }
  const { type: messageType, payload } = message as { type?: unknown; payload?: unknown };
  return messageType === type && Boolean(payload) && typeof payload === "object";
}

export function App(): ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { view, source, baseline, results, fxTable, settings, toast, activeTabId } = state;
  const rootRef = useRef<HTMLElement>(null);
  const shownView = useRef(view);

  const currency = resolveDisplayCurrency(settings.comparisonCurrency, source);
  const destination = source?.destinationCountryCode ? countryName(source.destinationCountryCode) : "your address";
  const sourceMarket = source?.marketplace ?? baseline?.marketplace;
  const targets = targetMarkets(settings, source);
  const rows = useMemo(() => rankedRows(baseline, results, currency, fxTable), [baseline, results, currency, fxTable]);
  const verdict = useMemo(
    () => computeVerdict(baseline, results, currency, fxTable),
    [baseline, results, currency, fxTable]
  );
  const issueResults = useMemo(() => issues(results), [results]);
  const sheetRow = view === "done" ? rows.find((row) => row.result.marketplace === state.sheet) : undefined;

  useEffect(() => {
    let active = true;
    void readSettings().then((loaded) => {
      if (active) {
        dispatch({ type: "settings-changed", settings: loaded });
      }
    });
    void queryActiveTab().then(async (tab) => {
      if (!active) {
        return;
      }
      const supported = isSupportedMarketplaceUrl(tab.url);
      dispatch({ type: "tab-resolved", activeTabId: tab.id, supported });
      if (tab.id === undefined || !supported) {
        return;
      }
      const payload = await requestSource(tab.id);
      if (active) {
        dispatch({ type: "source-loaded", payload });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () =>
      subscribe((message) => {
        if (isMessageOf(message, RUN_COMPARISON_PROGRESS)) {
          dispatch({ type: "progress", payload: message.payload });
        } else if (isMessageOf(message, RUN_COMPARISON_RESULT)) {
          dispatch({ type: "result", payload: message.payload });
        }
      }),
    []
  );

  useEffect(() => {
    if (shownView.current === view) {
      return;
    }
    shownView.current = view;
    rootRef.current?.querySelector<HTMLElement>(".dB-scroll")?.focus();
  }, [view]);

  useEffect(() => {
    if (!toast?.visible) {
      return undefined;
    }
    const timer = setTimeout(() => dispatch({ type: "toast-hidden", id: toast.id }), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = (text: string): void => dispatch({ type: "toast-shown", text });

  const run = (): void => {
    if (targets.length === 0) {
      showToast("Pick at least one marketplace to check.");
      return;
    }
    if (activeTabId === undefined) {
      return;
    }
    const runId = createRunId();
    dispatch({ type: "run-started", targets, runId });
    void requestRun(activeTabId, runId).then((delivered) => {
      if (!delivered) {
        dispatch({ type: "run-undelivered", runId, generatedAt: new Date().toISOString() });
      }
    });
  };

  const cancel = (): void => {
    if (activeTabId !== undefined) {
      void sendMessage({ type: CANCEL_COMPARISON, payload: { activeTabId } });
    }
    dispatch({ type: "run-cancelled" });
    showToast("Stopped. No background tabs left open.");
  };

  const open = (result: ComparisonResult): void => {
    if (!result.productUrl) {
      return;
    }
    void openTab(result.productUrl);
    showToast(`Opening ${marketDisplayDomain(result.marketplace)} — you complete the purchase on Amazon.`);
  };

  const changeSettings = (next: ExtensionSettings): void => {
    dispatch({ type: "settings-changed", settings: next });
    void writeSettings(next);
  };

  const closeSheet = useCallback(() => dispatch({ type: "sheet-closed" }), []);

  return (
    <section className="dB" aria-label="Across Amazon popup" ref={rootRef}>
      <TopBar inSettings={view === "settings"} onToggleSettings={() => dispatch({ type: "settings-toggled" })} />
      {view === "idle" ? (
        <IdleView
          source={source}
          baseline={baseline}
          status={state.sourceStatus}
          targetCount={targets.length}
          destination={destination}
          destinationKnown={Boolean(source?.destinationCountryCode)}
          onRun={run}
        />
      ) : null}
      {view === "running" ? (
        <RunningView
          progress={state.progress}
          runTargets={state.runTargets.length > 0 ? state.runTargets : targets}
          currency={currency}
          fxTable={fxTable}
          onCancel={cancel}
        />
      ) : null}
      {view === "done" ? (
        <DoneView
          verdict={verdict}
          baseline={baseline}
          error={state.error}
          rows={rows}
          issues={issueResults}
          currency={currency}
          fxTable={fxTable}
          destination={destination}
          destinationCountryCode={source?.destinationCountryCode}
          sourceDomain={sourceMarket ? marketDisplayDomain(sourceMarket) : "this page"}
          issuesOpen={state.issuesOpen}
          onToggleIssues={() => dispatch({ type: "issues-toggled" })}
          onSelectRow={(marketplace) => dispatch({ type: "sheet-opened", marketplace })}
          onOpen={open}
          onRun={run}
        />
      ) : null}
      {view === "settings" ? <SettingsView settings={settings} source={source} onChange={changeSettings} /> : null}
      <Footer fxTable={fxTable} />
      <DetailSheet
        row={sheetRow}
        source={source}
        fxTable={fxTable}
        destination={destination}
        onClose={closeSheet}
        onOpen={open}
      />
      <Toast toast={toast} />
    </section>
  );
}
