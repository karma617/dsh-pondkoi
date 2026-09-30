import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PondStore } from './src/store.js'
import { fetchLiveWeather } from './src/weather.js'
import {
  ASSET_ROUTE,
  DIALOGUE_ROUTE,
  RENAME_ROUTE,
  STATE_ROUTE,
  WEATHER_ROUTE,
  assetContentType,
  failure,
  isBoundedId,
  isRecord,
  readJsonBody,
  sendJson,
} from './src/routes.js'

export const name = 'dsh-pondkoi'

/** Only the host API surface the host half actually consumes. */
export const inject = ['webServer']

const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url))

const Config = {
  saveFile: 'dsh-pondkoi.json',
  capacity: 16,
  liveWeather: true,
}

/**
 * Only these basenames are servable. The list is derived from the shipped
 * assets directory rather than hand-written, so a renamed or added asset
 * cannot silently 404 and a hand-typed name cannot drift from the file on
 * disk. Membership is still checked before any read, so a traversal attempt
 * (`..`, an absolute path, a subdirectory) can never escape the directory.
 */
const ASSET_NAMES = new Set(readdirSync(ASSET_DIR, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => entry.name))

/** Reject cross-origin requests: the pond is same-origin only. */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  return origin === 'http://' + host || origin === 'https://' + host
}

function pondRoutes(service) {
  const guard = handler => async (req, res) => {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return }
    if (req.method !== 'POST' && req.method !== 'GET') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
    try {
      await handler(req, res)
    } catch (error) {
      sendJson(res, 500, failure(error))
    }
  }

  return [
    { kind: 'exact', path: STATE_ROUTE, handler: guard(async (req, res) => {
      sendJson(res, 200, { ok: true, value: await service.store.view() })
    }) },
    { kind: 'exact', path: RENAME_ROUTE, handler: guard(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      const payload = await readJsonBody(req)
      if (!isRecord(payload)) throw new Error('rename payload must be an object')
      const changed = await service.store.renameFish(payload.id, payload.name)
      sendJson(res, 200, { ok: true, value: changed })
    }) },
    { kind: 'exact', path: DIALOGUE_ROUTE, handler: guard(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      const payload = await readJsonBody(req)
      if (!isRecord(payload) || !isBoundedId(payload.sessionId, 128) || !isBoundedId(payload.requestId, 128)) {
        throw new Error('dialogue payload requires a bounded sessionId and requestId')
      }
      const changed = await service.store.recordDialogue(payload.sessionId, payload.requestId)
      sendJson(res, 200, { ok: true, value: changed })
    }) },
    { kind: 'exact', path: WEATHER_ROUTE, handler: guard(async (req, res) => {
      sendJson(res, 200, { ok: true, value: service.config.liveWeather ? await fetchLiveWeather() : null })
    }) },
    { kind: 'prefix', path: ASSET_ROUTE, handler: guard(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return }
      // Strip the query, then the route prefix and its separator, leaving only
      // the asset basename. Membership in ASSET_NAMES is checked before any
      // read, so `..` or a subdirectory can never escape the assets directory.
      const requested = req.url.split('?')[0]
      const name = decodeURIComponent(requested.slice(requested.indexOf(ASSET_ROUTE) + ASSET_ROUTE.length).replace(/^\/+/, ''))
      if (!ASSET_NAMES.has(name)) { res.writeHead(404); res.end('not found'); return }
      let body
      try {
        body = await readFile(join(ASSET_DIR, name))
      } catch {
        res.writeHead(404); res.end('not found'); return
      }
      res.writeHead(200, {
        'content-type': assetContentType(name),
        'content-length': body.length,
        'cache-control': 'public, max-age=86400',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    }) },
  ]
}

export function apply(ctx, config = Config) {
  const settings = { ...Config, ...config }
  const store = new PondStore(join(resolveDshHome(), settings.saveFile), { capacity: settings.capacity })
  const service = { store, config: settings }

  ctx.effect(() => {
    const disposers = pondRoutes(service).map(route => ctx.webServer.register(route))
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-pondkoi: pond Host API')

  ctx.effect(() => {
    // A pending save must not be lost when the fiber is torn down.
    return () => { void store.flush().catch(error => console.warn('dsh-pondkoi: flush failed', error)) }
  }, 'dsh-pondkoi: pond flush')

  return service
  return service
}

// Cordis loads a plugin entry as a module namespace, so `apply` must also be
// the default export. `inject` and `Config` are attached to the function, which
// is how the host reads them without a second lookup.
apply.inject = inject
apply.Config = Config
export default apply

export { PondStore } from './src/store.js'
export { fetchLiveWeather } from './src/weather.js'
export * from './src/routes.js'
