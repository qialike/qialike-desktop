/**
 * The theme route and the row's activation, against the composed profile.
 *
 * WHAT ONLY A BOOTED PROFILE CAN ANSWER. Two of the three ways this feature fails
 * are invisible to a unit test:
 *
 *   · **The row does not activate.** A row naming a package nothing depends on
 *     resolves to nothing, and the only symptom is one `warning: 1 entry did not
 *     activate` line while the profile boots, serves and renders normally. That is
 *     how M5's read guard shipped inert, so it is asserted rather than assumed.
 *   · **The route answers with a shape the client cannot use.** The mapping from the
 *     CLI's palette to this surface's tokens is unit-tested, but whether the
 *     *route* returns it — under the real resolver, the real home, the real
 *     connection — is not.
 *
 * WHAT IT CANNOT ANSWER, AND WHY. `ctx.theme` and the `settings.general.item` slot
 * are *client* facts: they exist only in a browser, and this probe runs the Host in
 * Node. `tests/theme-client.test.mjs` covers them by executing the hand-written
 * bundle against a stub loader instead, which is the same treatment
 * `tests/shell-boot-bootstrap.test.mjs` gives the shell's injected script.
 *
 * The probe seeds a throwaway home with a user scheme and a stored preference, so a
 * user-file path and the persisted choice are exercised rather than described.
 *
 * Usage: `node theme-probe.mjs <runtimeDir>`
 *
 * @module qialike-desktop/theme-probe
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  console.error('usage: theme-probe.mjs <runtimeDir>')
  process.exit(2)
}

// A throwaway home: the probe must not read or write the developer's own
// `$DSH_HOME`, and seeding files is part of what it tests.
const home = mkdtempSync(join(tmpdir(), 'qialike-theme-'))
process.env.DSH_HOME = home

const themesDir = join(home, 'themes')
mkdirSync(themesDir, { recursive: true })

/** A user scheme in the CLI's format, to prove the directory is actually read. */
writeFileSync(join(themesDir, 'my-scheme.json'), `${JSON.stringify({
  name: 'my-scheme',
  palette: { bg: '#101418', text: '#e6e6e6', primary: '#ff8800', accent: '#00d1ff' },
}, null, 2)}\n`)

/** A scheme whose document has no `name`, so the file name has to stand in. */
writeFileSync(join(themesDir, 'nameless.json'), `${JSON.stringify({
  palette: { bg: '#fbfbfb', text: '#202020' },
})}\n`)

/** A file that cannot be parsed: it must cost this scheme and nothing else. */
writeFileSync(join(themesDir, 'broken.json'), '{ this is not json')

/** A file with no usable palette: skipped for a different reason. */
writeFileSync(join(themesDir, 'empty.json'), '{ "palette": { "bg": 42 } }')

/** A non-JSON file: the loader only considers `*.json`. */
writeFileSync(join(themesDir, 'notes.txt'), 'ignore me')

/**
 * A user file whose name clashes with a shipped scheme. The CLI merges built-ins
 * last (`{ ...userSchemes(), ...BUILTIN_SCHEMES }`), so this must lose — otherwise a
 * file named after a shipped scheme silently redefines it, which is the opposite of
 * what someone writing a *new* scheme intends and invisible when it happens.
 */
writeFileSync(join(themesDir, 'dracula.json'), `${JSON.stringify({
  name: 'dracula',
  palette: { bg: '#000000', text: '#ffffff' },
})}\n`)

/** A stored preference, in the CLI's own section and key. */
const SEEDED_PREFERENCE = 'my-scheme'
writeFileSync(join(home, 'qialike.json'), `${JSON.stringify({
  theme: { colorscheme: SEEDED_PREFERENCE, colors: { accent: '#123456' } },
  llm: { providers: {} },
}, null, 2)}\n`)

const appBoot = await import(
  pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
)
const profileBoot = await import(
  pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'profile-boot.js')).href
)

const profileDir = join(home, 'profiles', 'qialike-desktop')
appBoot.initProfile(profileDir, [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@qialike/qialike-desktop-app',
])
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)

// The Loader's activation outcome is collected from stderr, so the probe has to run
// with the profile's warnings visible rather than swallowed.
const running = await profileBoot.runProfile({
  environment: appBoot.loadLayeredEnv('dsh'),
  profile: 'qialike-desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
})

const ctx = running.ctx

