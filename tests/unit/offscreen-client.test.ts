// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageJob, PageJobResult } from "../../src/shared/types";

type Client = typeof import("../../src/background/offscreen-client");
type Answerer = (message: { type: string }) => unknown;

interface StubOptions {
  open?: boolean;
  answer?: Answerer;
}

const SINGLE_DOCUMENT_ERROR = "Only a single offscreen document may be created.";
const NO_DOCUMENT_ERROR = "No current offscreen document.";
const NO_RECEIVER_ERROR = "Could not establish connection. Receiving end does not exist.";
const JOB: PageJob = {
  runKey: "run-key-1",
  url: "https://www.amazon.de/dp/B000000005",
  page: { kind: "product", request: { marketplace: "DE", readOtherOffers: true } }
};
const READ: PageJobResult = { outcome: "read", finalUrl: JOB.url, candidates: [] };

let client: Client;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function roundTrip<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function answerEveryMessage(message: Parameters<Answerer>[0]): unknown {
  return message.type === "OFFSCREEN_PAGE_JOB" ? READ : { ok: true };
}

function stubChrome({ open = false, answer = answerEveryMessage }: StubOptions = {}) {
  const state = { open };
  const createDocument = vi.fn(async (_parameters: chrome.offscreen.CreateParameters) => {
    if (state.open) {
      throw new Error(SINGLE_DOCUMENT_ERROR);
    }
    state.open = true;
  });
  const closeDocument = vi.fn(async () => {
    if (!state.open) {
      throw new Error(NO_DOCUMENT_ERROR);
    }
    state.open = false;
  });
  const sendMessage = vi.fn(async (message: unknown) => {
    if (!state.open) {
      throw new Error(NO_RECEIVER_ERROR);
    }
    return roundTrip(await answer(roundTrip(message) as Parameters<Answerer>[0]));
  });
  vi.stubGlobal("chrome", { offscreen: { createDocument, closeDocument }, runtime: { sendMessage } });
  return { state, createDocument, closeDocument, sendMessage };
}

