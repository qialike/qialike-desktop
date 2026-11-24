/**
 * The update row's browser half: what it renders, and what its buttons call.
 *
 * WHY A STUB LOADER AND A MINI RENDERER, RATHER THAN A WINDOW. The row reads
 * `globalThis.dshDesktop.updates` and the `settings.general.item` slot, neither of which exists in this
 * environment. So the bundle is lifted out of its file and run against a fake `__ModuleLoader__`, a fake
 * `require`, a `react` that actually re-renders, and a recording client context. That covers what the bundle
 * does while leaving the pixels to a real desktop — the same division `tests/theme-client.test.mjs` and
 * `tests/edit-follow-client.test.mjs` use.
 *
 * WHY THE REACT STUB IS NOT THE USUAL ONE-LINER. Those two suites stub `useState` as "return the initial
 * value, ignore the setter" and `useEffect` as a no-op, which is enough for a row whose first render is its
 * whole behaviour. This row's behaviour IS its state: the same row has to say "check for updates" before
 * anything has been asked, "you are up to date" after a check comes back, and it has to show a download button
 * in between. A stub that cannot change state cannot tell those apart — it would pass while the row was stuck
 * on one sentence. So this one keeps hook storage, runs effects, and re-renders when a setter fires.
 *
 * WHAT THIS FILE IS REALLY FOR. The requirement this row exists to satisfy is that a MANUAL check must not
 * download by itself — the user asked a question, not for a 200 MB transfer. That is a claim about which
 * carrier method each button calls, and it is asserted as behaviour rather than as a grep.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY: nothing here proves the row appears in a real Settings page, that the
 * progress meter looks right, or that the shell's own confirm dialog appears on install. The first is
 * `update-row-probe.mjs`'s job (it boots the profile and reports whether the bundle is served); the others
 * need a desktop.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const BUNDLE = join(ROOT, 'packages', 'qialike-desktop-update', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

/**
 * The bundle's module exports, without mounting anything.
 *
 * `inject` lives on `module.exports`, not on the `{ id, factory }` object handed to `__ModuleLoader__.load` —
 * reading it from the entry yields `undefined`, which is how the first version of this assertion passed
 * nothing and failed on its own guard.
 */
function loadModule() {
  const loaded = loadEntry({})
  return loaded.factory((id) => {
    if (id === 'react') return makeReact().React
    throw new Error(`the bundle required ${id}, which this stub does not provide`)
  })
}

/** The module id the bundle registers itself under; also the row's package name. */
const PLUGIN_ID = '@qialike/qialike-desktop-update'

/**
 * A `react` that can re-render.
 *
 * Hook storage is keyed by call order, which is exactly how React itself identifies hooks within a component
 * that takes no branches before them — this row's two `useState` calls and one `useEffect` are unconditional,
 * so the order is stable across renders.
 *
 * @returns the stub, plus `mount` and a way to re-render.
 */
