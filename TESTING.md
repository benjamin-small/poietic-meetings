# Testing

```bash
npm test            # syntax check, Worker tests, browser-module tests
npm run coverage    # the same tests with coverage, reports in coverage/
```

There are two suites. Neither needs a network, a real browser or Cloudflare credentials.

## Worker tests (`test/*.test.ts`, 51 tests)

Run inside the Workers runtime by `@cloudflare/vitest-pool-workers` ([vitest.config.ts](vitest.config.ts)), with a throwaway signing key standing in for `auth.poietic.tech`.

- **Creating rooms:** session cookie required; expired, wrong-audience, wrong-issuer, unknown-key and tampered tokens rejected; cross-site requests rejected; the dev bypass works on localhost only.
- **Static pages:** the lobby served at `/`, and every file the lobby, room and room-not-found pages load or link to exists.
- **Room lookups:** room pages and WebSockets for existing and unknown rooms; ICE servers only reach people who join.
- **Signaling:** welcome with current peers, relaying only to the addressed peer with a server-set `from`, single join, the 6-person cap, leave notifications.
- **Expiry, idle sockets, heartbeat:** the 24-hour sweep, evicting sockets that never join, closing sockets that stop pinging.
- **Reconnecting:** resume with `{id, token}`, wrong tokens, the 30s grace period, leaving from a fresh socket, the room object being reset.
- **TURN** (`test/turn.test.ts`): credential requests, caching for an hour, falling back to STUN on errors.
- **Client reports:** field whitelist, clipping, and rejecting other sites, unknown events, bad JSON and oversized bodies.

## Browser tests (`test/client/*.test.js`, 78 tests)

Configured in [vitest.client.config.ts](vitest.client.config.ts). `signaling.js` and `mesh.js` run in Node against fake WebSockets and peer connections ([test/client/fakes.js](test/client/fakes.js)). The two pages, `lobby.js` and `app.js`, run in [happy-dom](https://github.com/capricorn86/happy-dom) with their real HTML from `public/`, and fake `fetch`, `location`, camera and clipboard ([test/client/page.js](test/client/page.js)).

- **`signaling.js`:** the WebSocket URL, reconnecting with backoff, stalled connects, giving up after a number of attempts, `full` handling, saying goodbye while connected or disconnected.
- **`mesh.js`:** using the welcome's ICE servers, retrying failed connections, crossing offers (polite and impolite sides), stale answers, resume, the candidate buffer cap, the chat rate limit, receiving without a camera or mic, and screen sharing (swapping the sent video on every connection, sending the screen to people who join mid-share, a sendable video slot without a camera whichever side offered, the `screen` flag, video that arrives without a stream, the bigger upload budget).
- **`lobby.js`:** showing signed in or out (including when auth is down), sign-in and sign-out links, the localhost bypass, creating a room, renewing a lapsed session once on 401, and showing errors.
- **`app.js`** (with fake `signaling.js` and `mesh.js`, so these test the page, not the call): the name dialog and remembering the name, falling back to mic-only or no media, tiles for people joining and leaving, connection state and failure reports, mute and camera indicators, chat (enabling, sending, rendering as text, the 200-message cap), mic, camera, copy-link and leave controls, screen sharing (only where supported; start, stop, the browser's own stop, restoring the camera's state, no camera, a cancelled picker, stopping on leave, others' screens shown whole), full and missing rooms, and reconnecting (resume, outage reports, giving up).

## Not covered

- Layout and styling: happy-dom doesn't render, so nothing checks how the pages look.
- Real media and real browsers: nothing automated runs actual `RTCPeerConnection`s, NAT traversal or TURN relaying. Check those by hand, two browsers on [the live site](https://meetings.poietic.tech/) or `npm run dev`, with `?relay=1` to force TURN.

## Coverage

Measured with Istanbul on 2026-10-04 (`npm run coverage`):

| Suite | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| Worker (`src/`) | 96.1% | 94.2% | 87.2% | 96.4% |
| Browser (`public/*.js`) | 96.4% | 91.8% | 79.8% | 84.1% |

By file, browser lines: `app.js` 100%, `lobby.js` 100%, `signaling.js` 89.3%, `mesh.js` 95.3%. Update this table when the numbers move noticeably.
