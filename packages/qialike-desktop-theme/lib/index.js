/**
 * The theme settings API: the CLI's colour schemes and the shared preference,
 * served over an authenticated HTTP route.
 *
 * WHY THIS IS THE PACKAGE ROOT. A row may only be a client row — one whose package
 * declares `dsh.client` and whose bundle reaches the browser — when its name is the
 * *exact* package specifier; `exactPackageSpecifier(row.name)` returns `undefined`
 * for a subpath, which the client-module scanner treats as "permanently not a client
 * row". The picker is the half with a browser counterpart, so it is the root module
 * and everything else here is a helper. (Same constraint, same shape, as
 * `@qialike/qialike-desktop-providers`.)
 *
 * WHY THE HOST SERVES THE SCHEMES RATHER THAN THE CLIENT CARRYING THEM. Two
 * reasons, and the second is the load-bearing one:
 *
 *   · User schemes live in `$DSH_HOME/themes/*.json` and can only be read from the
 *     Host. A client-side list would be the shipped fifteen and nothing else.
 *   · The mapping from the CLI's 16-role palette to this surface's `--dsw-alias-*`
 *     tokens is a judgement written once, in this package. Duplicating it into the
 *     client bundle would mean two copies of a table that has to stay in step with
 *     the harness's token set — and the client is the half that cannot be
 *     unit-tested here (it is hand-written browser JavaScript with no build step).
 *     So the Host maps, and the client registers what it is given.
 *
 * WHY `qialike.json` FOR THE PREFERENCE. The same reasoning as the providers row
 * (DESIGN §12.2 R12): the harness's settings document belongs to a *profile*, so a
 * value written there is invisible to the CLI's `tui` profile, while `qialike.json`
 * is the file both products read. The CLI keeps its colourscheme at section `theme`,
 * key `colorscheme` — this row writes that exact key, so `/theme dracula` in the
 * terminal and a click here are the same act.
 *
 * THE FILE IS WRITTEN HERE, NOT THROUGH THE CLI. `@qialike/qialike-app` exports
 * neither `config.ts` nor `theme-plugin.ts`; its own build inlines both into
 * consumers, so there is no built subpath through which its `writeSection()` could
 * be called. The rules below therefore mirror its `persistConfig()` — merge rather
 * than replace, two-space JSON with a trailing newline, mode 0600 — with one
 * deliberate improvement: the write is atomic, which the CLI's is not, and the
 * `colors` sub-key the CLI also stores under `theme` is preserved untouched because
 * it belongs to the terminal client's per-role overrides.
 *
 * @module @qialike/qialike-desktop-theme
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SCHEME_PALETTES } from './palettes.js'
import { colorSchemeOf, themeIdFor, toThemeDefinition } from './tokens.js'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'qialike-theme'

/** The one route this row serves. */
export const API_PATH = '/api/qialike/themes'

/** The `qialike.json` section the CLI keeps its colourscheme in. */
const SECTION = 'theme'

/** The key inside that section. The CLI writes exactly this. */
const PREFERENCE_KEY = 'colorscheme'

/** The palette keys, as the CLI's `ThemePalette` declares them. */
const PALETTE_KEYS = [
  'bg', 'panel', 'element', 'borderSubtle', 'border', 'borderActive',
  'text', 'textMuted', 'primary', 'secondary', 'accent',
  'success', 'warning', 'info', 'error', 'yellow',
]

/** The shared configuration document, as this row reads it. */
const configPath = () => dshHomePath('qialike.json')

/** The directory holding user colourschemes (the CLI's `~/.dsh/themes`). */
const themesDir = () => dshHomePath('themes')

/**
 * Read the configuration document.
 *
 * Absent or unparsable is `{}` rather than an error, matching the CLI and the
 * providers row: a half-written file must not take the settings surface down, and
 * every consumer treats a missing key as a default.
 *
 * @returns the parsed document, or an empty one.
 */