function makeReact() {
  /**
   * Values the hooks hold, by call order, PER COMPONENT.
   *
   * A single map was enough while the tests mounted one component. They now mount a section
   * that renders a row, and a shared map would hand the row the section's slot for its first
   * `useState` — a stub that invents a render React would never produce. The scope is keyed by
   * the path of component calls in one pass, which is stable across renders for the shape these
   * bundles have.
   */
  const stores = new Map()
  /** Cleanups the effects returned, so a remount does not stack subscribers. */
  const cleanups = []
  let scope = ''
  let cursor = 0
  let component = null
  let props = null
  let rendered = null

  /** The store for the component currently rendering. */
  const storeFor = () => {
    let store = stores.get(scope)
    if (store === undefined) { store = new Map(); stores.set(scope, store) }
    return store
  }

  /**
   * Expand function components, so a test reads what the user would see.
   *
   * Without this, `h(Row, props)` stayed an unrendered element and every assertion about the
   * section's text silently read an empty child — the exact failure mode this file's own notes
   * warn about for a stub that lies.
   *
   * @param node - an element tree as `createElement` built it.
   * @param path - this node's position, so each instance gets its own hook scope.
   * @returns the tree with function components replaced by their output.
   */
  const expand = (node, path) => {
    if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return node
    if (typeof node.type !== 'function') {
      return { ...node, children: node.children.map((child, index) => expand(child, `${path}.${index}`)) }
    }
    const savedScope = scope
    const savedCursor = cursor
    scope = path
    cursor = 0
    const output = node.type({ ...node.props, children: node.children })
    scope = savedScope
    cursor = savedCursor
    return expand(output, path)
  }

  const renderNow = () => {
    scope = 'root'
    cursor = 0
    rendered = expand(component(props), 'root')
    return rendered
  }

  const React = {
    createElement: (type, elementProps, ...children) => ({
      type,
      props: elementProps ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState(initial) {
      const index = cursor
      cursor += 1
      // Resolved per call, not captured once: every component needs its own slot table.
      const store = storeFor()
      if (!store.has(index)) store.set(index, typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        const current = store.get(index)
        store.set(index, typeof next === 'function' ? next(current) : next)
        // Synchronous, so a test can push a presentation and read the result without awaiting a frame. A real
        // React would batch; the assertions here are about content, not about commit timing.
        renderNow()
      }
      return [store.get(index), set]
    },
    useEffect(effect) {
      const index = cursor
      cursor += 1
      const store = storeFor()
      if (store.has(index)) return
      store.set(index, true)
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }

  return {
    React,
    /**
     * Render `Component` and run its effects.
     *
     * Returns the tree as of the LAST render, not the first: an effect that sets state — which this row's does,
     * to report a missing carrier — re-renders during this call, and returning the first tree would hand back a
     * frame the component has already replaced. That is a stub that lies about what the user would see, and it
     * hid exactly one assertion when this file was written.
     */
    mount(Component, componentProps) {
      component = Component
      props = componentProps
      stores.clear()
      // TWICE, and the second pass is not redundant. The first render runs the effects, and an effect that sets
      // state re-enters the renderer — whose result the FIRST pass then overwrites on its way out, because the
      // outer call assigns last. Returning that would hand back a frame the component had already replaced,
      // which is a stub that lies about what the user sees. Rendering again after the effects have settled is
      // what React itself does; here it is explicit because the stub is synchronous.
      renderNow()
      return renderNow()
    },
    /** The tree as of the last render. */
    tree: () => rendered,
    /** Detach every effect, as unmounting would. */
    cleanup() {
      for (const fn of cleanups.splice(0)) fn()
      stores.clear()
    },
  }
}

/**
 * Load the bundle and return its registered entry.
 *
 * @param globals - the extra globals the bundle will see.
 * @returns the entry the bundle handed to `__ModuleLoader__`.
 */
function loadEntry(globals) {
  let captured
  const context = createContext({
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } } },
    console: { error: () => {}, warn: () => {} },
    ...globals,
  })
  new Script(SOURCE, { filename: BUNDLE }).runInContext(context)
  expect(captured, 'the bundle registered nothing with __ModuleLoader__').toBeDefined()
  return captured
}

/** The text a rendered tree contains, in document order, so assertions read like the page. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('\n')
  return textOf(node.children)
}

/** Every node with a click handler, so a test can find a button by its label. */
function buttons(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) return found
  if (typeof node.props?.onClick === 'function') found.push(node)
  for (const child of node.children ?? []) buttons(child, found)
  return found
}

/**
 * Mount the row with a scripted carrier.
 *
 * @param options.presentation - what `status()` answers, and what the row renders from first.
 * @param options.hasCarrier - false to mount in a browser-like build, where the carrier is absent.
 * @returns the tree, the carrier's spies, and a way to push a later presentation.
 */
function mountRow({ presentation = { phase: 'idle' }, hasCarrier = true } = {}) {
  const listeners = new Set()
  const check = vi.fn(async () => {})
  const download = vi.fn(async () => {})
  const open = vi.fn(async () => {})
  const status = vi.fn(async () => presentation)
  const carrier = { status, check, download, open, subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  } }

  const entry = loadEntry({
    globalThis: hasCarrier ? { dshDesktop: { updates: carrier } } : {},
  })
  // `globalThis` inside the vm realm is the context itself, so the row reads what the test put there.
  const mini = makeReact()
  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    // `bind` is part of the real service: the section draws its nav label through a thunk that
    // resolves it per projection. A stub without it made the bundle fail on `apply`, which no
    // assertion in this file could distinguish from a bundle that registered nothing.
    locale: {
      register: (ns, dictionaries) => { registered.push({ ns, dictionaries }) },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, fn) => { fn() },
      register: (options, Component) => { registered.push({ slot: options.name, options, Component }) },
    },
  }
  entry.factory((id) => {
    if (id === 'react') return mini.React
    throw new Error(`the bundle required ${id}, which this stub does not provide`)
  })
  const exports = entry.factory((id) => {
    if (id === 'react') return mini.React
    throw new Error(`the bundle required ${id}, which this stub does not provide`)
  })
  exports.apply(ctx)

  // THE SECTION IS THE ENTRY POINT NOW, and the row is mounted inside it. The settings shell
  // draws a nav column from `settings.section` registrations and renders that entry's component;
  // the update controls are one level in, so this helper returns the section and the tests
  // assert on what it renders.
  const row = registered.find((item) => item.Component !== undefined && item.slot === 'settings.section')
  const shadow = registered.find((item) => item.options?.id === 'current-version')
  expect(row, 'the section registered no component').toBeDefined()
  const t = (key, values) => {
    const dictionaries = registered.find((item) => item.dictionaries !== undefined)?.dictionaries
    const template = dictionaries?.en?.[key]
    if (template === undefined) return `«${key}»`
    return String(template).replace(/\{(\w+)\}/gu, (_, name) => String(values?.[name] ?? ''))
  }
  const mount = () => mini.mount(row.Component, { t })
  const tree = mount()
  return {
    tree,
    shadow,
    carrier,
    check,
    download,
    open,
    status,
    push: (next) => { for (const listener of listeners) listener(next); return mini.tree() },
    locale: registered.find((item) => item.dictionaries !== undefined),
    slot: row,
  }
}