/** The authenticated origin and cookie the shell itself redeems. */
async function authenticated() {
  const origin = `http://127.0.0.1:${String(ctx.get('webServer').port)}`
  // `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5: the
  // `webserver/entry-url` event and the package that published it were deleted, and
  // `packages/bundle/web-app` announces with this method itself. Calling it here keeps
  // the probe on its own call path rather than importing the code under test.
  const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const raw = handshake.headers.get('set-cookie') ?? ''
  return { origin, cookie: raw.slice(0, raw.indexOf(';')) }
}

const { origin, cookie } = await authenticated()

/** Call the theme route. */
async function call(method, body) {
  const response = await fetch(`${origin}/api/qialike/themes`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, payload: await response.json().catch(() => undefined) }
}

const list = await call('GET')

// Every activated Loader row, so a row that mounted but registered nothing is
// distinguishable from one that never mounted.
const rows = [...ctx.loader.entries()]
  .map((entry) => entry.options?.id)
  .filter((id) => typeof id === 'string')

// The client bundle's presence in what the browser is served. A package that
// declares `dsh.client` but is not reached by a mounted row is discovered by nothing,
// so this is the half of "the picker exists" a host probe can see.
const document = await (await fetch(`${origin}/`, { headers: { cookie } })).text()
const clientIds = [...document.matchAll(/"id"\s*:\s*"([^"]+)"/gu)].map((match) => match[1])

// The write path, including that it preserves what it does not own.
const beforeWrite = JSON.parse(readFileSync(join(home, 'qialike.json'), 'utf8'))
const write = await call('POST', { op: 'setPreference', name: 'dracula' })
const afterWrite = JSON.parse(readFileSync(join(home, 'qialike.json'), 'utf8'))
const rejected = await call('POST', { op: 'setPreference', name: 'no-such-scheme' })
const cleared = await call('POST', { op: 'setPreference', name: null })
const afterClear = JSON.parse(readFileSync(join(home, 'qialike.json'), 'utf8'))
const reloaded = await call('GET')
const unknownOp = await call('POST', { op: 'nonsense' })

process.stdout.write(`__REPORT__${JSON.stringify({
  route: {
    status: list.status,
    ok: list.payload?.ok,
    schemeCount: list.payload?.schemes?.length ?? null,
    names: (list.payload?.schemes ?? []).map((scheme) => scheme.name),
    sources: (list.payload?.schemes ?? []).filter((scheme) => scheme.source === 'user').map((scheme) => scheme.name),
    // Read from the shipped palette rather than the clashing user file.
    draculaBackground: (list.payload?.schemes ?? []).find((scheme) => scheme.name === 'dracula')?.tokens['--dsw-alias-bg-base'],
    preference: list.payload?.preference,
    // Reported relative to the throwaway home, with `/` as the separator on every
    // platform. The previous `entry.file.replace(`${home}/`, '')` only ever matched on
    // POSIX: on Windows `home` contains backslashes, so nothing was stripped and this
    // field carried absolute paths, which is both less readable and host-dependent for
    // what is a display name. These are identifiers in a report, not paths to open, so
    // one spelling across platforms is the useful property.
    skippedFiles: (list.payload?.skipped ?? []).map(
      (entry) => relative(home, entry.file).split(sep).join('/'),
    ),
    userDir: list.payload?.userDir,
    builtin: list.payload?.builtin,
    everySchemeHasTokens: (list.payload?.schemes ?? []).every(
      (scheme) => typeof scheme.tokens === 'object' && Object.keys(scheme.tokens).length > 0,
    ),
    idsNamespaced: (list.payload?.schemes ?? []).every((scheme) => scheme.id === `qialike-${scheme.name}`),
    idsUnique: new Set((list.payload?.schemes ?? []).map((scheme) => scheme.id)).size
      === (list.payload?.schemes ?? []).length,
  },
  write: {
    ok: write.payload?.ok,
    stored: afterWrite.theme?.colorscheme,
    preservedColors: afterWrite.theme?.colors,
    preservedLlm: afterWrite.llm !== undefined,
    rejectedUnknown: rejected.payload?.ok === false,
    rejectedMessage: rejected.payload?.message,
    clearedOk: cleared.payload?.ok,
    keyRemoved: afterClear.theme?.colorscheme === undefined,
    colorsSurvivedClear: afterClear.theme?.colors,
    preferenceAfterClear: reloaded.payload?.preference,
    unknownOpRejected: unknownOp.payload?.ok === false,
  },
  home: { configPath: join(home, 'qialike.json'), seededPreference: SEEDED_PREFERENCE, beforeWriteHadColors: beforeWrite.theme?.colors !== undefined },
  activation: { themeRow: rows.includes('qialike-theme'), rowCount: rows.length },
  clientIds,
})}\n`)

await running.shutdown.shutdown(0)
rmSync(home, { recursive: true, force: true })
process.exit(0)
