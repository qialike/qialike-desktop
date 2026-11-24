/**
 * The policy and filesystem-tool surface the composed profile actually mounts.
 *
 * WHAT THIS ANSWERS THAT READING THE PATCH CANNOT. The bundle patch says which
 * rows the profile *asks* for; this says what those rows *registered*. The gap
 * between the two is where M5's defects lived: `delete`/`move` were never asked
 * for, and the read policy was never registered, and neither showed up as a build
 * failure — the profile booted cleanly with both absent.
 *
 * TWO PLANES ARE INVOLVED, and the probe has to respect the difference. The web
 * surface moves the agent plane behind per-session presets, so `read`/`write`/
 * `bash` and their siblings are registered into a *preset's* layer and are
 * invisible to a global `tools.get`. The read guard is registered into the
 * **global** layer, which every agent's scope chain merges — so it is visible from
 * here, and its decisions are what this probe asks for.
 *
 * The decisions are read through the real `tools/pre-execute` waterfall rather
 * than by calling the policy functions, because the question is whether the
 * *listener is mounted*, not whether the functions work. `reachedNext` is the
 * load-bearing field: a case that falls through to `next()` had no listener to
 * decide it.
 *
 * Usage: `node policy-probe.mjs <runtimeDir>`
 *
 * @module qialike-desktop/policy-probe
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const runtimeDir = process.argv[2]
if (runtimeDir === undefined) {
  console.error('usage: policy-probe.mjs <runtimeDir>')
  process.exit(2)
}

// A throwaway home: the developer's own profile must not decide the answer, and
// the credential path the guard names has to be this home's own document.
const home = mkdtempSync(join(tmpdir(), 'qialike-policy-'))
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
const tools = ctx.get('tools')

/**
 * The read cases, with the argument key each tool actually declares.
 *
 * The keys are not interchangeable and the difference is the guard's own design:
 * `read` takes `file_path`, `glob`'s `pattern` IS a path glob, and `grep`'s
 * `pattern` is a REGEX — only its `path` names a file, so a grep for the literal
 * text `.env` must stay allowed. A probe that passed `pattern` to `grep` would
 * assert the opposite of the shipped rule.
 */
const CASES = [
  { id: 'read-credentials', tool: 'read', args: { file_path: join(home, '.credentials.yaml') } },
  { id: 'read-env', tool: 'read', args: { file_path: join(home, 'project', '.env') } },
  { id: 'read-env-local', tool: 'read', args: { file_path: join(home, 'project', '.env.local') } },
  { id: 'read-env-example', tool: 'read', args: { file_path: join(home, 'project', '.env.example') } },
  { id: 'read-git-internals', tool: 'read', args: { file_path: join(home, 'project', '.git', 'config') } },
  { id: 'read-ordinary', tool: 'read', args: { file_path: join(home, 'project', 'src', 'index.ts') } },
  { id: 'read-image-env', tool: 'read_image', args: { file_path: join(home, 'project', '.env') } },
  { id: 'glob-env', tool: 'glob', args: { pattern: '**/.env*', path: home } },
  { id: 'glob-ordinary', tool: 'glob', args: { pattern: '**/*.ts', path: home } },
  { id: 'grep-env-path', tool: 'grep', args: { pattern: 'KEY', path: join(home, 'project', '.env') } },
  // The deliberate gap: grep's `pattern` is a search string, not a path, so a
  // search FOR the text ".env" is ordinary and must not be denied.
  { id: 'grep-env-as-pattern', tool: 'grep', args: { pattern: '.env', path: join(home, 'project') } },
]

/** One case's decision, taken through the mounted waterfall. */
async function decide(tool, args) {
  const exec = { name: tool, arguments: args, callId: 'probe', signal: new AbortController().signal }
  let reachedNext = false
  try {
    const decision = await ctx.waterfall('tools/pre-execute', exec, async () => {
      reachedNext = true
      return { kind: 'allow' }
    })
    return { kind: decision?.kind ?? null, reason: decision?.reason ?? null, reachedNext }
  } catch (error) {
    return { kind: 'threw', reason: error instanceof Error ? error.message : String(error), reachedNext }
  }
}

const decisions = {}
for (const testCase of CASES) {
  decisions[testCase.id] = await decide(testCase.tool, testCase.args)
}

// Presence is asked per name rather than enumerated: the registry has no public
// enumerator (`view` is private), and `get` is the documented accessor. Names from
// both planes are included so the report shows which plane each one landed in.
const NAMES = ['delete', 'move', 'read', 'write', 'edit', 'bash', 'glob', 'grep']
const registered = {}
for (const name of NAMES) {
  try {
    registered[name] = tools?.get(name) === undefined ? 'absent' : 'present'
  } catch (error) {
    registered[name] = `threw: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * §7.5's second claim: the base's sandbox and policy rows are *retained*.
 *
 * Read from the Loader rather than from any patch file, because the claim is about
 * what the composed profile ended up with — and the failure it guards against is a
 * later patch disabling one of these silently. The composed profile boots and
 * serves perfectly well with the sandbox gone, which is exactly why this needs an
 * assertion rather than a reading of the YAML.
 */
const RETAINED = [
  'sandbox', 'sandbox-policy', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox',
  'approval', 'permission', 'fs-observation-policy',
]
const rows = {}
for (const entry of ctx.loader.entries()) {
  const id = entry.options?.id
  if (id === undefined || !RETAINED.includes(id)) continue
  let disabled = false
  try {
    disabled = entry.disabled === true
  } catch { /* a throwing disabled expression counts as unusable, not as retained */ disabled = 'threw' }
  // The resolved config, which is what the profile actually runs with after every
  // patch has been applied. `approval`'s `policy` is the documented product promise
  // ("默认 ask") and is only visible here.
  const config = entry.options?.config
  rows[id] = {
    present: true,
    disabled,
    name: entry.options?.name ?? null,
    config: config === undefined || config === null
      ? null
      : Object.fromEntries(Object.entries(config).map(([key, value]) => [key, typeof value === 'object' ? '<object>' : value])),
  }
}
for (const id of RETAINED) rows[id] ??= { present: false }

process.stdout.write(`__REPORT__${JSON.stringify({
  registered,
  decisions,
  rows,
  sandbox: {
    defaultMode: ctx.get('sandboxPolicy')?.defaultMode ?? null,
    // The capability fact the shell fences are derived from: `undefined` means the
    // mounted executor applies no kernel confinement.
    shellSandboxMode: ctx.get('shell')?.sandboxMode ?? null,
    approvalPolicy: ctx.get('approval')?.policy ?? null,
  },
})}\n`)

await running.shutdown.shutdown(0)
rmSync(home, { recursive: true, force: true })
process.exit(0)
