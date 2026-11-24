/**
 * Reproduce the undici paused-parser assertion and show that the shell's crash guard absorbs it.
 *
 * WHY THIS IS NOT A VITEST TEST. It has to crash a *real* Electron main process: the assertion
 * is thrown from a socket `end` handler inside Node's bundled undici, which is why the comment
 * on issue #5360 calls it uncatchable. A jsdom or plain-node fixture proves nothing about the
 * thing being fixed, and the failure mode this guards against - the dialog coming back - only
 * exists in a process Electron bootstrapped.
 *
 * WHAT IT ACTUALLY PROVES, in order:
 *   1. Electron's own `uncaughtException` handler is present, unmodified (LISTENERS 1).
 *   2. An unread 64 KiB response on a closing connection reproduces the assertion.
 *   3. Without the guard, that becomes `A JavaScript error occurred in the main process`.
 *   4. With the guard, the count goes to 2 and no dialog is shown.
 *   5. The guard's log names the failure, the runtime, and what it means.
 *
 * HOW TO RUN (an Electron binary is required; the packaged app's own copy works):
 *
 *     $env:ELECTRON_RUN_AS_NODE = $null
 *     node run-probe.mjs
 *
 * The reproduction is sensitive to size, and that is a property of the bug rather than of this
 * script: below roughly 64 KiB the parser never pauses, and far above it the FIN waits in the
 * kernel behind unread data. The sweep in `SIZES` exists because the first attempt - a single
 * 80 KiB request - did *not* crash, which is exactly the false negative the upstream reports
 * describe.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Where the Electron binary is, in the order it is most likely to be found. */
const ELECTRON_CANDIDATES = [
  process.env.QIALIKE_ELECTRON,
  join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(process.cwd(), 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe'),
  join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron'),
].filter((value) => typeof value === 'string' && value !== '')

function findElectron() {
  for (const candidate of ELECTRON_CANDIDATES) {
    try {
      require('node:fs').accessSync(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/** The Electron side of the probe. Written to a scratch directory at run time. */
const MAIN = String.raw`
const { app, dialog } = require('electron')
const http = require('node:http')
const fs = require('node:fs')

const OUT = process.env.PROBE_OUT
const note = (line) => fs.appendFileSync(OUT, line + '\n')

// Electron's handler resolves 'electron' from the same module object, so this replacement is
// what a real showErrorBox would be. Exit code 9 marks "a dialog appeared".
dialog.showErrorBox = (title) => { note('DIALOG ' + title); app.exit(9) }

if (process.env.PROBE_GUARD === '1') {
  const guard = require(process.env.PROBE_GUARD_MODULE)
  guard.installMainProcessGuard({ logPath: process.env.PROBE_LOG })
  note('GUARD_INSTALLED')
}
note('LISTENERS ' + process.listeners('uncaughtException').length)
note('VERSIONS ' + JSON.stringify({
  electron: process.versions.electron, node: process.versions.node, undici: process.versions.undici,
}))

const SIZES = (process.env.PROBE_SIZES || '64000').split(',').map(Number).filter(Number.isFinite)

app.whenReady().then(async () => {
  let size = 0
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(size),
      // The half of the trigger the shell supplies: it sends this header itself.
      connection: 'close',
    })
    response.end('x'.repeat(size))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  for (size of SIZES) {
    note('TRY ' + size)
    try {
      // The other half: the body is never read, so undici pauses the parser at 64 KiB.
      await fetch('http://127.0.0.1:' + server.address().port + '/abandoned')
      note('OK ' + size)
    } catch (error) {
      note('THREW ' + size + ' ' + (error && error.message))
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  note('SURVIVED_ALL')
  server.close()
  app.exit(0)
})
`

/** One probe run; returns what the probe observed. */
function runCase(electron, { guard, guardModule, sizes }) {
  const scratch = mkdtempSync(join(tmpdir(), 'qialike-probe-'))
  const appDir = join(scratch, 'app')
  const out = join(scratch, 'verdict.txt')
  const log = join(scratch, 'guard.log')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'main.js'), MAIN)
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'probe', version: '0.0.0', main: 'main.js' }))

  return new Promise((resolve) => {
    // Electron must run as Electron: with this set it behaves like plain node and never installs
    // the handler this probe is about. It is in the ambient environment on some machines.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    Object.assign(env, {
      PROBE_OUT: out,
      PROBE_LOG: log,
      PROBE_GUARD: guard ? '1' : '0',
      PROBE_GUARD_MODULE: guardModule ?? '',
      PROBE_SIZES: sizes,
    })

    const child = spawn(electron, [appDir], { env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const read = (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return ''
        }
      }
      const verdict = read(out)
      resolve({
        exitCode: code,
        verdict,
        log: read(log),
        dialogs: verdict.split('\n').filter((line) => line.startsWith('DIALOG ')).length,
        survived: verdict.includes('SURVIVED_ALL'),
        listeners: Number((/^LISTENERS (\d+)$/mu.exec(verdict) ?? [])[1] ?? Number.NaN),
      })
    })
  })
}

const electron = findElectron()
if (electron === undefined) {
  console.log('SKIP: no Electron binary (set QIALIKE_ELECTRON to one)')
  process.exit(0)
}

const guardModule = join(import.meta.dirname, '..', 'apps', 'desktop', 'lib', 'main-crash-guard.js')
const sizes = process.env.PROBE_SIZES ?? '64000,65536,70000,80000,100000,131072'

console.log(`electron ${electron}`)
console.log(`sizes    ${sizes}\n`)

const without = await runCase(electron, { guard: false, sizes })
console.log('without the guard:')
console.log(`  listeners ${without.listeners}`)
console.log(`  dialogs   ${without.dialogs}`)
console.log(`  survived  ${without.survived}`)

const withGuard = await runCase(electron, { guard: true, guardModule, sizes })
console.log('with the guard:')
console.log(`  listeners ${withGuard.listeners}`)
console.log(`  dialogs   ${withGuard.dialogs}`)
console.log(`  survived  ${withGuard.survived}`)
console.log('  log first line: ' + (withGuard.log.split('\n')[0] ?? '(none)'))

const checks = [
  ['Electron starts with exactly one listener of its own', without.listeners === 1],
  ['the unread body reproduces the assertion (a dialog would have appeared)', without.dialogs === 1],
  ['the guard makes it two', withGuard.listeners === 2],
  ['no dialog with the guard installed', withGuard.dialogs === 0],
  ['the process keeps running past every size', withGuard.survived],
  ['the failure is logged and classified', withGuard.log.includes('undici-paused-parser')],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}

process.exit(failed === 0 ? 0 : 1)