function running(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(async () => {
  vi.resetModules();
  client = await import("../../src/background/offscreen-client");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("canUseOffscreen", () => {
  it("is true only when Chrome has the offscreen API", () => {
    stubChrome();
    expect(client.canUseOffscreen()).toBe(true);

    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });
    expect(client.canUseOffscreen()).toBe(false);
  });
});

describe("runPageJob", () => {
  it("creates one offscreen document for jobs sent at the same time and answers each", async () => {
    const { createDocument, sendMessage } = stubChrome();
    const second = { ...JOB, url: `${JOB.url}?th=1` };

    const answers = await Promise.all([client.runPageJob(JOB, running()), client.runPageJob(second, running())]);

    expect(answers).toEqual([READ, READ]);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: expect.any(String)
    });
    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { target: "offscreen", type: "OFFSCREEN_PAGE_JOB", payload: JOB },
      { target: "offscreen", type: "OFFSCREEN_PAGE_JOB", payload: second }
    ]);
  });

  it("sends the job to a document an earlier service worker left open", async () => {
    const { createDocument, sendMessage } = stubChrome({ open: true });

    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("answers no answer when the document cannot be created, and tries again on the next job", async () => {
    const { createDocument, sendMessage } = stubChrome();
    createDocument.mockRejectedValueOnce(new Error("Offscreen document closed before fully loading."));

    await expect(client.runPageJob(JOB, running())).resolves.toEqual({
      outcome: "fallback",
      reason: "no-answer",
      detail: "Offscreen document closed before fully loading."
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the document cannot be reached", () => Promise.reject(new Error(NO_RECEIVER_ERROR)), NO_RECEIVER_ERROR],
    ["nothing answers", () => undefined, "The offscreen document gave no answer"],
    ["the answer is not a page job result", () => ({ ok: true }), "The offscreen document gave an answer it should not"]
  ])("answers no answer when %s", async (_name, answer, detail) => {
    stubChrome({ answer });

    await expect(client.runPageJob(JOB, running())).resolves.toEqual({ outcome: "fallback", reason: "no-answer", detail });
  });

  it("answers no answer when the document has not answered after 27 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubChrome({ answer: () => new Promise(() => undefined) });
    let answer: PageJobResult | undefined;
    void client.runPageJob(JOB, running()).then((result) => {
      answer = result;
    });

    await vi.advanceTimersByTimeAsync(26_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(answer).toEqual({ outcome: "fallback", reason: "no-answer", detail: "no answer after 27 seconds" });
  });

  describe("when the document takes 4 seconds to open", () => {
    function openSlowly(answer: Answerer) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stub = stubChrome({ answer });
      stub.createDocument.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        stub.state.open = true;
      });
      const answers: PageJobResult[] = [];
      void client.runPageJob(JOB, running()).then((result) => answers.push(result));
      return { ...stub, answers };
    }

    it("counts the 27 seconds from when the job is sent", async () => {
      const { answers, sendMessage } = openSlowly(() => new Promise(() => undefined));

      await vi.advanceTimersByTimeAsync(4_000);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(26_999);
      expect(answers).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(answers).toEqual([{ outcome: "fallback", reason: "no-answer", detail: "no answer after 27 seconds" }]);
    });

    it("keeps the answer of a job that runs 26 seconds", async () => {
      const { answers } = openSlowly(() => new Promise((resolve) => setTimeout(() => resolve(READ), 26_000)));

      await vi.advanceTimersByTimeAsync(30_000);

      expect(answers).toEqual([READ]);
    });
  });

  it("answers no answer when the document is not open after 10 seconds, and never sends the job", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { createDocument, sendMessage, state } = stubChrome();
    const creation = deferred();
    createDocument.mockImplementationOnce(async () => {
      await creation.promise;
      state.open = true;
    });
    let answer: PageJobResult | undefined;
    void client.runPageJob(JOB, running()).then((result) => {
      answer = result;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ outcome: "fallback", reason: "no-answer", detail: "no document after 10 seconds" });
    creation.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(state.open).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["the document cannot be reached", () => Promise.reject(new Error(NO_RECEIVER_ERROR))],
    ["nothing answers", () => undefined]
  ])("creates the document again for the next job after %s", async (_name, firstAnswer) => {
    const answers: Answerer[] = [firstAnswer, () => READ];
    const { createDocument, sendMessage } = stubChrome({ answer: (message) => answers.shift()?.(message) });

    await client.runPageJob(JOB, running());
    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);

    expect(createDocument).toHaveBeenCalledTimes(2);
    await expect(createDocument.mock.results[1].value).rejects.toThrow(SINGLE_DOCUMENT_ERROR);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps the document after an answer that is not a page job result", async () => {
    const answers: Answerer[] = [() => ({ ok: true }), () => READ];
    const { createDocument } = stubChrome({ answer: (message) => answers.shift()?.(message) });

    await client.runPageJob(JOB, running());
    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);

    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("answers cancelled for a stopped run without creating a document", async () => {
    const { createDocument, sendMessage } = stubChrome();
    const controller = new AbortController();
    controller.abort();

    await expect(client.runPageJob(JOB, controller.signal)).resolves.toEqual({ outcome: "cancelled" });

    expect(createDocument).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("answers cancelled as soon as the run stops while the document works on the job", async () => {
    const { sendMessage } = stubChrome({ answer: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const answer = client.runPageJob(JOB, controller.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(answer).resolves.toEqual({ outcome: "cancelled" });
  });

  it("answers cancelled when the run stops while the document is being created, and never sends the job", async () => {
    const { createDocument, sendMessage, state } = stubChrome();
    const creation = deferred();
    createDocument.mockImplementationOnce(async () => {
      await creation.promise;
      state.open = true;
    });
    const controller = new AbortController();
    const answer = client.runPageJob(JOB, controller.signal);
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(answer).resolves.toEqual({ outcome: "cancelled" });
    creation.resolve();
    await flush();

    expect(state.open).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("cancelOffscreenRun", () => {
  it("waits for a document being created, then tells it to stop the run", async () => {
    const { createDocument, sendMessage, state } = stubChrome({
      answer: (message) => (message.type === "OFFSCREEN_PAGE_JOB" ? new Promise(() => undefined) : { ok: true })
    });
    const creation = deferred();
    createDocument.mockImplementationOnce(async () => {
      await creation.promise;
      state.open = true;
    });
    void client.runPageJob(JOB, running());
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));

    const cancelled = client.cancelOffscreenRun(JOB.runKey);
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();
    creation.resolve();
    await cancelled;

    expect(sendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: "OFFSCREEN_CANCEL_RUN",
      payload: { runKey: JOB.runKey }
    });
  });

  it("tells the document to stop the run after 10 seconds when its creation never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { createDocument, sendMessage } = stubChrome();
    createDocument.mockImplementationOnce(() => new Promise(() => undefined));
    void client.runPageJob(JOB, running());
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
    let cancelled = false;
    void client.cancelOffscreenRun(JOB.runKey).then(() => {
      cancelled = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(cancelled).toBe(true);
    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { target: "offscreen", type: "OFFSCREEN_CANCEL_RUN", payload: { runKey: JOB.runKey } }
    ]);
  });

  it("swallows a cancel that reaches no document", async () => {
    const { sendMessage } = stubChrome();

    await expect(client.cancelOffscreenRun(JOB.runKey)).resolves.toBeUndefined();
    await expect(sendMessage.mock.results[0].value).rejects.toThrow(NO_RECEIVER_ERROR);
  });
});

describe("closeOffscreenDocument", () => {
  it("closes the document once for close calls made at the same time", async () => {
    const { closeDocument, state } = stubChrome();
    await client.runPageJob(JOB, running());

    await Promise.all([client.closeOffscreenDocument(), client.closeOffscreenDocument()]);

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(state.open).toBe(false);
  });

  it("creates a new document for a job sent after the close", async () => {
    const { createDocument } = stubChrome();
    await client.runPageJob(JOB, running());
    await client.closeOffscreenDocument();

    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);

    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it("closes a document this service worker did not create", async () => {
    const { createDocument, closeDocument, state } = stubChrome({ open: true });

    await client.closeOffscreenDocument();

    expect(createDocument).not.toHaveBeenCalled();
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(state.open).toBe(false);
  });

  it("swallows a close when no document is open", async () => {
    const { closeDocument } = stubChrome();

    await expect(client.closeOffscreenDocument()).resolves.toBeUndefined();
    await expect(closeDocument.mock.results[0].value).rejects.toThrow(NO_DOCUMENT_ERROR);
  });

  it("does nothing when Chrome has no offscreen API", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    await expect(client.closeOffscreenDocument()).resolves.toBeUndefined();
  });

  it("waits for a document being created before closing it", async () => {
    const { createDocument, closeDocument, state } = stubChrome({ answer: () => new Promise(() => undefined) });
    const creation = deferred();
    createDocument.mockImplementationOnce(async () => {
      await creation.promise;
      state.open = true;
    });
    void client.runPageJob(JOB, running());
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));

    const closed = client.closeOffscreenDocument();
    await flush();
    expect(closeDocument).not.toHaveBeenCalled();
    creation.resolve();
    await closed;

    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(state.open).toBe(false);
  });

  it("closes the document 10 seconds after the close when its creation never settles, and creates it again for the next job", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { createDocument, closeDocument } = stubChrome();
    createDocument.mockImplementationOnce(() => new Promise(() => undefined));
    void client.runPageJob(JOB, running());
    await vi.waitFor(() => expect(createDocument).toHaveBeenCalledTimes(1));
    let closed = false;
    void client.closeOffscreenDocument().then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);

    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it("gives up on a close that has not settled after 10 seconds, so the next job is sent to the document", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { createDocument, closeDocument, sendMessage } = stubChrome({ open: true });
    closeDocument.mockImplementationOnce(() => new Promise(() => undefined));
    let closed = false;
    void client.closeOffscreenDocument().then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);

    await expect(client.runPageJob(JOB, running())).resolves.toEqual(READ);
    expect(createDocument).toHaveBeenCalledTimes(1);
    await expect(createDocument.mock.results[0].value).rejects.toThrow(SINGLE_DOCUMENT_ERROR);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("makes a job started while the document closes wait for the close and create a new document", async () => {
    const { createDocument, closeDocument, state } = stubChrome({ open: true });
    const closure = deferred();
    closeDocument.mockImplementationOnce(async () => {
      await closure.promise;
      state.open = false;
    });

    const closed = client.closeOffscreenDocument();
    const answer = client.runPageJob(JOB, running());
    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledTimes(1));
    expect(createDocument).not.toHaveBeenCalled();
    closure.resolve();
    await closed;

    await expect(answer).resolves.toEqual(READ);
    expect(createDocument).toHaveBeenCalledTimes(1);
    await expect(createDocument.mock.results[0].value).resolves.toBeUndefined();
  });
});
