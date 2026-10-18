import {
  CANCEL_COMPARISON,
  RUN_COMPARISON_RESULT,
  isCancelComparisonRequest,
  isLoadSourceRequest,
  isRunComparisonRequest
} from "../shared/messages";
import type { RunComparisonResult } from "../shared/messages";
import { cancelComparison, loadSource, runComparison } from "./orchestrator";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isRunComparisonRequest(message)) {
    const { activeTabId, runId } = message.payload;
    void runComparison(activeTabId, runId)
      .then((payload) => {
        const resultMessage: RunComparisonResult = {
          type: RUN_COMPARISON_RESULT,
          payload
        };
        return chrome.runtime.sendMessage(resultMessage);
      })
      .catch((error) => {
        const fallbackMessage: RunComparisonResult = {
          type: RUN_COMPARISON_RESULT,
          payload: {
            results: [],
            generatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "Unknown error",
            activeTabId,
            runId
          }
        };
        return chrome.runtime.sendMessage(fallbackMessage);
      })
      .finally(() => {
        sendResponse({ ok: true });
      })
      .catch(() => undefined);

    return true;
  }

  if (isLoadSourceRequest(message)) {
    void loadSource(message.payload.activeTabId).then(sendResponse);
    return true;
  }

  if (isCancelComparisonRequest(message)) {
    void cancelComparison(message.payload.activeTabId).then(() => {
      sendResponse({ ok: true, type: CANCEL_COMPARISON });
    });
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported message" });
  return false;
});
