# Tinker Chat

1:1 video chat over WebRTC, at <https://tinkers.poietic.tech/chat>.

Creating a room needs a poietic.tech sign-in (Google or GitHub, via `auth.poietic.tech`). Anyone with the room link can join without an account. Video, audio and text chat go directly between the two browsers; the server only helps them find each other.

## How it works

It's one Cloudflare Worker, `poietic-tinkers`, serving `tinkers.poietic.tech`:

| Path | What |
|---|---|
| `/` | Hub page listing tinkers |
| `/chat` | Lobby: sign in, then **Create a room** |
| `POST /chat/rooms` | Creates a room with a random UUID. Needs a valid poietic session and a same-origin request. |
| `/chat/r/<uuid>` | The room. Anyone with the link. 404 if the room doesn't exist. |
| `/chat/config?room=` | ICE servers, including short-lived Cloudflare TURN credentials. Existing rooms only. |
| `/chat/ws?room=` | WebSocket to the room's Durable Object |

- **Sign-in check** ([src/auth.ts](src/auth.ts)): reads the shared `__Secure-poietic-session` cookie and checks it against `auth.poietic.tech`'s public key using [src/verify.ts](src/verify.ts), copied from poietic-dot-tech. This Worker holds no auth secrets.
- **Rooms** ([src/room.ts](src/room.ts)): one Durable Object per room. It holds up to 2 WebSockets and relays `offer`, `answer` and `candidate` messages. A room is deleted after 24 hours with nobody in it.
- **TURN** ([src/turn.ts](src/turn.ts)): gets credentials from Cloudflare that are valid for 24 hours and reused for an hour. If Cloudflare fails, it falls back to STUN only.
- **Client** ([public/](public/)): plain HTML, CSS and JavaScript, with no build step.

## Development

```bash
npm install
npm run dev         # wrangler dev on http://localhost:8787
npm test            # Worker + Durable Object tests in the Workers runtime
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