function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // Missing or malformed -> defaults.
  }
  return {}
}

/**
 * Persist the configuration document atomically.
 *
 * A temporary file in the same directory, then a rename: a reader sees either the
 * previous document or the next one, never a truncated one. The mode is set on the
 * temporary file and the result is chmod-ed as well, because `mode` only applies at
 * creation — an existing 0644 file would keep its bits, and this file holds provider
 * credentials' names and the user's whole configuration for a shared home.
 *
 * @param next - the complete document to write.
 * @returns whether the write landed.
 */
function writeConfig(next) {
  const path = configPath()
  const temporary = join(dirname(path), `.qialike.json.${String(process.pid)}.tmp`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup; the write failure is what matters.
    }
    return false
  }
}

/** The persisted colourscheme name, or null when the user follows the built-ins. */
function readPreference() {
  const section = readConfig()[SECTION]
  if (typeof section !== 'object' || section === null) return null
  const value = section[PREFERENCE_KEY]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Persist the colourscheme choice, preserving everything else in the file.
 *
 * `null` records "follow the harness's own light/dark/system preference" rather than
 * deleting the key: an absent key and "the user chose to stop using a scheme" are
 * different intentions, and only one of them should leave the harness row in charge.
 * The CLI reads an absent key as its default, which is why the value is written as
 * an empty string in neither case — `null` removes the key, and the Client stores
 * the explicit choice in its own state.
 *
 * @param schemeName - the scheme name, or null to clear the choice.
 * @returns whether the write landed.
 */
function writePreference(schemeName) {
  const config = readConfig()
  const current = typeof config[SECTION] === 'object' && config[SECTION] !== null ? config[SECTION] : {}
  const next = { ...current }
  if (schemeName === null) delete next[PREFERENCE_KEY]
  else next[PREFERENCE_KEY] = schemeName
  // `colors` belongs to the CLI's per-role overrides and is not ours to drop: a
  // desktop click that removed the terminal client's `:theme <role> <hex>` tweaks
  // would be a data loss with no visible cause.
  return writeConfig({ ...config, [SECTION]: next })
}

/**
 * One scheme file, as the CLI's `loadUserScheme()` parses it.
 *
 * Mirrored rather than approximated, because these files are written for the
 * terminal client and both products have to agree on what they mean: `name` from the
 * document when it is a string and from the file name otherwise, only the sixteen
 * palette keys, only hex values, and an empty result meaning "not a scheme".
 *
 * @param path - the file to read.
 * @returns the name and palette, or a reason it was skipped.
 */
function loadUserScheme(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : String(error) }
  }
  if (typeof raw !== 'object' || raw === null) return { skipped: 'the file is not a JSON object' }
  // The CLI accepts a bare palette as well as `{ name, palette }`.
  const pal = typeof raw.palette === 'object' && raw.palette !== null ? raw.palette : raw
  const palette = {}
  for (const key of PALETTE_KEYS) {
    const value = pal[key]
    if (typeof value === 'string') palette[key] = value
  }
  if (Object.keys(palette).length === 0) return { skipped: 'no palette keys found' }
  const fileName = basename(path).replace(/\.json$/iu, '')
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : fileName
  return { name, palette }
}

/**
 * Every scheme the surface can offer: the shipped fifteen plus the user's own files.
 *
 * BUILT-INS WIN ON A NAME CLASH, matching the CLI's
 * `{ ...userSchemes(), ...BUILTIN_SCHEMES }`. The other order would let a file named
 * `dracula.json` silently redefine a shipped scheme, which is the opposite of what
 * someone writing a *new* scheme intends and invisible when it happens.
 *
 * A file that fails to parse costs that one scheme and nothing else. The failures
 * are returned rather than logged into the void: a user who wrote a scheme and
 * cannot find it in the picker needs to learn that the file was the problem, and
 * only the response can tell them.
 *
 * @returns the schemes, ordered by name, and the files that were skipped.
 */
