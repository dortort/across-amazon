import type {
  ExtensionSettings,
  LoadSourcePayload,
  PageJob,
  PageJobResult,
  RunComparisonProgressPayload,
  RunComparisonResultPayload
} from "./types";

export const RUN_COMPARISON = "RUN_COMPARISON" as const;
export const RUN_COMPARISON_PROGRESS = "RUN_COMPARISON_PROGRESS" as const;
export const RUN_COMPARISON_RESULT = "RUN_COMPARISON_RESULT" as const;
export const CANCEL_COMPARISON = "CANCEL_COMPARISON" as const;
export const LOAD_SOURCE = "LOAD_SOURCE" as const;
export const LOAD_SETTINGS = "LOAD_SETTINGS" as const;
export const SAVE_SETTINGS = "SAVE_SETTINGS" as const;
export const OFFSCREEN_TARGET = "offscreen" as const;
export const OFFSCREEN_PAGE_JOB = "OFFSCREEN_PAGE_JOB" as const;
export const OFFSCREEN_CANCEL_RUN = "OFFSCREEN_CANCEL_RUN" as const;

export interface RunComparisonRequest {
  type: typeof RUN_COMPARISON;
  payload: {
    activeTabId: number;
    runId?: string;
  };
}

export interface RunComparisonProgress {
  type: typeof RUN_COMPARISON_PROGRESS;
  payload: RunComparisonProgressPayload;
}

export interface RunComparisonResult {
  type: typeof RUN_COMPARISON_RESULT;
  payload: RunComparisonResultPayload;
}

export interface CancelComparisonRequest {
  type: typeof CANCEL_COMPARISON;
  payload: {
    activeTabId: number;
  };
}

export interface LoadSourceRequest {
  type: typeof LOAD_SOURCE;
  payload: {
    activeTabId: number;
  };
}

export type LoadSourceResponse = LoadSourcePayload;

export interface LoadSettingsRequest {
  type: typeof LOAD_SETTINGS;
}

export interface SaveSettingsRequest {
  type: typeof SAVE_SETTINGS;
  payload: ExtensionSettings;
}

export interface OffscreenPageJobRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_PAGE_JOB;
  payload: PageJob;
}

export interface OffscreenCancelRunRequest {
  target: typeof OFFSCREEN_TARGET;
  type: typeof OFFSCREEN_CANCEL_RUN;
  payload: {
    runKey: string;
  };
}

export type ExtensionMessage =
  | RunComparisonRequest
  | RunComparisonProgress
  | RunComparisonResult
  | CancelComparisonRequest
  | LoadSourceRequest
  | LoadSettingsRequest
  | SaveSettingsRequest;

export function isRunComparisonRequest(value: unknown): value is RunComparisonRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: string }).type === RUN_COMPARISON &&
      typeof (value as { payload?: { activeTabId?: unknown } }).payload?.activeTabId === "number"
  );
}

export function isCancelComparisonRequest(value: unknown): value is CancelComparisonRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: string }).type === CANCEL_COMPARISON &&
      typeof (value as { payload?: { activeTabId?: unknown } }).payload?.activeTabId === "number"
  );
}

export function isLoadSourceRequest(value: unknown): value is LoadSourceRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: string }).type === LOAD_SOURCE &&
      typeof (value as { payload?: { activeTabId?: unknown } }).payload?.activeTabId === "number"
  );
}

export function isLoadSettingsRequest(value: unknown): value is LoadSettingsRequest {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === LOAD_SETTINGS);
}

export function isSaveSettingsRequest(value: unknown): value is SaveSettingsRequest {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === SAVE_SETTINGS);
}

interface PageJobFields {
  runKey?: unknown;
  url?: unknown;
  page?: { kind?: unknown };
}

export function isOffscreenPageJobRequest(value: unknown): value is OffscreenPageJobRequest {
  const payload = (value as { payload?: PageJobFields } | null)?.payload;
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { target?: string }).target === OFFSCREEN_TARGET &&
      (value as { type?: string }).type === OFFSCREEN_PAGE_JOB &&
      typeof payload?.runKey === "string" &&
      typeof payload.url === "string" &&
      (payload.page?.kind === "product" || payload.page?.kind === "search")
  );
}

export function isOffscreenCancelRunRequest(value: unknown): value is OffscreenCancelRunRequest {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { target?: string }).target === OFFSCREEN_TARGET &&
      (value as { type?: string }).type === OFFSCREEN_CANCEL_RUN &&
      typeof (value as { payload?: { runKey?: unknown } }).payload?.runKey === "string"
  );
}

const PAGE_JOB_OUTCOMES: ReadonlySet<string> = new Set<PageJobResult["outcome"]>([
  "read",
  "fallback",
  "location-set",
  "not-found",
  "robot-check",
  "cancelled"
]);

export function isPageJobResult(value: unknown): value is PageJobResult {
  return Boolean(
    value && typeof value === "object" && PAGE_JOB_OUTCOMES.has(String((value as { outcome?: unknown }).outcome))
  );
}
