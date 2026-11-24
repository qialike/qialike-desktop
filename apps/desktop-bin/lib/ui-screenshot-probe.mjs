/**
 * Capture the rendered interface as PNGs, because a person has to look at it.
 *
 * WHY THIS EXISTS. The environment this repository is developed in has no display
 * and no image tooling, so the agent developing it cannot see the window it is
 * changing. Everything else in `apps/desktop-bin/lib/` measures: geometry, colours,
 * type scale. Measurement can say a sidebar is 280px wide; it cannot say whether the
 * result looks right, and a design change judged without looking is a guess wearing
 * numbers.
 *
 * So this captures the states worth reviewing and leaves them as files. It walks the
 * interface the way a person would — click Settings, open the theme row, choose a
 * light scheme — because the interesting surfaces are behind those clicks, and a
 * screenshot of the first screen alone would show only the welcome page.
 *
 * The captures are written outside `dist/` on purpose: they are review artefacts, not
 * build output, and they should survive a rebuild.
 *
 * Usage: `node ui-screenshot-probe.mjs <appBinary|AppImage> [outDir]`
 *
 * @module qialike-desktop/ui-screenshot-probe
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, removeDir, sleep, stopApp } from './app-launch.mjs'

/**
 * A free TCP port, chosen by the OS.
 *
 * WHY NOT A CONSTANT. Every probe used to hardcode its DevTools port, and a probe
 * that leaked its application left that port held — so the *next* run's
 * `fetch('/json/list')` answered from the **stale instance**, and the measurements
 * silently described an application someone had already navigated. That is a
 * measurement corrupted by the thing it was measuring, with no error anywhere: the
 * second run reported a light theme, no welcome overlay and 89 KB frames, all of
 * which were true of the leaked window and false of a fresh launch.
 *
 * A port the OS hands out cannot be held by an older run, which removes the class.
 *
 * @returns a port number that was free a moment ago.
 */
async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}


const app = process.argv[2]
if (app === undefined) {
  console.error('usage: ui-screenshot-probe.mjs <appBinary|AppImage> [outDir]')
  process.exit(2)
}
const outDir = process.argv[3] ?? join(process.env.HOME ?? '/tmp', 'qialike', 'screens', 'ui-audit')

const port = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'qialike-shot-'))
const home = mkdtempSync(join(tmpdir(), 'qialike-shot-home-'))
const probeTmp = mkdtempSync(join(tmpdir(), 'qialike-shot-tmp-'))

let launched
let stopped = false

