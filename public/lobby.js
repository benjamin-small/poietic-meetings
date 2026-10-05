const AUTH = "https://auth.poietic.tech";
const $ = (id) => document.getElementById(id);
// Local `wrangler dev` can't see the .poietic.tech cookie; the Worker's
// DEV_AUTH_BYPASS lets localhost create rooms without it.
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

function show(state, name = "") {
  $("loading").hidden = true;
  $("signed-out").hidden = state !== "out";
  $("signed-in").hidden = state !== "in";
  $("who").textContent = name;
}

// /me also renews a lapsed 10-minute session token, so call it before
// anything that needs the cookie.
async function whoAmI() {
  if (isLocal) return { authenticated: true, user: { shownAs: "Local dev" } };
  try {
    const res = await fetch(`${AUTH}/me`, { credentials: "include" });
    return res.ok ? await res.json() : { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

async function createRoom(retry = true) {
  const res = await fetch("/rooms", { method: "POST" });
  if (res.status === 401 && retry) {
    const me = await whoAmI();
    if (me.authenticated) return createRoom(false);
  }
  if (res.status === 401) return show("out");
  if (!res.ok) throw new Error(`Couldn't create a room (${res.status})`);
  const { url } = await res.json();
  location.href = url;
}

const back = encodeURIComponent(location.href);
for (const a of document.querySelectorAll("[data-provider]")) {
  a.href = `${AUTH}/login/${a.dataset.provider}?redirect=${back}`;
}
$("signout").href = `${AUTH}/logout?redirect=${back}`;

$("create").onclick = async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  $("error").textContent = "";
  try {
    await createRoom();
  } catch (err) {
    $("error").textContent = err.message;
    button.disabled = false;
  }
};

const me = await whoAmI();
if (me.authenticated) show("in", me.user?.shownAs ?? "you");
else show("out");
