import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { ReactElement } from "react";
import {
  CANCEL_COMPARISON,
  LOAD_SOURCE,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../shared/messages";
import type { ExtensionMessage } from "../shared/messages";
import { MARKETPLACE_CODES, countryName, marketDisplayDomain } from "../shared/markets";
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

const FALLBACK_SETTINGS: ExtensionSettings = {
  enabledMarketplaces: [...MARKETPLACE_CODES],
  comparisonCurrency: "SOURCE",
  disclosureAcknowledged: false
};

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
  cancelled: boolean;
  error?: string;
  generatedAt?: string;
  sheet?: Marketplace;
  issuesOpen: boolean;
  toast?: ToastState;
  settings: ExtensionSettings;
}

type PopupAction =
  | { type: "tab-resolved"; activeTabId?: number }
  | { type: "settings-changed"; settings: ExtensionSettings }
  | { type: "source-loaded"; payload: LoadSourcePayload }
  | { type: "run-started"; targets: Marketplace[] }
  | { type: "run-cancelled" }
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
  cancelled: false,
  issuesOpen: false,
  settings: FALLBACK_SETTINGS
};

function reducer(state: PopupState, action: PopupAction): PopupState {
  switch (action.type) {
    case "tab-resolved":
      return {
        ...state,
        activeTabId: action.activeTabId,
        sourceStatus: action.activeTabId === undefined ? "failed" : state.sourceStatus
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
        progress: undefined,
        results: [],
        error: undefined,
        cancelled: false,
        sheet: undefined,
        issuesOpen: false
      };
    case "run-cancelled":
      return { ...state, view: "idle", progress: undefined, results: [], error: undefined, cancelled: true };
    case "progress":
      if (state.cancelled) {
        return state;
      }
      return state.view === "settings"
        ? { ...state, progress: action.payload, returnView: "running" }
        : { ...state, progress: action.payload, view: "running", sheet: undefined };
    case "result": {
      if (state.cancelled) {
        return state;
      }
      const { payload } = action;
      const next: PopupState = {
        ...state,
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

async function queryActiveTabId(): Promise<number | undefined> {
  try {
    const tabs = await chromeApi()?.tabs?.query({ active: true, currentWindow: true });
    return tabs?.[0]?.id;
  } catch {
    return undefined;
  }
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

  const currency = resolveDisplayCurrency(settings.comparisonCurrency, source);
  const destination = source ? countryName(source.destinationCountryCode) : "your address";
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
    void queryActiveTabId().then(async (tabId) => {
      if (!active) {
        return;
      }
      dispatch({ type: "tab-resolved", activeTabId: tabId });
      if (tabId === undefined) {
        return;
      }
      const payload = await requestSource(tabId);
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
    dispatch({ type: "run-started", targets });
    void sendMessage({ type: RUN_COMPARISON, payload: { activeTabId } });
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
    <section className="dB" aria-label="Across Amazon popup">
      <TopBar inSettings={view === "settings"} onToggleSettings={() => dispatch({ type: "settings-toggled" })} />
      {view === "idle" ? (
        <IdleView
          source={source}
          baseline={baseline}
          status={state.sourceStatus}
          targetCount={targets.length}
          destination={destination}
          onRun={run}
        />
      ) : null}
      {view === "running" ? (
        <RunningView
          progress={state.progress}
          runTargets={state.runTargets}
          currency={currency}
          fxTable={fxTable}
          onCancel={cancel}
        />
      ) : null}
      {view === "done" ? (
        <DoneView
          verdict={verdict}
          error={state.error}
          rows={rows}
          issues={issueResults}
          currency={currency}
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
        sourceTitle={source?.title}
        destination={destination}
        onClose={closeSheet}
        onOpen={open}
      />
      <Toast toast={toast} />
    </section>
  );
}
