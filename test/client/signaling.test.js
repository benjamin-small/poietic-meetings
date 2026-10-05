import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./fakes.js";
import { openSignaling } from "../../public/signaling.js";

let windowListeners;
let documentListeners;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // no backoff jitter
  FakeWebSocket.all = [];
  windowListeners = {};
  documentListeners = {};
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "https:", host: "meetings.test" });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (type, fn) => (documentListeners[type] = fn),
  });
  vi.stubGlobal("addEventListener", (type, fn) => (windowListeners[type] = fn));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(handlers = {}) {
  const calls = { opens: 0, drops: [], gaveUp: null, messages: [] };
  const signaling = openSignaling("room-1", {
    onOpen: () => calls.opens++,
    onMessage: (msg) => calls.messages.push(msg),
    onDrop: (info) => calls.drops.push(info),
    onGiveUp: (info) => (calls.gaveUp = info),
    ...handlers,
  });
  return { signaling, calls };
}

const latest = () => FakeWebSocket.all.at(-1);

describe("signaling", () => {
  it("connects to the room's WebSocket on this host", () => {
    open();
    expect(latest().url).toBe("wss://meetings.test/ws?room=room-1");
  });

  it("reconnects after a drop and reports the outage once it's back", async () => {
    const { signaling, calls } = open();
    latest().open();
    latest().drop(1006);
    expect(calls.drops).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.all).toHaveLength(2);
    latest().open();
    expect(calls.opens).toBe(2);
    expect(signaling.recovered()).toMatchObject({ attempts: 1 });
  });

  it("abandons a connect stuck in CONNECTING and tries again", async () => {
    open();
    const stuck = latest(); // never opens
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stuck.closedWith).not.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.all).toHaveLength(2);
  });

  it("replaces a stalled connect as soon as the network comes back", async () => {
    open();
    latest().open();
    latest().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    const stalled = latest(); // CONNECTING, going nowhere
    windowListeners.online();
    expect(stalled.closedWith).not.toBeNull();
    expect(FakeWebSocket.all).toHaveLength(3);
  });

  it("gives up after a number of attempts, not after wall-clock time", async () => {
    const { calls } = open();
    latest().open();
    latest().drop(1006);
    // The page is suspended for ten minutes (phone locked): no timers run.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(500);
    latest().drop(1006); // first attempt after waking fails
    expect(calls.gaveUp).toBeNull();
    for (let i = 0; i < 40 && !calls.gaveUp; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
      if (latest().readyState === FakeWebSocket.CONNECTING) latest().drop(1006);
    }
    expect(calls.gaveUp).toMatchObject({ attempts: 12 });
  });

  it("treats 'full' as final only before ever joining", async () => {
    const { calls } = open();
    latest().open();
    latest().receive({ type: "full" });
    latest().drop(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(calls.messages.map((m) => m.type)).toEqual(["full"]);
  });

  it("keeps retrying when 'full' arrives while reconnecting", async () => {
    open();
    latest().open();
    latest().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    latest().open();
    latest().receive({ type: "full" });
    latest().drop(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.all).toHaveLength(3);
  });

  it("leaving while connected says goodbye with the resume credentials", async () => {
    const { signaling } = open();
    latest().open();
    const resume = { id: "p1", token: "t1" };
    await signaling.close(resume);
    expect(FakeWebSocket.all[0].sentJson()).toEqual([{ type: "leave", resume }]);
    expect(FakeWebSocket.all[0].closedWith).toMatchObject({ code: 1000 });
  });

  it("leaving while disconnected says goodbye on a fresh socket", async () => {
    const { signaling } = open();
    latest().open();
    latest().drop(1006);
    await vi.advanceTimersByTimeAsync(500);
    const reconnecting = latest(); // CONNECTING
    const resume = { id: "p1", token: "t1" };
    const done = signaling.close(resume);
    expect(reconnecting.closedWith).not.toBeNull();
    const bye = latest();
    expect(bye).not.toBe(reconnecting);
    bye.open();
    expect(bye.sentJson()).toEqual([{ type: "leave", resume }]);
    bye.drop(1000); // the room closes it after the goodbye
    await done;
  });
});
