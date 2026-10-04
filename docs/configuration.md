# Configuration

Bindings live in [wrangler.jsonc](../wrangler.jsonc). Secrets and local-only variables are below. Nothing reads a `.env` file; locally, Wrangler reads `.dev.vars` (gitignored). Copy [.dev.vars.example](../.dev.vars.example) to start.

| Name | Kind | Where | What |
|---|---|---|---|
| `CF_TURN_KEY_ID` | secret | production, optional locally | Cloudflare TURN key ID. Without it and the token, rooms fall back to STUN only. |
| `CF_TURN_KEY_API_TOKEN` | secret | production, optional locally | API token for that TURN key. |
| `DEV_AUTH_BYPASS` | variable | local only | `1` skips the sign-in check, and only when the hostname is `localhost` or `127.0.0.1`. |
| `ASSETS` | binding | `wrangler.jsonc` | Static files in `public/`. |
| `AUTH` | service binding | `wrangler.jsonc` | `poietic-auth`, which serves the public keys for checking sessions. |
| `ROOMS` | Durable Object binding | `wrangler.jsonc` | One `Room` object per room. |

The TURN values are in Infisical (project in [.infisical.json](../.infisical.json), env `dev`). In production, CI sets them with `wrangler secret put` from repository secrets; the README's Deployment section lists those.

After changing `wrangler.jsonc`, run `npm run types`.