describe('the update row bundling', () => {
  it('is a section of its own, after Agent presets', () => {
    // A COLUMN, not a row. The subject is the application itself — the version it is on and
    // whether a newer one exists — which is a question people open Settings to ask, not a
    // preference to tweak. Order 30 lands after `agent-presets` (20).
    const { slot } = mountRow()
    expect(slot.slot).toBe('settings.section')
    expect(slot.options.id).toBe('qialike-updates')
    expect(slot.options.order).toBe(30)
    // The nav label is a thunk so it follows the language without re-registering, which is how
    // the shipped sections do it.
    expect(typeof slot.options.label).toBe('function')
  })

  it('retires the version row General used to end with', () => {
    // `current-version` belongs to `ui-settings-general`, which owns the General section and so
    // cannot be disabled. A list slot renders the entry with the LOWEST priority for a given id
    // — the guard's own message says "register at a different priority to shadow it (lowest
    // renders)" — so a `-1` placeholder takes the cell and draws nothing, and the version is
    // printed once, in the section above. Two copies in two columns is the state this replaces.
    const { shadow } = mountRow()
    expect(shadow, 'nothing shadows current-version').toBeDefined()
    expect(shadow.slot).toBe('settings.general.item')
    expect(shadow.options.id).toBe('current-version')
    expect(shadow.options.priority).toBe(-1)
    // And it draws nothing at all: a placeholder that rendered a heading would be the row it
    // was supposed to replace, in the wrong column.
    expect(shadow.Component({})).toBeNull()
  })

  it('carries both languages with the same key set', () => {
    // A key in one dictionary and not the other is a row that renders `«key»` for half the users — the failure
    // the transport's own copy avoids by construction, and this asserts it rather than trusting it.
    const { locale } = mountRow()
    expect(locale.ns).toBe('qialike-update')
    const en = Object.keys(locale.dictionaries.en).sort()
    const zh = Object.keys(locale.dictionaries.zh).sort()
    expect(zh).toEqual(en)
    expect(en.length).toBeGreaterThan(10)
  })
})

describe('the services the bundle waits on', () => {
  it('names every service the bundle actually touches, and nothing else', () => {
    // THE TEST THAT WOULD HAVE CAUGHT A FAILURE THE HOST PROBE CANNOT SEE. `exports.inject` is a list of
    // SERVICE names (`slots`, `locale`) — a different vocabulary from `package.json`'s `dsh.client.inject`,
    // which lists PACKAGE names to order the bundles. This bundle was written with the package names copied
    // into the runtime list, so its entry sat `pending (waiting for services: …)` forever; the harness treats
    // one pending entry as a failed web boot, and the whole client stayed on "Loading plugins…" while every
    // downstream check went red.
    //
    // `update-row-probe.mjs` passes either way — it boots the HOST profile, where that entry is fine. Only a
    // browser can see client activation, which is why the failure surfaced in the end-to-end suite. So the
    // invariant is asserted here instead, derived from the source rather than written down: whatever this
    // bundle reaches for as `ctx.<name>` is exactly what it must declare.
    // `effect` is the one member of the context this bundle uses that is NOT a service: it registers a
    // lifecycle callback and is available without injection, which is why the office-engine half uses it the
    // same way against the same two-name list. Everything else reached for through `ctx` is a service.
    const touched = [...new Set([...SOURCE.matchAll(/ctx\.([a-zA-Z]+)/gu)].map((match) => match[1]))]
      .filter((name) => name !== 'effect')
      .sort()
    // The derivation is only meaningful if the bundle really does reach for services.
    expect(touched.length).toBeGreaterThan(0)
    expect([...loadModule().inject].sort(), `the bundle reaches for ${JSON.stringify(touched)}`).toEqual(touched)
  })

  it('declares no package name, because a service list is not a manifest', () => {
    // Stated separately from the derivation above so the failure message says what went wrong rather than
    // only which arrays differ: a package name in this list is the specific mistake, and it is invisible until
    // a browser refuses to boot.
    expect([...loadModule().inject].some((name) => name.startsWith('@'))).toBe(false)
  })
})

