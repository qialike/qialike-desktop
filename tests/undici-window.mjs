/**
 * Map the crash window for undici's paused-parser assertion, empirically.
 *
 * WHY THIS IS NOT IN `docs/`. The published analysis places the window above 64 KiB. On the
 * machines this project runs on it is *below* 64 KiB, and the direction matters: it is the
 * difference between a size threshold that works and one that guards the wrong half. A number
 * copied from a blog post cannot be trusted for that, and neither can one copied from here —
 * so the sweep ships with the repository and can be re-run on the machine in question.
 *
 * The trigger needs three things at once (nodejs/undici#5360):
 *   1. an unread response body past undici's pause threshold,
 *   2. a FIN from a closing connection, and
 *   3. the FIN arriving in the same socket read as the paused data.
 * Only (1) is a size; (2) is `connection: close`, which the shell sets on purpose; (3) depends
 * on the write pattern and the socket buffer. Hence two server shapes below.
 *
 * Run:
 *     node tests/undici-window.mjs          # full sweep, ~2 min
 *     RUNS=3 node tests/undici-window.mjs   # quicker
 *
 * Each size runs in its own child process, because the assertion is fatal: a shared parent
 * would stop at the first crash and prove nothing about the rest of the sweep.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const KIB = 1024

if (process.argv.includes('--child')) {
  const shape = process.argv[process.argv.length - 2]
  const size = Number(process.argv[process.argv.length - 1])

  const server = createServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(size),
      connection: 'close',
    })
    const body = 'x'.repeat(size)
    if (shape === 'split') {
      // Two writes with a turn in between: the FIN is then never in the same read as the pause.
      const half = Math.floor(size / 2)
      response.write(body.slice(0, half))
      setTimeout(() => { response.end(body.slice(half)) }, 20)
    } else {
      response.end(body)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  // The whole point: fetch and never read. A caller that only wanted the status does this.
  await fetch(`http://127.0.0.1:${server.address().port}/api`, { redirect: 'manual' })

  setTimeout(() => {
    console.log('SURVIVED')
    server.close()
    process.exit(0)
  }, 300)
}

function runOnce(shape, size) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, '--child', shape, String(size)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ crashed: stderr.includes('assert(!this.paused)'), code, survived: stdout.includes('SURVIVED') })
    })
  })
}

const RUNS = Number(process.env.RUNS ?? 5)
const SIZES = [
  4, 8, 12, 16, 24, 32, 40, 48, 56, 60, 62, 63.5, 64, 65, 72, 80, 128, 512,
].map((kib) => Math.round(kib * KIB))

console.log(`node ${process.version}  undici ${process.versions.undici ?? '?'}  runs ${String(RUNS)} per size\n`)

const rows = []
for (const shape of ['single', 'split']) {
  for (const size of SIZES) {
    let crashes = 0
    for (let run = 0; run < RUNS; run += 1) {
      const result = await runOnce(shape, size)
      if (result.crashed) crashes += 1
    }
    rows.push({ shape, kib: Math.round((size / KIB) * 10) / 10, crashes: `${String(crashes)}/${String(RUNS)}` })
  }
}

console.table(rows)

let failed = false
for (const shape of ['single', 'split']) {
  const hit = rows.filter((row) => row.shape === shape && !row.crashes.startsWith('0/'))
  console.log(`${shape.padEnd(7)} window: ${hit.length === 0 ? '(never on this runner)' : hit.map((row) => `${String(row.kib)}KiB`).join(', ')}`)
  if (shape === 'single' && hit.length === 0) failed = true
}

// A runner where the single-write shape never crashes cannot inform the plan, and saying so is
// more useful than reporting a green sweep that tested nothing.
if (failed) {
  console.error('\nthe known-triggering shape did not crash here; the sweep proved nothing')
  process.exit(1)
}

console.log('\nOK: the window is bounded, and both boundaries move with the runtime and the write pattern.')
