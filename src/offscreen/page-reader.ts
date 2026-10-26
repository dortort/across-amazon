import { readDestinationIso, setDeliveryLocation } from "../content/location-setter";
import { extractProductDataWithOffers } from "../content/product-extractor";
import { extractSearchCandidates } from "../content/search-extractor";
import { getMarketplaceByDomain } from "../shared/markets";
import { isOffscreenCancelRunRequest, isOffscreenPageJobRequest } from "../shared/messages";
import { isRobotCheck } from "../shared/robot-check";
import type { LocationResult, PageJob, PageJobFallback, PageJobRead, PageJobResult, PageKind } from "../shared/types";

interface FetchedText {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<FetchedText>;

interface Deadline {
  signal: AbortSignal;
  expired: () => boolean;
  release: () => void;
}

interface StoreAnswer {
  url: string;
  status: number;
  ok: boolean;
  body: string;
}

interface StoreFetchHooks {
  onRequest?: () => void;
  onAnswer?: (answer: StoreAnswer) => void;
}

interface Download {
  response: Response;
  bytes: ArrayBuffer;
}

const PAGE_FETCH_TIMEOUT_MS = 15_000;
const LOCATION_STEP_TIMEOUT_MS = 10_000;
const PAGE_JOB_TIMEOUT_MS = 25_000;
const CHARSET_PRESCAN_BYTES = 1_024;
const PRODUCT_SHAPE = "#productTitle, #ASIN, input[name='ASIN'], link[rel='canonical']";
const SEARCH_SHAPE = "[data-component-type='s-search-result'], .s-main-slot, [data-component-type='s-result-info-bar']";
const CHARSET = /charset\s*=\s*["']?([^"';\s>/]+)/i;
const META_TAG = /<meta\b[^>]*>/gi;
const DEFAULT_CHARSET = "utf-8";

const RUNS = new Map<string, AbortController>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown page error";
}

function deadline(parents: Array<AbortSignal | null | undefined>, timeoutMs?: number): Deadline {
  const controller = new AbortController();
  const linked = parents.filter((parent): parent is AbortSignal => Boolean(parent));
  const abort = (): void => controller.abort();
  let timedOut = false;

  for (const parent of linked) {
    if (parent.aborted) {
      abort();
    } else {
      parent.addEventListener("abort", abort, { once: true });
    }
  }
  const timeoutId =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          abort();
        }, timeoutMs);

  return {
    signal: controller.signal,
    expired: () => timedOut,
    release: () => {
      clearTimeout(timeoutId);
      for (const parent of linked) {
        parent.removeEventListener("abort", abort);
      }
    }
  };
}

function checkpoint(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("The page job was stopped");
  }
}

function isStoreUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && getMarketplaceByDomain(parsed.hostname) !== undefined;
  } catch {
    return false;
  }
}

function charsetOf(bytes: ArrayBuffer, contentType: string | null): string {
  const declared = CHARSET.exec(contentType ?? "")?.[1];
  if (declared) {
    return declared;
  }
  const head = new TextDecoder("windows-1252").decode(bytes.slice(0, CHARSET_PRESCAN_BYTES));
  for (const tag of head.match(META_TAG) ?? []) {
    const label = CHARSET.exec(tag)?.[1];
    if (label) {
      return label;
    }
  }
  return DEFAULT_CHARSET;
}

function decode(bytes: ArrayBuffer, label: string): string | undefined {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return undefined;
  }
}

function parsePage(html: string, finalUrl: string): Document {
  const documentRef = new DOMParser().parseFromString(html, "text/html");
  const base = documentRef.createElement("base");
  base.setAttribute("href", finalUrl);
  documentRef.head.prepend(base);
  return documentRef;
}

function hasShape(documentRef: Document, kind: PageKind): boolean {
  return documentRef.querySelector(kind === "product" ? PRODUCT_SHAPE : SEARCH_SHAPE) !== null;
}

function storeFetch(signal: AbortSignal, hooks: StoreFetchHooks = {}): FetchLike {
  return async (url, init = {}) => {
    hooks.onRequest?.();
    const linked = deadline([signal, init.signal]);
    try {
      const response = await fetch(url, { ...init, credentials: "include", signal: linked.signal });
      const body = await response.text();
      hooks.onAnswer?.({ url: response.url, status: response.status, ok: response.ok, body });
      return { ok: response.ok, status: response.status, text: async () => body };
    } finally {
      linked.release();
    }
  };
}

function refusalOf(answer: StoreAnswer): string | undefined {
  if (isRobotCheck(answer.url, answer.body, answer.status)) {
    return "Amazon showed a robot check";
  }
  return answer.ok ? undefined : `Amazon answered HTTP ${answer.status}`;
}

