# Testing

```bash
npm test            # syntax check, Worker tests, browser-module tests
npm run coverage    # the same tests with coverage, reports in coverage/
```

There are two suites. Neither needs a network, a browser or Cloudflare credentials.

## Worker tests (`test/*.test.ts`, 49 tests)

Run inside the Workers runtime by `@cloudflare/vitest-pool-workers` ([vitest.config.ts](vitest.config.ts)), with a throwaway signing key standing in for `auth.poietic.tech`.

- **Creating rooms:** session cookie required; expired, wrong-audience, wrong-issuer, unknown-key and tampered tokens rejected; cross-site requests rejected; the dev bypass works on localhost only.
- **Room lookups:** room pages and WebSockets for existing and unknown rooms; ICE servers only reach people who join.
- **Signaling:** welcome with current peers, relaying only to the addressed peer with a server-set `from`, single join, the 6-person cap, leave notifications.
- **Expiry, idle sockets, heartbeat:** the 24-hour sweep, evicting sockets that never join, closing sockets that stop pinging.
- **Reconnecting:** resume with `{id, token}`, wrong tokens, the 30s grace period, leaving from a fresh socket, the room object being reset.
- **TURN** (`test/turn.test.ts`): credential requests, caching for an hour, falling back to STUN on errors.
- **Client reports:** field whitelist, clipping, and rejecting other sites, unknown events, bad JSON and oversized bodies.

## Browser-module tests (`test/client/*.test.js`, 20 tests)

Run in Node against fake WebSockets and peer connections ([test/client/fakes.js](test/client/fakes.js), [vitest.client.config.ts](vitest.client.config.ts)).

- **`signaling.js`:** reconnecting with backoff, stalled connects, giving up after a number of attempts, `full` handling, saying goodbye while connected or disconnected.
- **`mesh.js`:** using the welcome's ICE servers, retrying failed connections, crossing offers (polite and impolite sides), stale answers, resume, the candidate buffer cap, the chat rate limit, receiving without a camera or mic.

## Not covered

- `app.js` and `lobby.js` (page wiring and DOM) have no tests.
- Real media and real browsers: nothing runs actual `RTCPeerConnection`s, NAT traversal or TURN relaying. Check those by hand, two browsers on [the live site](https://tinkers.poietic.tech/chat) or `npm run dev`, with `?relay=1` to force TURN.

## Coverage

Measured with Istanbul on 2026-10-04 (`npm run coverage`):

| Suite | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| Worker (`src/`) | 96.1% | 94.2% | 87.2% | 96.4% |
| Browser modules (`public/chat/*.js`) | 49.3% | 46.0% | 42.8% | 29.5% |

The browser figure is low because `app.js` and `lobby.js` are at 0%. The modules that are tested are `mesh.js` at 88.2% of lines and `signaling.js` at 89.3%. Update this table when the numbers move noticeably.