try {
  mkdirSync(outDir, { recursive: true })
  launched = launchApp({
    binary: app,
    args: [
      ...(app.endsWith('.AppImage') ? ['--appimage-extract-and-run'] : []),
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userData}`,
      '--no-sandbox', '--disable-gpu',
      '--window-size=1512,945',
    ],
    env: { DSH_HOME: home, QIALIKE_DESKTOP_USER_DATA_DIR: userData, TMPDIR: probeTmp },
  })

  const page = await (async () => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
        const found = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (found !== undefined) return found
      } catch { /* not up yet */ }
      await sleep(1000)
    }
    return undefined
  })()

  if (page === undefined) {
    console.log('NO_DEBUGGER_TARGET')
    console.log(launched.log().slice(-2000))
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
      return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
    }
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      // Surface the exception rather than returning undefined. A silent undefined
      // from an evaluated expression is indistinguishable from "the page has no such
      // thing", which is the wrong conclusion to draw from a syntax error.
      const thrown = result.result?.exceptionDetails
      if (thrown !== undefined) {
        throw new Error(`evaluate threw: ${thrown.exception?.description ?? thrown.text ?? 'unknown'}`)
      }
      return result.result?.result?.value
    }

    /** Capture one frame and write it, reporting what the caller should see. */
    const shoot = async (name) => {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const data = shot.result?.data
      if (data === undefined) {
        console.log(`  ${name.padEnd(28)} CAPTURE FAILED`)
        return undefined
      }
      const file = join(outDir, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      const size = Buffer.from(data, 'base64').length
      // Read the applied result, not just the attribute: whether a scheme's tokens
      // reach CSS variables and computed styles is the question a theme feature lives
      // or dies on, and it is answerable here rather than by eye.
      const state = await evaluate(`(() => {
        const bs = getComputedStyle(document.body)
        const label = [...document.querySelectorAll('div,span,p')]
          .find((el) => el.children.length === 0 && (el.textContent || '').trim().length > 3)
        return {
          body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60),
          dark: document.body.hasAttribute('data-ds-dark-theme'),
          bgBase: bs.getPropertyValue('--dsw-alias-bg-base').trim(),
          labelPrimary: bs.getPropertyValue('--dsw-alias-label-primary').trim(),
          brand: bs.getPropertyValue('--dsw-alias-brand-primary').trim(),
          bodyBg: bs.backgroundColor,
          textColor: label === undefined ? null : getComputedStyle(label).color,
          // The typeface facts, which are otherwise only visible by eye — and a font
          // that failed to load looks exactly like one that was never declared.
          // fonts.check is the strong one: it answers true only once the face is
          // loaded and parsed, so it distinguishes "the woff2 arrived" from "the
          // stylesheet named a family the browser does not have".
          fontFamily: bs.fontFamily,
          sansToken: bs.getPropertyValue('--dsw-font-family').trim().slice(0, 40),
          monoToken: bs.getPropertyValue('--dsw-font-mono').trim().slice(0, 40),
          interUsable: document.fonts.check('1em Inter'),
          monoUsable: document.fonts.check('1em "JetBrains Mono"'),
          faces: [...document.fonts].map((f) => f.family + '/' + f.status).filter((v) => /Inter|JetBrains/u.test(v)),
          // Which scheme the picker believes is selected, and where the override
          // variables actually landed. Without this, "the row is registered" and "the
          // scheme is applied" are indistinguishable from the outside.
          schemeSelect: (() => {
            const s = [...document.querySelectorAll('select')].find((el) =>
              [...el.options].some((o) => /dracula|gruvbox/i.test(o.value || '')))
            return s === undefined ? null : {
              value: s.value,
              options: s.options.length,
              // The values, because the builtin preferences and the shipped schemes
              // are different id spaces: a bare "light" is the harness's own theme and
              // "qialike-light" is ours, and only the picker knows the difference.
              // (No backticks in this comment: it lives inside a template literal.)
              values: [...s.options].map((o) => o.value).join(','),
            }
          })(),
          // Glyph coverage per face, because a font that loads but lacks a glyph
          // renders that letter as nothing — which reads as a text bug rather than a
          // font one, and is invisible to fonts.check.
          glyphs: (() => {
            const coverage = (family) => {
              const c = document.createElement('canvas')
              c.width = 64; c.height = 48
              const g = c.getContext('2d')
              g.font = '40px ' + family
              const out = {}
              for (const ch of 'saSe') {
                g.clearRect(0, 0, 64, 48)
                g.fillText(ch, 4, 38)
                const d = g.getImageData(0, 0, 64, 48).data
                let n = 0
                for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) n += 1 }
                out[ch] = n
              }
              return out
            }
            return { inter: coverage('Inter'), mono: coverage('"JetBrains Mono"'), fallback: coverage('sans-serif') }
          })(),
          htmlInlineVars: (document.documentElement.getAttribute('style') || '').slice(0, 90),
          bodyInlineVars: (document.body.getAttribute('style') || '').slice(0, 90),
        }
      })()`)
      console.log(
        `  ${name.padEnd(26)} ${String(Math.round(size / 1024)).padStart(4)} KB  dark=${String(state?.dark).padEnd(5)} `
        + `bg-base=${state?.bgBase} label=${state?.labelPrimary} brand=${state?.brand} computedBg=${state?.bodyBg}  ${file}`,
      )
      console.log(
        `    font: ${String(state?.fontFamily).slice(0, 60)}  inter=${String(state?.interUsable)} `
        + `mono=${String(state?.monoUsable)}  faces=${JSON.stringify(state?.faces)}`,
      )
      console.log(
        `    tokens: sans=${String(state?.sansToken)}  mono=${String(state?.monoToken)}`,
      )
      console.log(
        `    glyphs: ${JSON.stringify(state?.glyphs)}`,
      )
      console.log(
        `    scheme: select=${JSON.stringify(state?.schemeSelect)} html[style]=${JSON.stringify(state?.htmlInlineVars)} `
        + `body[style]=${JSON.stringify(state?.bodyInlineVars)}`,
      )
      return file
    }

    /**
     * The centre of the innermost element whose text matches, in viewport coordinates.
     *
     * INNERMOST IS THE LOAD-BEARING WORD. `querySelectorAll` returns document order, so
     * a wrapper `<div>` whose only content is a button's label matches the same text
     * and comes *first* — and clicking a wrapper does nothing, which presents as "the
     * click had no effect" rather than as "the wrong element was clicked". Candidates
     * are therefore ranked by area, and interactive roles win outright.
     */
    const findTarget = async (text, { exact }) => evaluate(`(() => {
      const wanted = ${JSON.stringify(text)}
      const matches = (value) => ${exact ? 'value === wanted' : "value.includes(wanted)"}
      const candidates = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"],div,span')]
        .filter((el) => matches((el.textContent || '').replace(/\\s+/g, ' ').trim()))
        .map((el) => {
          const r = el.getBoundingClientRect()
          const interactive = el.matches('button,a,[role="button"],[role="tab"],[role="menuitem"]')
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: Math.round(r.width * r.height), interactive, text: (el.textContent || '').trim().slice(0, 30) }
        })
        .filter((entry) => entry.area > 0)
      if (candidates.length === 0) return null
      candidates.sort((a, b) => (Number(b.interactive) - Number(a.interactive)) || (a.area - b.area))
      return candidates[0]
    })()`)

    /**
     * Click at a point with real input events.
     *
     * `element.click()` synthesises a DOM event, which React handles — but these
     * surfaces also act on pointer events, and a real press/release pair is what the
     * browser itself would deliver. It costs two messages and removes a class of
     * "the click did nothing" that is really "the component listened for something
     * else".
     */
    const clickAt = async (x, y) => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
      return true
    }

    /** The document's visible text, normalised: the cheapest "did anything change". */
    const textOf = async () => evaluate(
      `(document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400)`,
    )

    /**
     * Find a target by text and click it, reporting what was clicked and what changed.
     *
     * The reporting is the point. A click that found nothing and a click that found the
     * wrong element both present as "the screenshot did not change", and the two need
     * opposite fixes — so the coordinates, the element's own text and the before/after
     * text are all printed rather than inferred from an image.
     */
    const click = async (text, options = {}) => {
      const before = await textOf()
      const target = await findTarget(text, { exact: options.exact ?? true })
      if (target === null) {
        console.log(`    click ${JSON.stringify(text)}: NOT FOUND`)
        return false
      }
      await clickAt(target.x, target.y)
      await sleep(options.settle ?? 1800)
      const after = await textOf()
      const changed = before !== after
      console.log(
        `    click ${JSON.stringify(text)}: ${String(target.x)},${String(target.y)} `
        + `(${target.interactive ? 'interactive' : 'wrapper'}, "${target.text}") -> ${changed ? 'page changed' : 'NO CHANGE'}`,
      )
      return true
    }

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ready = await evaluate(
        `typeof globalThis.__DSH_BOOT__ !== 'undefined' && !/Loading plugins/i.test(document.body.innerText)`,
      )
      if (ready === true) break
      await sleep(1000)
    }
    await sleep(2500)

    // `--dump` answers "what is actually on screen", which is the question that comes
    // up whenever a capture shows no change: a click that found nothing looks exactly
    // like a click that changed nothing.
    if (process.argv.includes('--dump')) {
      const dump = await evaluate(`(() => {
        const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        const clickable = [...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"]')]
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: label(el), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          })
          .filter((e) => e.w > 0 && e.h > 0)
        return {
          clickable: clickable.slice(0, 45),
          hasSelect: document.querySelectorAll('select').length,
          hasThemeRow: /theme|appearance/i.test(document.body.innerText),
          inputs: [...document.querySelectorAll('input,select,textarea')].map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type, id: el.id, aria: el.getAttribute('aria-label') })),
          rootText: (document.body.innerText || '').replace(/\\n+/g, ' | ').slice(0, 600),
        }
      })()`)
      console.log(JSON.stringify(dump, null, 1))
      if (dump === undefined) console.log('(the dump expression returned nothing)')
    }

    console.log(`captures -> ${outDir}`)
    await shoot('01-welcome')

    // Two controls settle the question of whether input reaches the page at all: the
    // welcome overlay's dismiss button definitely changes the document, and the
    // sidebar's Settings entry is the surface being sought. Clicking the first before
    // the second means "no change" on the second is a fact about that control rather
    // than about the input path.
    if (await click('Skip for now', { exact: false, settle: 2500 })) {
      await shoot('02-after-dismiss')
    }
    if (await click('Settings')) {
      await sleep(2500)
      await shoot('02-settings')
      // Our theme row sits in the General section, which the settings surface opens
      // on by default; the Appearance row (upstream's light/dark/system) is there too,
      // so this frame shows both and makes their interaction visible.
      await sleep(500)
      await shoot('03-settings-general')
    } else {
      console.log('  (no Settings control found; only the welcome state was captured)')
    }

    // A SHIPPED scheme, chosen by its namespaced id rather than by matching text.
    //
    // The previous step searched for the first option matching /light/i and got the
    // harness's own bare `light` preference — which is a real theme, so the capture
    // looked correct while testing nothing this product contributed. The picker holds
    // two id spaces in one control (three builtin preferences with bare ids, fifteen
    // shipped schemes prefixed `qialike-`), and only an exact id reaches ours.
    //
    // Dracula because its palette is unmistakable: `#282a36`, which no harness theme
    // uses. A wrong selection cannot coincidentally produce it, which is what makes
    // this a measurement rather than an impression.
    const chooseScheme = async (id) => {
      const chosen = await evaluate(`(() => {
        const s = [...document.querySelectorAll('select')].find((el) =>
          [...el.options].some((o) => o.value === ${JSON.stringify(id)}))
        if (s === undefined) return null
        s.value = ${JSON.stringify(id)}
        s.dispatchEvent(new Event('change', { bubbles: true }))
        return s.value
      })()`)
      await sleep(1800)
      return chosen
    }

    // The providers settings page, whose styling is this repository's own. Read as
    // computed style rather than as source, because the question is whether the
    // tokens reach the rendered element: the page used to name two tokens the harness
    // does not define (`--dsw-alias-border-secondary`, `--dsw-alias-bg-accent`) and
    // carried hex fallbacks, so its borders were `#333` and its primary button
    // `#1f6feb` in every one of the sixteen themes. Only a rendered reading can say
    // that is no longer true.
    const dracula = await chooseScheme('qialike-dracula')
    console.log(`  scheme switch -> ${JSON.stringify(dracula)}`)
    await shoot('05-scheme-dracula')

    // And a light scheme, because a token that was never mapped shows up in one
    // scheme and hides in the other. `qialike-light` is Atom One Light, whose
    // background is `#fafafa` — distinct from the harness light's `#fff`, so the two
    // cannot be confused in the reading.
    const light = await chooseScheme('qialike-light')
    console.log(`  scheme switch -> ${JSON.stringify(light)}`)
    await shoot('06-scheme-qialike-light')

    // Back to the General section before measuring anything else: the providers page
    // replaces the panel that holds the theme row, so leaving it open made the scheme
    // step below find no `select` at all and silently capture the previous theme.
    // Reported rather than assumed — that failure printed `scheme switch -> null`.
    if (await click('General', { exact: false, settle: 2500 })) {
      if (await click('Providers', { exact: false, settle: 2500 })) {
      // LOCATOR-INDEPENDENT, deliberately. Two earlier versions of this step tried to
      // scope to the page and measured the sidebar instead — the settings surface is
      // nested inside the frame that holds the sidebar, so a container query finds
      // the sidebar first and reports its colours as if they were the page's.
      //
      // The question does not need a locator: the defect was that this page pinned
      // itself to a fixed set of literal colours in every theme, so the check is
      // whether those literals appear ANYWHERE in the rendered document. Their
      // absence is the assertion; the theme's own value being present is the control.
      const providers = await evaluate(`(() => {
        // The literals the page used to fall back to, as the browser reports them.
        const stale = {
          '#333': 'rgb(51, 51, 51)',
          '#1f6feb': 'rgb(31, 111, 235)',
          '#d1242f': 'rgb(209, 36, 47)',
          '#2ea043': 'rgb(46, 160, 67)',
          '#888': 'rgb(136, 136, 136)',
          '#1b1c20': 'rgb(27, 28, 32)',
        }
        const found = {}
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el)
          for (const [name, value] of Object.entries(stale)) {
            if (cs.color === value) (found[name] ??= []).push('color')
            if (cs.backgroundColor === value) (found[name] ??= []).push('background')
            if (cs.borderTopColor === value) (found[name] ??= []).push('border')
          }
        }
        // The token the page's borders should now come from, and what one such border
        // actually resolves to, so "no literals" cannot pass by the page being absent.
        const body = getComputedStyle(document.body)
        const borderToken = body.getPropertyValue('--dsw-alias-border-l2').trim()
        const pageHasContent = /provider/i.test(document.body.innerText || '')
        const probe = document.createElement('div')
        probe.style.borderTopColor = borderToken
        return {
          staleLiterals: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])),
          borderToken,
          pageHasContent,
          sectionCount: document.querySelectorAll('section, [role="region"]').length,
        }
      })()`)
      console.log(`    providers: stale-literal hits=${JSON.stringify(providers?.staleLiterals)} `
        + `border-token=${providers?.borderToken} page-has-content=${String(providers?.pageHasContent)}`)
      await shoot('04-providers')
    } else {
      console.log('  (no Providers section found in the settings nav)')
    }

    }
  }
} finally {
  if (launched !== undefined) stopped = await stopApp(launched.child)
  if (!stopped) {
    console.error('qialike-desktop: the application did not stop; leaving its directories in place')
    // Non-zero, so a caller that pipes the output somewhere cannot lose the fact.
    // The run that leaked the window this comment was written for printed its
    // warning to a stream that was being cut off by `tail`.
    process.exitCode = 1
  } else {
    removeDir(userData); removeDir(home); removeDir(probeTmp)
  }
}
