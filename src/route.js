/**
 * The browser's one endpoint: read the switch for a session's workspace, and
 * write it. It is an exact `/api/hindsight-switch` route rather than a Typert
 * Remote method because an out-of-tree plugin has no place in the generated
 * Remote pipeline; exact routes win over the connection's `/api` prefix, so the
 * two never collide.
 */

/** Route pathname. Registered as an exact route. */
export const SWITCH_ROUTE = '/api/hindsight-switch'

/** Request bodies are small; anything larger is refused before it is buffered. */
const MAX_BODY_BYTES = 4096

/**
 * Build the exact route.
 * @param options - read and write callbacks owned by the host plugin.
 * @returns the route registration.
 */
export function createSwitchRoute(options) {
  return {
    kind: 'exact',
    path: SWITCH_ROUTE,
    handler: (req, res) => {
      void handle(req, res, options).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
        else res.end()
      })
    },
  }
}

/**
 * Answer one request.
 * @param req - Node request.
 * @param res - Node response, owned for the whole lifecycle.
 * @param options - read and write callbacks plus a logger.
 */
async function handle(req, res, { readView, writeView, logger }) {
  if (!isTrusted(req)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') ?? ''
    sendJson(res, 200, readView(sessionId))
    return
  }
  if (req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { error: String(error?.message ?? error) })
      return
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      sendJson(res, 400, { error: 'body is not JSON' })
      return
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, { error: 'body must be an object' })
      return
    }
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (typeof payload.disabled !== 'boolean') {
      sendJson(res, 400, { error: 'disabled must be a boolean' })
      return
    }
    try {
      sendJson(res, 200, await writeView(sessionId, payload.disabled))
    } catch (error) {
      logger?.warn?.(`hindsight-switch: write failed: ${String(error?.message ?? error)}`)
      sendJson(res, 409, { error: String(error?.message ?? error) })
    }
    return
  }
  res.writeHead(405, { allow: 'GET, POST' })
  res.end()
}

/** Buffer a small request body, refusing anything past the cap. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Send one JSON response and end it. */
function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Browser-trust fence: the same two defenses the connection applies to `/api`.
 * The Host header is the DNS-rebinding defense — a rebound page carries the
 * attacker's domain there even though the socket lands on this server — and an
 * explicit cross-site marker or a foreign Origin is refused on top of it. Only
 * loopback is trusted, which is the shipped Web binding; a LAN deployment must
 * proxy or extend this list itself.
 * @param req - Node request.
 * @returns whether the request may reach the switch state.
 */
function isTrusted(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined
  if (host === undefined) return false
  let authority
  try {
    authority = new URL(`http://${host}`).host
  } catch {
    return false
  }
  if (!isLoopback(new URL(`http://${host}`).hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === authority
  } catch {
    return false
  }
}

/** Whether one hostname is a loopback address (the web server's default binding). */
function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}