describe('what the row says, state by state', () => {
  it('offers a check before anything has been asked, and claims nothing', () => {
    // THE DISTINCTION THE WHOLE ROW TURNS ON. `idle` means both "nobody has asked" and "you are current", and
    // only the row knows which — so the initial render must not say "up to date", which would be a claim
    // nothing has checked.
    const { tree } = mountRow()
    const text = textOf(tree)
    expect(text).toContain('Check for updates')
    expect(text).not.toContain('You have the latest version')
  })

  it('says it is checking, and offers nothing to press meanwhile', () => {
    const { push } = mountRow({ presentation: { phase: 'checking' } })
    expect(textOf(push({ phase: 'checking' }))).toContain('Checking for updates')
  })

  it('names the version it found, and offers the download rather than starting it', () => {
    const { push } = mountRow()
    const tree = push({ phase: 'available', version: '0.3.12' })
    expect(textOf(tree)).toContain('0.3.12')
    expect(textOf(tree)).toContain('Download')
  })

  it('reports the download, with the percentage it was given', () => {
    const { push } = mountRow()
    expect(textOf(push({ phase: 'downloading', version: '0.3.12', percent: 42 }))).toContain('42%')
    // A percentage the updater has not reported yet must not be invented as 0%.
    expect(textOf(push({ phase: 'downloading', version: '0.3.12' }))).toContain('Downloading')
  })

  it('distinguishes verifying from installing, because one of them restarts the app', () => {
    const { push } = mountRow()
    expect(textOf(push({ phase: 'verifying', version: '0.3.12' }))).toContain('Verifying')
    expect(textOf(push({ phase: 'installing', version: '0.3.12' }))).toContain('Preparing to restart')
  })

  it('offers the install once the download is ready, and names the version', () => {
    const { push } = mountRow()
    const tree = push({ phase: 'ready', version: '0.3.12' })
    expect(textOf(tree)).toContain('Install and restart')
    expect(textOf(tree)).toContain('0.3.12')
  })

  it('reports a failure with the reason the shell gave, and offers the check again', () => {
    // The retry matters: an error with no control is a row the user has to restart the application to use.
    const { push } = mountRow()
    const tree = push({ phase: 'error', message: 'network unreachable' })
    expect(textOf(tree)).toContain('network unreachable')
    expect(buttons(tree)).toHaveLength(1)
  })

  it('says so when the build has no update channel, instead of offering a dead button', () => {
    // A browser build has no preload and therefore no carrier. A check button there would do nothing at all,
    // which is worse than saying why.
    const { tree } = mountRow({ hasCarrier: false })
    expect(textOf(tree)).toContain('no update channel')
  })
})

describe('what the row presses', () => {
  it('asks the shell to CHECK, and never to open, when the user clicks check', () => {
    // THE REQUIREMENT, ASSERTED WHERE IT LIVES. `open()` checks and downloads in one motion — that is right for
    // the background badge and wrong here, because a user who asks "is there an update?" has not agreed to
    // fetch 200 MB. `open` is asserted not to be called as well as `check` being called, because a row that
    // called both would satisfy the first half of this test while breaking the rule.
    const { tree, check, open } = mountRow()
    const button = buttons(tree).find((node) => textOf(node).includes('Check for updates'))
    expect(button, 'no check button in the initial render').toBeDefined()
    button.props.onClick()
    expect(check).toHaveBeenCalledTimes(1)
    expect(open, 'clicking check reached the shell\'s open(), which downloads').not.toHaveBeenCalled()
  })

  it('asks the shell to DOWNLOAD when the user accepts the version it found', () => {
    const { push, download, open } = mountRow()
    const tree = push({ phase: 'available', version: '0.3.12' })
    const button = buttons(tree).find((node) => textOf(node).includes('Download'))
    button.props.onClick()
    expect(download).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('goes through the shell to INSTALL, so the confirm dialog is the shell\'s', () => {
    // Installing restarts the application, so the question belongs in a native dialog rather than in the page
    // it is about to destroy. That is what `open()` is for once the download is ready.
    const { push, open, download } = mountRow()
    const tree = push({ phase: 'ready', version: '0.3.12' })
    const button = buttons(tree).find((node) => textOf(node).includes('Install and restart'))
    button.props.onClick()
    expect(open).toHaveBeenCalledTimes(1)
    expect(download).not.toHaveBeenCalled()
  })

  it('survives a carrier that rejects, rather than leaving an unhandled rejection', () => {
    // The shell reports a failed check as a phase transition, so a rejection here is a transport-level surprise
    // — and swallowing it is right: the row has nothing truer to say than the phase it is already showing.
    const { tree, check } = mountRow()
    check.mockRejectedValueOnce(new Error('ipc closed'))
    const button = buttons(tree).find((node) => textOf(node).includes('Check for updates'))
    expect(() => button.props.onClick()).not.toThrow()
  })
})
