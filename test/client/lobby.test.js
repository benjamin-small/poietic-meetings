// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, fakeLocation, json, loadHtml, settle } from "./page.js";

const AUTH = "https://auth.poietic.tech";
const ROOM = "https://tinkers.poietic.tech/chat/r/0b5c6a64-56a2-4c43-9d58-8b0d6a3c2f11";

let fetch;
let loc;

beforeEach(() => {
  vi.resetModules();
  loadHtml("index.html");
  fetch = fakeFetch();
  loc = fakeLocation("https://tinkers.poietic.tech/chat");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const $ = (id) => document.getElementById(id);
const shown = (id) => !$(id).hidden;

/** Load the lobby; resolves once it has checked sign-in. */
async function openLobby(me = { authenticated: true, user: { shownAs: "Ada" } }) {
  if (me) fetch.respond(me instanceof Response || me instanceof Error ? me : json(me));
  await import("../../public/chat/lobby.js");
}

describe("lobby", () => {
  it("shows who's signed in, after asking auth with the session cookie", async () => {
    await openLobby();
    expect(fetch).toHaveBeenCalledWith(`${AUTH}/me`, { credentials: "include" });
    expect([shown("loading"), shown("signed-out"), shown("signed-in")]).toEqual([false, false, true]);
    expect($("who").textContent).toBe("Ada");
  });

  it("shows the sign-in buttons when not signed in", async () => {
    await openLobby({ authenticated: false });
    expect([shown("loading"), shown("signed-out"), shown("signed-in")]).toEqual([false, true, false]);
  });

  it("treats an auth error or an unreachable auth server as signed out", async () => {
    await openLobby(json({}, 500));
    expect(shown("signed-out")).toBe(true);

    vi.resetModules();
    loadHtml("index.html");
    await openLobby(new TypeError("Failed to fetch"));
    expect(shown("signed-out")).toBe(true);
  });

  it("points sign-in and sign-out at auth, returning to this page", async () => {
    await openLobby();
    const back = encodeURIComponent("https://tinkers.poietic.tech/chat");
    expect(document.querySelector('[data-provider="google"]').href).toBe(`${AUTH}/login/google?redirect=${back}`);
    expect(document.querySelector('[data-provider="github"]').href).toBe(`${AUTH}/login/github?redirect=${back}`);
    expect($("signout").href).toBe(`${AUTH}/logout?redirect=${back}`);
  });

  it("skips the auth check on localhost, where the dev bypass applies", async () => {
    loc = fakeLocation("http://localhost:8787/chat");
    await openLobby(null);
    expect(fetch).not.toHaveBeenCalled();
    expect($("who").textContent).toBe("Local dev");
  });

  it("creates a room and goes to it", async () => {
    await openLobby();
    fetch.respond(json({ url: ROOM }));
    $("create").click();
    expect($("create").disabled).toBe(true);
    await settle();
    expect(fetch).toHaveBeenLastCalledWith("/chat/rooms", { method: "POST" });
    expect(loc.href).toBe(ROOM);
  });

  it("renews a lapsed session and tries once more on 401", async () => {
    await openLobby();
    fetch.respond(json({}, 401), json({ authenticated: true }), json({ url: ROOM }));
    $("create").click();
    await settle();
    expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual(["/chat/rooms", `${AUTH}/me`, "/chat/rooms"]);
    expect(loc.href).toBe(ROOM);
  });

  it("falls back to signed out when the session can't be renewed", async () => {
    await openLobby();
    fetch.respond(json({}, 401), json({ authenticated: false }));
    $("create").click();
    await settle();
    expect(shown("signed-out")).toBe(true);
    expect(loc.href).toBe("https://tinkers.poietic.tech/chat");
  });

  it("doesn't retry forever if the server keeps saying 401", async () => {
    await openLobby();
    // Auth keeps vouching for the session, so only the one-retry limit stops it.
    const me = () => json({ authenticated: true });
    fetch.respond(json({}, 401), me(), json({}, 401), me(), json({ url: ROOM }));
    $("create").click();
    await settle();
    expect(fetch.to("/chat/rooms")).toHaveLength(2);
    expect(shown("signed-out")).toBe(true);
    expect(loc.href).toBe("https://tinkers.poietic.tech/chat");
  });

  it("shows the error and lets you try again when creating fails", async () => {
    await openLobby();
    fetch.respond(json({}, 503));
    $("create").click();
    await settle();
    expect($("error").textContent).toBe("Couldn't create a room (503)");
    expect($("create").disabled).toBe(false);

    fetch.respond(json({ url: ROOM }));
    $("create").click();
    expect($("error").textContent).toBe("");
    await settle();
    expect(loc.href).toBe(ROOM);
  });
});
