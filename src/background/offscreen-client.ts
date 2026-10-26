import { OFFSCREEN_CANCEL_RUN, OFFSCREEN_PAGE_JOB, OFFSCREEN_TARGET, isPageJobResult } from "../shared/messages";
import type { OffscreenCancelRunRequest, OffscreenPageJobRequest } from "../shared/messages";
import type { PageJob, PageJobFallback, PageJobResult } from "../shared/types";

export const PAGE_JOB_ANSWER_TIMEOUT_MS = 27_000;
export const OFFSCREEN_CREATE_TIMEOUT_MS = 10_000;

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_JUSTIFICATION = "Reads the Amazon pages a price check downloads, without opening a tab for each.";
const SINGLE_DOCUMENT_ERROR = "Only a single offscreen document may be created.";

let opening: Promise<void> | undefined;
let closing: Promise<void> | undefined;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function noAnswer(detail: string): PageJobFallback {
  return { outcome: "fallback", reason: "no-answer", detail };
}

function waitAtMost(promise: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(resolve, timeoutMs);
    const done = (): void => {
      clearTimeout(timeoutId);
      resolve();
    };
    void Promise.resolve(promise).then(done, done);
  });
}

export function canUseOffscreen(): boolean {
  return typeof chrome.offscreen?.createDocument === "function";
}

function createDocument(): Promise<void> {
  const created: Promise<void> = chrome.offscreen
    .createDocument({ url: OFFSCREEN_URL, reasons: ["DOM_PARSER"], justification: OFFSCREEN_JUSTIFICATION })
    .catch((error: unknown) => {
      if (errorMessage(error, "").startsWith(SINGLE_DOCUMENT_ERROR)) {
        return;
      }
      if (opening === created) {
        opening = undefined;
      }
      throw error;
    });
  return created;
}

async function ensureDocument(): Promise<() => void> {
  await closing;
  opening ??= createDocument();
  const used = opening;
  await used;
  return () => {
    if (opening === used) {
      opening = undefined;
    }
  };
}

async function deliver(job: PageJob, stopped: () => boolean, onSend: () => void): Promise<PageJobResult> {
  let forget: () => void;
  try {
    forget = await ensureDocument();
  } catch (error) {
    return noAnswer(errorMessage(error, "The offscreen document could not be created"));
  }
  if (stopped()) {
    return { outcome: "cancelled" };
  }

  const message: OffscreenPageJobRequest = { target: OFFSCREEN_TARGET, type: OFFSCREEN_PAGE_JOB, payload: job };
  onSend();
  let answer: unknown;
  try {
    answer = await chrome.runtime.sendMessage(message);
  } catch (error) {
    forget();
    return noAnswer(errorMessage(error, "The offscreen document could not be reached"));
  }
  if (answer === undefined) {
    forget();
    return noAnswer("The offscreen document gave no answer");
  }
  return isPageJobResult(answer) ? answer : noAnswer("The offscreen document gave an answer it should not");
}

export function runPageJob(job: PageJob, signal: AbortSignal): Promise<PageJobResult> {
  if (signal.aborted) {
    return Promise.resolve({ outcome: "cancelled" });
  }

  return new Promise<PageJobResult>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: PageJobResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => settle({ outcome: "cancelled" });
    const giveUpAfter = (timeoutMs: number, detail: string): void => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => settle(noAnswer(detail)), timeoutMs);
    };
    giveUpAfter(OFFSCREEN_CREATE_TIMEOUT_MS, `no document after ${OFFSCREEN_CREATE_TIMEOUT_MS / 1000} seconds`);
    signal.addEventListener("abort", onAbort, { once: true });

    const onSend = (): void =>
      giveUpAfter(PAGE_JOB_ANSWER_TIMEOUT_MS, `no answer after ${PAGE_JOB_ANSWER_TIMEOUT_MS / 1000} seconds`);
    void deliver(job, () => settled || signal.aborted, onSend).then(settle);
  });
}

export async function cancelOffscreenRun(runKey: string): Promise<void> {
  await waitAtMost(opening, OFFSCREEN_CREATE_TIMEOUT_MS);
  const message: OffscreenCancelRunRequest = { target: OFFSCREEN_TARGET, type: OFFSCREEN_CANCEL_RUN, payload: { runKey } };
  await chrome.runtime.sendMessage(message).catch(() => undefined);
}

export function closeOffscreenDocument(): Promise<void> {
  if (!canUseOffscreen()) {
    return Promise.resolve();
  }

  const pending = opening;
  opening = undefined;
  closing ??= waitAtMost(pending, OFFSCREEN_CREATE_TIMEOUT_MS)
    .then(() => waitAtMost(chrome.offscreen.closeDocument(), OFFSCREEN_CREATE_TIMEOUT_MS))
    .catch(() => undefined)
    .finally(() => {
      closing = undefined;
    });
  return closing;
}
