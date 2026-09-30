import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { PondStore } from './src/store.js'
import { fetchLiveWeather } from './src/weather.js'
import {
  ASSET_CONTENT_TYPES,
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

/**
 * Config schema. Cordis calls `runtime.Config['~standard'].validate(config)`,
 * so this MUST be a Standard Schema (schemastery), not a plain object — a plain
 * object makes `~standard` undefined and the plugin fails to activate.
 * Every field carries its default, which is what `apply` receives.
 */
export const Config = z.object({
  /** Save file name, relative to the DSH home. Must not contain separators. */
  saveFile: z.string().default('dsh-pondkoi.json'),
  /** Maximum fish plus unhatched eggs. */
  capacity: z.natural().min(1).max(16).default(16),
  /** Whether to answer the weather route from Open-Meteo. */
  liveWeather: z.boolean().default(true),
})

/**
 * Resolve one requested asset to an absolute path inside the assets directory,
 * or undefined when it must not be served.
 *
 * The directory is read per request rather than snapshotted at module load.
 * A snapshot goes stale as soon as the package is updated on disk: the running
 * process keeps serving the old name set, so a newly shipped asset returns 404
 * until the host restarts (this is exactly how the toggle icon first broke).
 *
 * Safety comes from name validation plus a containment check, not from a frozen
 * list: the name must be a flat basename with no separators, no parent
 * reference, no control characters and a permitted extension, and the resolved
 * path must stay inside the assets directory.
 */
export function resolveAsset(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return undefined
  // Reject anything but a flat file name: no separators, no `..`, no NUL/C0/DEL.
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(name)) return undefined
  if (name.includes('..')) return undefined
  const extension = name.slice(name.lastIndexOf('.'))
  if (!Object.hasOwn(ASSET_CONTENT_TYPES, extension)) return undefined
  const resolved = resolve(ASSET_DIR, name)
  // Containment: the result must sit directly inside ASSET_DIR.
  if (dirname(resolved) !== resolve(ASSET_DIR)) return undefined
  return resolved
}

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
      // the asset basename. resolveAsset validates the name and proves the
      // result stays inside the assets directory before anything is read.
      const requested = req.url.split('?')[0]
      const name = decodeURIComponent(requested.slice(requested.indexOf(ASSET_ROUTE) + ASSET_ROUTE.length).replace(/^\/+/, ''))
      const target = resolveAsset(name)
      if (target === undefined) { res.writeHead(404); res.end('not found'); return }
      let body
      try {
        body = await readFile(target)
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

/**
 * Cordis invokes the plugin as `callback(ctx, config)` with the already
 * validated config, so no schema resolution belongs here. The save file name is
 * still re-checked because it becomes a path segment.
 */
export function apply(ctx, config = {}) {
  const settings = {
    saveFile: 'dsh-pondkoi.json',
    capacity: 16,
    liveWeather: true,
    ...config,
  }
  if (!/^[\w.-]+$/.test(settings.saveFile)) {
    throw new Error('dsh-pondkoi: saveFile must be a plain file name')
  }
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
