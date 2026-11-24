/**
 * Launch a packaged artifact and report what its window actually contains.
 *
 * The only check that answers "does the product run" rather than "is the product
 * assembled". Everything else in this repository inspects files; this one starts
 * the application, attaches to its renderer over the DevTools protocol, and reads
 * the live document — which is how three separate defects were found that no test
 * could see: a boot chain that never executed its injected rows, a shell import the
 * runtime tree could not resolve, and a window title the client overwrote after
 * mount.
 *
 * It needs a display and it needs to run outside a restrictive sandbox (Chromium's
 * own sandbox needs `/tmp/.X11-unix`, which is not always visible), so it is a probe
 * rather than a test: run it by hand, or in a job that has a display.
 *
 * THE APPLICATION IS STOPPED BY PROCESS GROUP, and nothing is deleted until it is
 * confirmed gone. Both are load-bearing: an AppImage's runtime re-launches the
 * payload, so the process this script holds is a launcher rather than the
 * application, and an earlier version of this file left a window on someone's
 * desktop — showing an error, because its user-data directory had been removed
 * while it was still running. See `app-launch.mjs`.
 *
 * Usage: `node packaged-app-probe.mjs <appBinary|AppImage>`
 *
 * @module qialike-desktop/packaged-app-probe
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './app-launch.mjs'

const app = process.argv[2]
if (app === undefined) {
  console.error('usage: packaged-app-probe.mjs <appBinary|AppImage>')
  process.exit(2)
}

const port = 19222
const userData = mkdtempSync(join(tmpdir(), 'qialike-verify-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-home-'))

// The AppImage runtime extracts the payload into `$TMPDIR` (or `/tmp`) and only
// removes it when it exits cleanly — which, when it is signalled, it does not. Giving
// the child its own `TMPDIR` means the extraction directory can be removed by exact
// path afterwards, instead of globbing `/tmp` for something that looks like ours.
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-probe-tmp-'))

// Set up before anything can fail, so `finally` below has a complete picture.
let launched
let stopConfirmed = false

try {
  launched = launchApp({
    binary: app,
    args: [
      // An AppImage needs FUSE, which not every container has; the runtime's
      // extract-and-run mode needs no mount, and sets `APPIMAGE` the same way a
      // normal launch does.
      ...(app.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox', '--disable-gpu',
    ],
    env: { DSH_HOME: home, QIALIKE_DESKTOP_USER_DATA_DIR: userData, TMPDIR: probeTmp },
  })

  /** Wait for the page target, then attach. */
  async function target() {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
        const page = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (page !== undefined) return page
      } catch { /* not up yet */ }
      await sleep(1000)
    }
    return undefined
  }

  const page = await target()
  if (page === undefined) {
    console.log('NO_DEBUGGER_TARGET')
    console.log(launched.log().slice(-2500))
    process.exitCode = 1
  } else {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let nextId = 0
    const pending = new Map()
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
    const send = (method, params) => {
      const id = ++nextId
      return new Promise((resolve) => {
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      return result.result?.result?.value
    }

    // Wait for the client to actually mount.
    //
    // `rootChildren > 0` is NOT the signal: the boot page is itself a child of
    // `#root`, so that condition holds before anything has loaded. The two facts
    // that mean the application is up are that the Host's rows were applied
    // (`__DSH_BOOT__` exists) and that the boot page's own copy is gone.
    let snapshot
    for (let attempt = 0; attempt < 120; attempt += 1) {
      snapshot = await evaluate(`({
        title: document.title,
        href: location.href,
        rootChildren: (document.getElementById('root')||{}).childElementCount ?? -1,
        bodyText: (document.body.innerText || '').slice(0, 300),
        hasGate: typeof globalThis.__DSH_BOOT_READY__ !== 'undefined',
        hasBoot: typeof globalThis.__DSH_BOOT__ !== 'undefined',
        bootEntries: (globalThis.__DSH_BOOT__ && globalThis.__DSH_BOOT__.entries || []).length,
        moduleLoader: typeof globalThis.__ModuleLoader__ !== 'undefined' ? globalThis.__ModuleLoader__.mode : null,
        loaded: (globalThis.__ModuleLoader__ && globalThis.__ModuleLoader__.loaded || []).length,
      })`)
      if (snapshot?.hasBoot === true && !/Loading plugins/iu.test(snapshot.bodyText)) break
      await sleep(1000)
    }

    const mounted = snapshot?.hasBoot === true && !/Loading plugins/iu.test(snapshot.bodyText)
    console.log(`SNAPSHOT ${JSON.stringify(snapshot)}`)
    console.log(`--- 已挂载: ${String(mounted)}`)
    console.log('--- stderr/stdout 尾部 ---')
    console.log(launched.log().split('\n').filter((line) => line.trim()).slice(-12).join('\n'))
    process.exitCode = mounted ? 0 : 1
  }
} finally {
  // Ordered, and every step guarded: stop the application, confirm it is gone, and
  // only then delete the directories it was using. Deleting first is what produced
  // the error dialog this file's header describes.
  if (launched !== undefined) stopConfirmed = await stopApp(launched.child)
  if (!stopConfirmed) {
    // Left running on purpose, with its files intact. Deleting them would turn a
    // stray window into a stray window showing a failure.
    console.error('qialike-desktop: the application did not stop; leaving its directories in place')
  } else {
    removeDir(userData)
    removeDir(home)
    removeDir(probeTmp)
  }
}
