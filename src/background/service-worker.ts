import {
  CANCEL_COMPARISON,
  RUN_COMPARISON_RESULT,
  isCancelComparisonRequest,
  isRunComparisonRequest
} from "../shared/messages";
import type { RunComparisonResult } from "../shared/messages";
import { cancelComparison, runComparison } from "./orchestrator";

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isRunComparisonRequest(message)) {
    void runComparison(message.payload.activeTabId)
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
            error: error instanceof Error ? error.message : "Unknown error"
          }
        };
        return chrome.runtime.sendMessage(fallbackMessage);
      })
      .finally(() => {
        sendResponse({ ok: true });
      });

    return true;
  }

  if (isCancelComparisonRequest(message)) {
    cancelComparison(message.payload.activeTabId);
    sendResponse({ ok: true, type: CANCEL_COMPARISON });
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported message" });
  return false;
});
