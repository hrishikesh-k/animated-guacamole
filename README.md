# VUL-439 reproduction harness

A **benign** harness to confirm the VUL-439 trust/authorization boundary on a
**throwaway site you own**. It proves the boundary is crossed; it does not
exercise the damage the HackerOne report demonstrated (no session/PII
enumeration, no XSS, no cache purge, no AI spend, no exfiltration).

## Safety properties

- Writes only to keys prefixed `vul439/` in a store named `vul439-canary`, and
  to one env var `VUL439_BUILD_CANARY`. Every canary is deleted after the probe.
- Reads back only what it wrote. Never calls `list()` or reads arbitrary keys.
- Prints token **length and decoded claims only** (the JWT body) — never a token
  value.
- Talks only to `api.netlify.com` and the site's own origin. No external hosts.
- Does **not** call the purge endpoint or the AI gateway. It reports only that
  those credentials are present and site-scoped, which is the defect.

> This touches shared production infrastructure. Get Security sign-off before a
> live run, even on your own throwaway site.

## Setup

1. Push this repo to a **public** GitHub repo under your account.
2. Connect it to a **new, throwaway** Netlify site. Keep defaults (Deploy
   Previews on). Confirm the site has **no** env var the secrets detector would
   flag (nothing containing `TOKEN`/`SECRET`/`API_KEY`/`PASSWORD`, no
   high-entropy values). If it does, the review gate fires — which is itself a
   finding worth noting.
3. From a **second GitHub account that is NOT on the Netlify team**, fork the
   repo and open a PR with a trivial change. This is the untrusted actor.

## Verification

### Finding 1 — fork PR auto-builds with no approval
Watch the site's Deploys. The PR's deploy-preview reaches **ready** with no
pending-review state. If it is held, note the reason (mitigation working).

### Finding A — build token can write team env vars (most serious)
Open the PR deploy-preview **build log**. Look for:
```
[VUL439] env-var PATCH status = 200 (200 => build token CAN write team env vars)
```
A 200 confirms untrusted PR code wrote a team env var through api.netlify.com.
401/403 means the API blocks it (static finding would be wrong — record the code).

### Findings 2-4 — runtime credentials injected into the untrusted function
Visit:
```
https://deploy-preview-<N>--<site>.netlify.app/.netlify/functions/vul439-probe
```
In the JSON:
- `blobs_context.siteID` == your production site ID, and
  `canary_readback == "vul439-canary"` => preview writes the site's shared
  Blobs namespace. `deployID: null` => not deploy-scoped.
- `purge_token.claims` showing `{site_id, exp}` => purge credential injected.
- `ai_gateway_key.claims` showing `{site_id, ...}` => AI credential injected.

### Control — compare against production
Deploy the same repo to production and hit the probe on the production URL. The
`blobs_context.siteID` is identical — preview and production share it.

## Cleanup
Delete the site, the fork, and the PR. Confirm no `VUL439_BUILD_CANARY` env var
and no `vul439-canary` store remain.
