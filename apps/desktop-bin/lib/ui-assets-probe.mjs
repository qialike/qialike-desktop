/**
 * Measure what the served document actually carries: the stylesheet, and the fonts.
 *
 * WHY A PROBE AND NOT A TEST. These facts are only true of a *served* document — the
 * shell's static route, the Host proxy, the MIME table and the injected `<style>` all
 * have to agree — and standing that up inside the suite would make every test that
 * asserts a colour depend on a booted profile. The probe boots one profile, asks it
 * the questions, and prints a single JSON line so the answers can be quoted.
 *
 * WHAT IT CANNOT ANSWER. Whether the window *looks* right. Chromium does not start in
 * this environment, so nothing here reads a computed style from a real layout; the
 * assertions are about the document the browser would receive and the bytes it would
 * fetch. That distinction is stated because "the stylesheet is served" and "the
 * stylesheet applies" are different claims, and only the first is testable here.
 *
 * Usage: `node ui-assets-probe.mjs <runtimeDir>`
 *
 * @module qialike-desktop/ui-assets-probe
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { referencedTokens } from './harness-tokens.mjs'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  console.error('usage: ui-assets-probe.mjs <runtimeDir>')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'qialike-uiasset-'))
process.env.DSH_HOME = home

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

const running = await profileBoot.runProfile({
  environment: appBoot.loadLayeredEnv('dsh'),
  profile: 'qialike-desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
})

const ctx = running.ctx
const origin = `http://127.0.0.1:${String(ctx.get('webServer').port)}`
// `connection.authenticatedUrl()` IS THE SUPPORTED PATH AGAIN IN 0.2.2-rc.5: the
// `webserver/entry-url` event and the package that published it were deleted, and
// `packages/bundle/web-app` announces with this method itself. Calling it here keeps
// the probe on its own call path rather than importing the code under test.
const handshake = await fetch(ctx.get('connection').authenticatedUrl(`${origin}/`), { redirect: 'manual' })
const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
const get = async (path) => await fetch(`${origin}${path}`, { headers: { cookie } })

const document = await (await get('/')).text()

/** Where the injected element sits relative to the upstream stylesheets. */
const styleIndex = document.indexOf('<style id="qialike-ui">')
const headEnd = document.indexOf('</head>')
const upstreamLinks = [...document.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/gu)]
  .map((match) => ({ href: match[1], at: match.index }))

/** Every font the stylesheet declares, fetched through the Host proxy. */
const fonts = []
for (const match of document.matchAll(/src:\s*url\('([^']+)'\)/gu)) {
  const url = match[1].replace(/^\.\//u, '/')
  const response = await get(url)
  const body = await response.arrayBuffer()
  fonts.push({
    url,
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: body.byteLength,
    // The woff2 signature, so a 200 carrying an error page is not read as success.
    magic: Buffer.from(body.slice(0, 4)).toString('latin1'),
  })
}

/**
 * The client bundles *as they ship*, read from the assembled tree.
 *
 * Read from disk rather than over HTTP because these are Host-served client modules
 * (`/api/…` is the JSON API, not a bundle), and because the question is what is in
 * the artifact rather than what one route happens to return.
 */
const bundles = {}
for (const name of ['providers', 'brand', 'theme']) {
  // `node_modules/@qialike/<name>`, which is where the member lives after the runtime
  // tree is de-linked. It used to be `packages/-qialike-qialike-desktop-<name>`, the
  // flattened workspace-member directory pnpm linked from `node_modules`.
  const path = join(runtimeDir, 'node_modules', '@qialike', `qialike-desktop-${name}`, 'lib', 'client.js')
  bundles[name] = readFileSync(path, 'utf8')
}

process.stdout.write(`__REPORT__${JSON.stringify({
  style: {
    present: styleIndex >= 0,
    insideHead: styleIndex >= 0 && styleIndex < headEnd,
    // The ordering fact: every upstream stylesheet must start before ours, or the
    // overrides lose every equal-specificity conflict and do nothing.
    afterEveryUpstreamLink: upstreamLinks.every((link) => link.at < styleIndex),
    upstreamLinkCount: upstreamLinks.length,
    bytes: document.slice(styleIndex, document.indexOf('</style>', styleIndex)).length,
    declaresInterFirst: /--dsw-font-family:\s*\n?\s*'Inter',/u.test(document),
    declaresMonoToken: /--dsw-font-mono:\s*'JetBrains Mono'/u.test(document),
  },
  fonts,
  bundles: Object.fromEntries(Object.entries(bundles).map(([name, source]) => [name, {
    bytes: source.length,
    // A dead token name or a literal fallback is what pinned the settings page to
    // one colour in all sixteen themes; both must be gone from what ships.
    deadTokens: referencedTokens(source).filter((token) => token === '--dsw-alias-border-secondary'
      || token === '--dsw-alias-bg-accent'),
    hexFallbacks: [...source.matchAll(/var\(\s*--dsw-[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]{3,8})/gu)]
      .map((match) => match[1]),
  }])),
  providerHostRow: {
    // The host half of the same package, which the profile must have mounted.
    mounted: ctx.loader.entries().some((entry) => entry.options?.id === 'qialike-providers'),
  },
})}\n`)

await running.shutdown.shutdown(0)
rmSync(home, { recursive: true, force: true })
process.exit(0)
