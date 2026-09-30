/**
 * Routes served by the host half. The client half talks to exactly these.
 *
 * A `prefix` route must be registered without a trailing slash: the webserver
 * matches `pathname === prefix || pathname.startsWith(prefix + '/')`.
 */
export const POND_BASE = '/plugins/dsh-pondkoi'
export const STATE_ROUTE = POND_BASE + '/state'
export const RENAME_ROUTE = POND_BASE + '/rename'
export const WEATHER_ROUTE = POND_BASE + '/weather'
export const DIALOGUE_ROUTE = POND_BASE + '/dialogue'
/** Registered path: no trailing slash. */
export const ASSET_ROUTE = POND_BASE + '/assets'
/** URL prefix the client appends asset names to: with the trailing slash. */
export const ASSET_BASE = ASSET_ROUTE + '/'
export const ASSET_CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

export function assetContentType(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? 'application/octet-stream' : (ASSET_CONTENT_TYPES[file.slice(dot)] ?? 'application/octet-stream')
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Bounded identifier: never a path, so a client cannot steer the save location. */
export function isBoundedId(value, max = 256) {
  // Reject path separators and every C0 control character plus DEL. The id is
  // only ever used as de-dup key material, but keeping it free of control
  // characters means it can never corrupt a log line or a JSON round-trip.
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\\/\u0000-\u001f\u007f]/u.test(value)
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Request body budget. A pond save is a few KiB; refuse anything larger. */
export const MAX_BODY_BYTES = 16 * 1024

export async function readJsonBody(req, max = MAX_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > max) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function failure(error) {
  return {
    ok: false,
    error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  }
}
