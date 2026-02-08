import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  CANCEL_COMPARISON,
  RUN_COMPARISON,
  RUN_COMPARISON_PROGRESS,
  RUN_COMPARISON_RESULT
} from "../shared/messages";
import { findCheapestAvailable } from "../shared/comparison";
import { MARKETPLACE_BY_CODE, marketLabel } from "../shared/markets";
import { formatMoney } from "../shared/money";
import type {
  ComparisonResult,
  RunComparisonProgressPayload,
  RunComparisonResultPayload,
  SourceContext
} from "../shared/types";

interface ComparisonState {
  source?: SourceContext;
  results: ComparisonResult[];
  running: boolean;
  generatedAt?: string;
  progress: RunComparisonProgressPayload;
  error?: string;
}

const initialProgress: RunComparisonProgressPayload = {
  completed: 0,
  total: 0
};

const initialState: ComparisonState = {
  results: [],
  running: false,
  progress: initialProgress
};

function statusLabel(status: ComparisonResult["status"]): string {
  switch (status) {
    case "OK":
      return "Available";
    case "UNAVAILABLE":
      return "Unavailable";
    case "DESTINATION_MISMATCH":
      return "Destination mismatch";
    case "PARSE_FAILED":
      return "Parse failed";
    case "NO_CONFIDENT_MATCH":
      return "No confident match";
    default:
      return status;
  }
}

export function App(): ReactElement {
  const [state, setState] = useState<ComparisonState>(initialState);
  const [activeTabId, setActiveTabId] = useState<number>();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      setActiveTabId(tabs[0]?.id);
    });
  }, []);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if ((message as { type?: string }).type === RUN_COMPARISON_PROGRESS) {
        setState((previous) => ({
          ...previous,
          running: true,
          progress: (message as { payload: RunComparisonProgressPayload }).payload
        }));
      }

      if ((message as { type?: string }).type === RUN_COMPARISON_RESULT) {
        const payload = (message as { payload: RunComparisonResultPayload }).payload;
        setState((previous) => ({
          ...previous,
          source: payload.source,
          results: payload.results,
          generatedAt: payload.generatedAt,
          error: payload.error,
          running: false,
          progress: {
            completed: previous.progress.total,
            total: previous.progress.total
          }
        }));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const visibleResults = useMemo(
    () => state.results.filter((result) => result.status !== "NO_CONFIDENT_MATCH"),
    [state.results]
  );

  const hiddenNoMatchCount = state.results.length - visibleResults.length;

  const cheapestMarket = useMemo(() => {
    const cheapest = findCheapestAvailable(visibleResults);
    return cheapest?.marketplace;
  }, [visibleResults]);

  const runComparison = async (): Promise<void> => {
    if (!activeTabId) {
      setState((previous) => ({
        ...previous,
        error: "Unable to resolve current tab"
      }));
      return;
    }

    setState({
      ...initialState,
      running: true,
      progress: {
        completed: 0,
        total: 0
      }
    });

    await chrome.runtime.sendMessage({
      type: RUN_COMPARISON,
      payload: {
        activeTabId
      }
    });
  };

  const cancel = async (): Promise<void> => {
    if (!activeTabId) {
      return;
    }

    await chrome.runtime.sendMessage({
      type: CANCEL_COMPARISON,
      payload: {
        activeTabId
      }
    });

    setState((previous) => ({
      ...previous,
      running: false
    }));
  };

  return (
    <main className="popup">
      <header className="popup-header">
        <h1>Across Amazon</h1>
        <p>Compare true delivered cost across marketplaces.</p>
      </header>

      <section className="controls">
        <button className="primary" onClick={() => void runComparison()} disabled={state.running || !activeTabId}>
          {state.running ? "Comparing..." : "Compare delivered prices"}
        </button>
        {state.running ? (
          <button className="secondary" onClick={() => void cancel()}>
            Cancel
          </button>
        ) : null}
      </section>

      <section className="status">
        {state.running ? (
          <p>
            Progress: {state.progress.completed}/{state.progress.total}
            {state.progress.currentMarketplace ? ` (${marketLabel(state.progress.currentMarketplace)})` : ""}
          </p>
        ) : null}
        {state.generatedAt ? <p>Updated: {new Date(state.generatedAt).toLocaleString()}</p> : null}
        {state.error ? <p className="error">{state.error}</p> : null}
      </section>

      {visibleResults.length > 0 ? (
        <section className="results">
          <table>
            <thead>
              <tr>
                <th>Marketplace</th>
                <th>Item</th>
                <th>Shipping</th>
                <th>Import</th>
                <th>Total</th>
                <th>Normalized</th>
                <th>Confidence</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleResults.map((result) => (
                <tr key={result.marketplace} className={result.status !== "OK" ? "muted" : ""}>
                  <td>
                    {marketLabel(result.marketplace)}
                    {result.status === "OK" && result.marketplace === cheapestMarket ? (
                      <span className="badge">Cheapest</span>
                    ) : null}
                  </td>
                  <td>{formatMoney(result.breakdown?.item, MARKETPLACE_BY_CODE[result.marketplace].locale)}</td>
                  <td>{formatMoney(result.breakdown?.shipping, MARKETPLACE_BY_CODE[result.marketplace].locale)}</td>
                  <td>{formatMoney(result.breakdown?.importFees, MARKETPLACE_BY_CODE[result.marketplace].locale)}</td>
                  <td>
                    {formatMoney(
                      result.breakdown?.totalDisplayed ??
                        (result.breakdown
                          ? {
                              amount:
                                result.breakdown.item.amount +
                                (result.breakdown.shipping?.amount ?? 0) +
                                (result.breakdown.importFees?.amount ?? 0),
                              currency: result.breakdown.item.currency
                            }
                          : undefined),
                      MARKETPLACE_BY_CODE[result.marketplace].locale
                    )}
                  </td>
                  <td>{formatMoney(result.normalizedTotal)}</td>
                  <td>{result.status === "OK" ? `${Math.round(result.confidence * 100)}%` : statusLabel(result.status)}</td>
                  <td>
                    {result.productUrl ? (
                      <button
                        className="link"
                        onClick={() => {
                          void chrome.tabs.create({ url: result.productUrl, active: true });
                        }}
                      >
                        Open
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenNoMatchCount > 0 ? (
            <p className="subtle">{hiddenNoMatchCount} marketplace(s) omitted due to low-confidence product matching.</p>
          ) : null}
        </section>
      ) : (
        <section className="results empty">
          <p>Run a comparison to see cross-market delivered totals.</p>
        </section>
      )}

      <footer className="disclaimer">
        Across Amazon is not affiliated with Amazon. Prices/fees are what Amazon displayed at check time.
      </footer>
    </main>
  );
}