function collectSchemes() {
  const merged = new Map()
  const skipped = []

  const dir = themesDir()
  if (existsSync(dir)) {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch (error) {
      skipped.push({ file: dir, reason: error instanceof Error ? error.message : String(error) })
    }
    for (const entry of entries) {
      if (!/\.json$/iu.test(entry)) continue
      const loaded = loadUserScheme(join(dir, entry))
      if (loaded.skipped !== undefined) {
        skipped.push({ file: join(dir, entry), reason: loaded.skipped })
        continue
      }
      merged.set(loaded.name, { palette: loaded.palette, source: 'user' })
    }
  }

  for (const [schemeName, palette] of Object.entries(SCHEME_PALETTES)) {
    merged.set(schemeName, { palette, source: 'shipped' })
  }

  const schemes = []
  for (const schemeName of [...merged.keys()].sort((a, b) => a.localeCompare(b))) {
    const { palette, source } = merged.get(schemeName)
    const definition = toThemeDefinition({ name: schemeName, palette })
    // A scheme that maps to no token would be an entry in the picker that changes no
    // colour when chosen. `toThemeDefinition` returns undefined exactly then, so the
    // filter is a fact about the palette rather than a second validation pass.
    if (definition === undefined) {
      skipped.push({ file: schemeName, reason: 'the palette has no colour this surface can map' })
      continue
    }
    schemes.push({
      name: schemeName,
      id: definition.id,
      colorScheme: definition.colorScheme,
      tokens: definition.tokens,
      source,
    })
  }
  return { schemes, skipped }
}

/**
 * What the client needs to offer the picker and restore the user's choice.
 *
 * `preference` is the scheme name (not the namespaced id) because that is the value
 * `qialike.json` holds and the CLI understands; the client prefixes it for the
 * registry. `builtin` names the harness's own three preferences so the picker can
 * offer them without hard-coding a list the harness owns.
 *
 * @returns the response payload.
 */
function describeThemes() {
  const { schemes, skipped } = collectSchemes()
  return {
    ok: true,
    schemes,
    preference: readPreference(),
    // Reported so a user whose file was skipped can find out why. Not an error
    // status: the surface works, it is one scheme lighter.
    skipped,
    userDir: themesDir(),
    builtin: ['system', 'light', 'dark'],
  }
}

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

/**
 * Apply one mutation and report what happened.
 *
 * @param body - the parsed request body.
 * @returns the response payload.
 */
function mutate(body) {
  if (body.op !== 'setPreference') {
    return { ok: false, message: `unknown op ${JSON.stringify(body.op)}` }
  }
  const requested = body.name
  if (requested !== null && typeof requested !== 'string') {
    return { ok: false, message: 'name must be a string or null' }
  }
  if (typeof requested === 'string') {
    // Validated against what this build can actually serve, so a typo persists as a
    // refusal rather than as a preference the picker cannot honour — the next start
    // would otherwise fall back silently and the user would have no way to tell a
    // bad name from a lost setting.
    const { schemes } = collectSchemes()
    if (!schemes.some((scheme) => scheme.name === requested)) {
      return { ok: false, message: `no scheme named ${JSON.stringify(requested)}` }
    }
  }
  if (!writePreference(requested)) {
    return { ok: false, message: `could not write ${configPath()}` }
  }
  return { ok: true, preference: requested }
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
 * Registered through `ctx.inject` rather than a hard `inject` entry: a profile
 * without a connection has no browser surface to serve, and the row should stay
 * mountable there rather than being held pending forever.
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
          if (request.method === 'GET') return json(describeThemes())
          const body = await readBody(request)
          if (typeof body === 'string') return json({ ok: false, message: body }, 400)
          return json(mutate(body))
        } catch (error) {
          return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
        }
      },
    }), 'qialike-theme: settings API')
  })
}
