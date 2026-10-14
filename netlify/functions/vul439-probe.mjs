import { getStore } from '@netlify/blobs'

// VUL-439 runtime-credential probe. Benign by design:
//   - decodes injected credential claims only, never prints token values
//   - writes/reads/deletes a single namespaced canary in a canary store
//   - does NOT list or read any other key, does NOT call purge or AI gateway
const decodeClaims = (jwt) => {
  try {
    const [, body] = String(jwt).split('.')
    return JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return '<not a JWT>'
  }
}

export default async () => {
  const out = { context: process.env.CONTEXT || null }

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

      // Benign write -> read-back -> delete against a namespaced canary store.
      // Proves whether a preview write lands in the site's shared namespace.
      try {
        const store = getStore('vul439-canary')
        const key = `vul439/${process.env.DEPLOY_ID || 'preview'}`
        await store.set(key, 'vul439-canary')
        out.canary_readback = await store.get(key)
        await store.delete(key)
        out.canary_cleaned = true
      } catch (err) {
        out.canary_error = err.message
      }
    }
  } else {
    out.blobs_context = null
  }

  // Presence + claims only. Deliberately NOT exercised against live services.
  out.purge_token = {
    present: Boolean(process.env.NETLIFY_PURGE_API_TOKEN),
    claims: decodeClaims(process.env.NETLIFY_PURGE_API_TOKEN),
  }
  out.ai_gateway_key = {
    present: Boolean(process.env.NETLIFY_AI_GATEWAY_KEY),
    claims: decodeClaims(process.env.NETLIFY_AI_GATEWAY_KEY),
  }

  return Response.json(out)
}
