// Runs a page script (app.js, lobby.js) the way a browser would: the real
// HTML from public/chat in happy-dom, with the browser APIs the page uses
// swapped for fakes the test controls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

/** Put the body of public/chat/<file> into the document, minus its scripts. */
export function loadHtml(file) {
  const html = readFileSync(join(import.meta.dirname, "../../public/chat", file), "utf8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;
}

/** A stand-in for window.location; navigation just updates href. */
export function fakeLocation(url) {
  const u = new URL(url);
  const loc = {
    href: u.href,
    origin: u.origin,
    hostname: u.hostname,
    pathname: u.pathname,
    search: u.search,
    replace: vi.fn((to) => (loc.href = to)),
  };
  vi.stubGlobal("location", loc);
  return loc;
}

/** fetch that answers each call with the next queued response (or throws it, if it's an Error). */
export function fakeFetch() {
  const queue = [];
  const fetch = vi.fn(async () => {
    const next = queue.shift() ?? new Response("{}");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  return Object.assign(fetch, {
    respond: (...responses) => queue.push(...responses),
    /** Calls to one path, with their parsed JSON bodies. */
    to: (path) =>
      fetch.mock.calls
        .filter(([url]) => url === path || url.endsWith(path))
        .map(([url, init]) => ({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })),
  });
}

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

export function track(kind) {
  return { kind, enabled: true, stop: vi.fn() };
}

/**
 * A stream with fake tracks the test can inspect. It's a real happy-dom
 * MediaStream underneath, since <video>.srcObject accepts nothing else.
 */
export function mediaStream(...kinds) {
  const tracks = kinds.map(track);
  return Object.assign(new MediaStream(), {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  });
}

/** Let the page's pending promises and zero-delay timers run. */
export const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * In-memory localStorage. Node 25+ has its own global localStorage, which is
 * unusable without --localstorage-file and shadows happy-dom's.
 */
export function fakeLocalStorage() {
  const items = new Map();
  const storage = {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
    clear: () => items.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}
