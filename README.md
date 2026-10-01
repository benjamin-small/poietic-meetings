# Tinker Chat

Group video chat over WebRTC (up to 6 people), at <https://tinkers.poietic.tech/chat>.

Creating a room needs a poietic.tech sign-in (Google or GitHub, via `auth.poietic.tech`). Anyone with the room link can join without an account; they pick a display name when they join. Video, audio and text chat go directly between the browsers; the server only helps them find each other.

## How it works

It's one Cloudflare Worker, `poietic-tinkers`, serving `tinkers.poietic.tech`:

| Path | What |
|---|---|
| `/` | Hub page listing tinkers |
| `/chat` | Lobby: sign in, then **Create a room** |
| `POST /chat/rooms` | Creates a room with a random UUID. Needs a valid poietic session and a same-origin request. |
| `/chat/r/<uuid>` | The room. Anyone with the link, up to 6 at once. 404 if the room doesn't exist. |
| `/chat/ws?room=` | WebSocket to the room's Durable Object. ICE servers, including TURN credentials, arrive in its `welcome`, so only people in the room get them. |

- **Sign-in check** ([src/auth.ts](src/auth.ts)): reads the shared `__Secure-poietic-session` cookie and checks it against `auth.poietic.tech`'s public key using [src/verify.ts](src/verify.ts), copied from poietic-dot-tech. This Worker holds no auth secrets.
- **Rooms** ([src/room.ts](src/room.ts)): one Durable Object per room. It holds up to 6 people, gives each person an ID, and relays `offer`, `answer` and `candidate` messages to the one peer they're addressed to. The server sets the sender's ID itself, so nobody can pose as another peer. The protocol is documented at the top of the file. A room is deleted after 24 hours with nobody in it.
- **Mesh calls** ([public/chat/mesh.js](public/chat/mesh.js)): every browser connects directly to every other, with a video connection and a chat data channel per person. The newcomer sends the offers. When offers do cross (someone back from a drop, or both sides retrying), the side with the lower ID gives way, and every offer carries an ID its answer echoes, so a late answer can't land on a newer connection. A connection that fails or never comes up is retried with a fresh offer, up to 3 times. Each browser splits a 1.5 Mbps video upload budget across its connections. The page ([app.js](public/chat/app.js)) only uses `MeshCall`'s small interface, so an SFU-backed version can replace it later.
- **TURN** ([src/turn.ts](src/turn.ts)): each room gets credentials from Cloudflare that are valid for 6 hours and reused within the room for an hour. If Cloudflare fails, it falls back to STUN only.
- **Client** ([public/](public/)): plain HTML, CSS and JavaScript modules, with no build step.

## Staying connected

Video runs peer to peer, so a dropped connection to the room server doesn't stop the call. It only pauses new signaling.

- **Heartbeat:** browsers send `{"type":"ping"}` every 20s. Cloudflare answers `{"type":"pong"}` itself without waking the room. A browser that hears no pong for 45s abandons the socket, and the room closes sockets that haven't pinged for 60s.
- **Reconnect and resume:** a dropped browser reconnects with backoff (0.5s up to 15s, giving up after 2 minutes) and rejoins with the `{id, token}` from its welcome. Its existing calls keep running and nobody sees it leave. Anyone who joined meanwhile gets connected when it's back.
- **Grace period:** people are stored in the room's storage, not tied to sockets. A drop starts a 30s window to come back, including when the room object itself is reset and every socket vanishes at once. After that, everyone gets `peer-left`. Clicking **Leave** or closing the tab skips the wait; if the connection is down at that moment, the browser opens one just to say goodbye. Everyone else is told when someone resumes (`peer-resumed`), so any call with them that was mid-setup starts over.
- **Idle sockets:** a socket that hasn't joined within 10s is closed, and when the room is at its socket limit the oldest such socket makes way for a newcomer, so idle connections can't lock anyone out.

## Observability

Everything lands in **Workers Logs** for `poietic-tinkers` (Cloudflare dashboard → Workers → poietic-tinkers → Logs), as one JSON line per event:

| `event` | From | Meaning |
|---|---|---|
| `connect`, `join` (`resumed`), `leave` (`how`), `close` (`code`, `how`), `stale`, `missing`, `reject`, `expire` | room | Room lifecycle. Room IDs are cut to 8 characters, peers are random IDs, and names are never logged. |
| `client:ws-close`, `client:reconnected`, `client:gave-up` | browser | Signaling drops: close code, time in the call, downtime, attempts, online/visible. |
| `client:peer-failed` | browser | A video connection that didn't come up: ICE/connection state and which local candidate types were gathered (host/srflx/relay). |

Browser reports go to `POST /chat/report`. It accepts same-origin requests only, a fixed list of fields, clipped values and at most 2 KB. The Worker adds coarse client info (OS, browser, network owner, HTTP version). Filter on `event` in the Logs view, for example `client:*` or `room = <first 8 chars>`.

## Development

```bash
npm install
npm run dev         # wrangler dev on http://localhost:8787
npm test            # syntax-checks public/chat, runs the Worker tests (Workers runtime) and the browser-module tests (Node, against fakes in test/client)
npm run typecheck
```

Local sign-in: the `.poietic.tech` cookie can't reach localhost, so create a gitignored `.dev.vars` containing `DEV_AUTH_BYPASS=1`. The bypass only works when the hostname is `localhost` or `127.0.0.1`, so it can't open up production even if the variable were set there.

Local TURN (optional): add `CF_TURN_KEY_ID` and `CF_TURN_KEY_API_TOKEN` to `.dev.vars`. They're in Infisical (project in [.infisical.json](.infisical.json), env `dev`). Without them it uses STUN only, which is fine on one machine. Add `?relay=1` to a room URL to force media through TURN.

After changing `wrangler.jsonc`, run `npm run types`.

## Deployment

**Infrastructure** (DNS, the Worker's existence and the `tinkers.poietic.tech/*` route) is owned by OpenTofu in [poietic-dot-tech](https://github.com/benjamin-small/poietic-dot-tech) (`infra/tinkers.tf`). **What the Worker serves** is deployed from this repo by GitHub Actions on every push to `main`: `wrangler deploy`, then the TURN secrets.

Repository secrets:

| Secret | Source |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers Scripts: Edit (account) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN` | Infisical, env `dev` |
