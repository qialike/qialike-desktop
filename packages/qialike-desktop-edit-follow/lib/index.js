/**
 * The edit-follow Cordis row: the switch's HTTP route, over the storage rules in
 * `./settings.js`.
 *
 * WHY THE HOST OWNS THE VALUE. The switch has to survive a restart, and the harness's own
 * settings document cannot hold it: that document belongs to a *profile*, so a value
 * written there is invisible to the CLI's profiles — the same wall the theme and providers
 * rows hit. `qialike.json` is the file both products read, so the preference lives there,
 * and only the Host half can touch it.
 *
 * WHY THIS FILE IS ONLY WIRING. It is the half that imports `@deepseek-ai/dsh-home-paths`,
 * which resolves in the assembled runtime tree and not in this repository's `node_modules`
 * — so nothing importing it can be unit-tested here. Every rule worth testing therefore
 * lives in `./settings.js`, which imports nothing from the harness, and this file adds the
 * route and the row's identity. The route itself is exercised by
 * `apps/desktop-bin/lib/edit-follow-probe.mjs` against a booted profile, the same division
 * the theme row uses.
 *
 * @module @qialike/qialike-desktop-edit-follow
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_ENABLED, mutate, readEnabled } from './settings.js'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-edit-follow'

/** The one route this row serves. */
export const API_PATH = '/api/qialike/edit-follow'

/** The shared configuration document. */
export const configPath = () => dshHomePath('qialike.json')

/** Read a JSON body. */
async function readBody(request) {
  try {
    const parsed = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return 'the body must be a JSON object'
    }
    return parsed
  } catch {
    return 'the body must be valid JSON'
  }
}

/** JSON response helper. */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Mount the route.
 *
 * Registered through `ctx.inject` rather than a hard `inject` entry: a profile with no
 * connection has no browser surface to serve, and the row should stay mountable there
 * rather than being held pending forever.
 *
 * @param ctx - the host context this row is mounted in.
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    scope.effect(() => connection.fetch.register({
      path: API_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const path = configPath()
          if (request.method === 'GET') {
            return json({ ok: true, enabled: readEnabled(path), default: DEFAULT_ENABLED })
          }
          const body = await readBody(request)
          if (typeof body === 'string') return json({ ok: false, message: body }, 400)
          return json(mutate(body, path))
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-edit-follow: settings API')
  })
}