async function download(url: string, signal: AbortSignal): Promise<Download | PageJobFallback> {
  const step = deadline([signal], PAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: "include", signal: step.signal });
    return { response, bytes: await response.arrayBuffer() };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return step.expired()
      ? { outcome: "fallback", reason: "timeout" }
      : { outcome: "fallback", reason: "network", detail: errorMessage(error) };
  } finally {
    step.release();
  }
}

async function readPageJob(job: PageJob, runSignal: AbortSignal): Promise<PageJobResult> {
  const whole = deadline([runSignal], PAGE_JOB_TIMEOUT_MS);
  let location: LocationResult | undefined;
  let requested = false;
  const withLocation = <T extends PageJobRead | PageJobFallback>(result: T): T =>
    location ? { ...result, location, locationRequested: requested } : result;

  try {
    if (runSignal.aborted) {
      return { outcome: "cancelled" };
    }
    if (!isStoreUrl(job.url)) {
      return { outcome: "fallback", reason: "off-host", detail: job.url };
    }

    const page = await download(job.url, whole.signal);
    if ("outcome" in page) {
      return page;
    }
    const { response, bytes } = page;
    const finalUrl = response.url || job.url;
    if (new URL(finalUrl).host !== new URL(job.url).host) {
      return { outcome: "fallback", reason: "off-host", detail: finalUrl };
    }

    const charset = charsetOf(bytes, response.headers.get("content-type"));
    const html = decode(bytes, charset);
    if (html === undefined) {
      return { outcome: "fallback", reason: "charset", detail: charset };
    }
    if (isRobotCheck(finalUrl, html, response.status)) {
      return { outcome: "robot-check", finalUrl, status: response.status };
    }
    if (job.page.kind === "product" && response.status === 404) {
      return { outcome: "not-found", finalUrl, status: response.status };
    }
    if (!response.ok) {
      return { outcome: "fallback", reason: "http-status", detail: `HTTP ${response.status}` };
    }

    const documentRef = parsePage(html, finalUrl);
    if (!hasShape(documentRef, job.page.kind)) {
      return { outcome: "fallback", reason: "shape" };
    }
    const shown = job.expectDestination ? readDestinationIso(documentRef) : undefined;
    if (shown && shown !== job.expectDestination) {
      return { outcome: "fallback", reason: "destination", detail: shown };
    }

    const origin = new URL(finalUrl).origin;
    if (job.location) {
      const step = deadline([whole.signal], LOCATION_STEP_TIMEOUT_MS);
      try {
        location = await setDeliveryLocation(
          documentRef,
          job.location,
          origin,
          storeFetch(step.signal, {
            onRequest: () => {
              requested = true;
            }
          })
        );
      } finally {
        step.release();
      }
      checkpoint(whole.signal);
      if (step.expired()) {
        location = { status: "FAILED", reason: `timed out after ${LOCATION_STEP_TIMEOUT_MS / 1000} seconds` };
      }
      if (location.status === "SET") {
        return { outcome: "location-set", finalUrl, location };
      }
    }

    if (job.page.kind === "search") {
      const candidates = extractSearchCandidates(documentRef, job.page.request, origin);
      return withLocation({ outcome: "read", finalUrl, candidates });
    }

    let answers = 0;
    let refusal: string | undefined;
    const product = await extractProductDataWithOffers(
      documentRef,
      job.page.request,
      finalUrl,
      storeFetch(whole.signal, {
        onAnswer: (answer) => {
          answers += 1;
          if (answers === 1) {
            refusal = refusalOf(answer);
          }
        }
      })
    );
    checkpoint(whole.signal);
    return refusal
      ? withLocation({ outcome: "fallback", reason: "offers", detail: refusal })
      : withLocation({ outcome: "read", finalUrl, product });
  } catch (error) {
    if (runSignal.aborted) {
      return { outcome: "cancelled" };
    }
    return whole.expired()
      ? withLocation({ outcome: "fallback", reason: "timeout" })
      : withLocation({ outcome: "fallback", reason: "error", detail: errorMessage(error) });
  } finally {
    whole.release();
  }
}

function controllerFor(runKey: string): AbortController {
  const existing = RUNS.get(runKey);
  if (existing) {
    return existing;
  }
  const controller = new AbortController();
  RUNS.set(runKey, controller);
  return controller;
}

function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

export function handleOffscreenMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): boolean {
  if (!isTrustedSender(sender)) {
    return false;
  }

  if (isOffscreenCancelRunRequest(message)) {
    controllerFor(message.payload.runKey).abort();
    sendResponse({ ok: true });
    return false;
  }

  if (isOffscreenPageJobRequest(message)) {
    void readPageJob(message.payload, controllerFor(message.payload.runKey).signal).then(sendResponse);
    return true;
  }

  return false;
}
