import { handleOffscreenMessage } from "./page-reader";

chrome.runtime.onMessage.addListener(handleOffscreenMessage);
