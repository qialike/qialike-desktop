/**
 * The theme bundle's browser half, executed against a stub loader.
 *
 * WHY A STUB AND NOT A WINDOW. `ctx.theme` and the `settings.general.item` slot
 * exist only in a browser, and this environment cannot render one — so the bundle is
 * lifted out of its file and run against a fake `__ModuleLoader__`, a fake `require`,
 * a minimal React and a recording client context. That covers what the bundle
 * *does* — which themes it registers, what it does with the stored preference, where
 * it registers the row — while leaving the pixels to a real desktop. The same
 * division `tests/shell-boot-bootstrap.test.mjs` uses for the shell's injected
 * script, and for the same reason.
 *
 * THE CONTRACT THIS PINS. The Host computes each scheme's registry id; the bundle
 * must register *that* id and never derive one from the scheme name. Deriving would
 * mean a second copy of the namespacing rule in the half that cannot be unit-tested
 * for it — and the rule exists because the CLI ships a scheme called `light` while
 * the harness already has a theme by that id, so getting it wrong throws inside
 * `register()` and takes the whole row down. Asserting it behaviourally (an id that
 * does not follow the rule must still be registered verbatim) is stronger than
 * grepping for a prefix literal, which `qialike-theme` would match anyway.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY: nothing here proves the themes *look* right.
 * That the tokens reach CSS variables, that `colorScheme` moves
 * `body[data-ds-dark-theme]`, and that a scheme is legible are facts about a rendered
 * window.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { THEME_ID_PREFIX, themeIdFor, toThemeDefinition } from '../packages/qialike-desktop-theme/lib/tokens.js'

const BUNDLE = join(ROOT, 'packages', 'qialike-desktop-theme', 'lib', 'client.js')
const SOURCE = readFileSync(BUNDLE, 'utf8')

/** The module id the bundle registers itself under; also the row's package name. */
const PLUGIN_ID = '@qialike/qialike-desktop-theme'

/**
 * A React that is enough for a component function to be *called*.
 *
 * `useState` returns the initial value and a setter that does nothing, `useEffect`
 * runs nothing, and `createElement` builds a plain object tree. That is deliberately
 * not a renderer: the assertions are about what the bundle registers and asks for,
 * and a real render would add a dependency this repository does not carry.
 */
const React = {
  /**
   * Flatten the child list, as React does with arrays.
   *
   * Not a detail to skip: the row passes an *array* of `<optgroup>`s as a single
   * child, and a fake that kept it nested would hide every option from the helpers
   * below — making the picker look empty and the test wrong about it.
   */
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/**
 * Load the bundle and return its registered factory.
 *
 * `fetch` is injected into the vm realm rather than swapped on the host's
 * `globalThis`: the bundle executes inside its own context and resolves `fetch`
 * there, so replacing the host's would leave the bundle calling the real one — which
 * would make every registration assertion below fail for a reason that has nothing to
 * do with the code under test.
 *
 * @param fetchImpl - the fake fetch the bundle will see.
 * @returns the factory the bundle handed to `__ModuleLoader__`.
 */
function loadFactory(fetchImpl, documentStub) {
  let captured
  /** The observer the bundle constructs, so a test can assert it is disconnected. */
  const observers = []
  const context = createContext({
    // The bundle is a plain script that announces itself to the loader; there is no
    // `import`, which is why `vm.Script` can run it as-is.
    console: { error: () => {}, warn: () => {} },
    fetch: fetchImpl,
    // The bundle appends one `<style>` for the scheme photograph, so it needs a
    // document. A real one is not available here; see `makeDocument`.
    document: documentStub ?? makeDocument(),
    // The bundle keeps the scan fresh across viewport changes, so the columns' share of
    // the frame is re-measured when the window is resized.
    window: {
      __ModuleLoader__: { load: (entry) => { captured = entry } },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    // The bundle marks surfaces through a MutationObserver, and measures fills with
    // getComputedStyle. Both are browser globals the vm realm does not carry.
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(target, options) { this.observing = true; this.options = options }
      disconnect() { this.observing = false; this.disconnected = true }
    },
    getComputedStyle: (element) => element.__computed ?? { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  })
  new Script(SOURCE, { filename: BUNDLE }).runInContext(context)
  expect(captured?.id, 'the bundle did not register itself').toBe(PLUGIN_ID)
  return { factory: captured.factory, observers }
}

/**
 * The smallest document that satisfies what the bundle touches: it creates one
 * `<style>` element and appends it to `head`.
 *
 * Recording rather than rendering, for the same reason the rest of this file stubs
 * React: the assertion is about *what the bundle asks for*, not about layout.
 *
 * @returns the stub, with the appended elements and the removed ones.
 */
function makeDocument() {
  const appended = []
  const removed = []
  const makeElement = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      textContent: '',
      remove: () => { removed.push(node) },
    }
    return node
  }
  // `body.style`, because the bundle writes the photograph variable there directly.
  const properties = new Map()
  const attributes = new Set()
  const body = {
    style: {
      setProperty: (name, value) => { properties.set(name, value) },
      removeProperty: (name) => { properties.delete(name) },
      getPropertyValue: (name) => properties.get(name) ?? '',
    },
    setAttribute: (name) => { attributes.add(name) },
    removeAttribute: (name) => { attributes.delete(name) },
    hasAttribute: (name) => attributes.has(name),
  }
  const frame = {
    __computed: { backgroundColor: 'rgb(21, 21, 23)', backgroundImage: 'none' },
    getBoundingClientRect: () => ({ width: 1280, height: 800, top: 0, left: 0 }),
    querySelectorAll: () => surfaces,
    setAttribute: (name) => { frameAttributes.add(name) },
    removeAttribute: (name) => { frameAttributes.delete(name) },
    hasAttribute: (name) => frameAttributes.has(name),
  }
  const surfaces = []
  const frameAttributes = new Set()

  // `html`, for the native-chrome attribute the row keeps in step.
  const rootAttributes = new Map()
  const documentElement = {
    setAttribute: (name, value) => { rootAttributes.set(name, value) },
    getAttribute: (name) => rootAttributes.get(name) ?? null,
    removeAttribute: (name) => { rootAttributes.delete(name) },
  }
  return {
    createElement: makeElement,
    head: { append: (...children) => { appended.push(...children) } },
    documentElement,
    body,
    // The scan asks for the frame by selector; `surfaces` is what it then walks.
    querySelector: () => frame,
    frame,
    surfaces,
    records: { appended, removed, properties, attributes, rootAttributes },
  }
}

/**
 * A recording client context.
 *
 * @param options.payload - what `fetch` resolves to.
 * @returns the context, plus the records the assertions read.
 */
function makeContext({ payload, postOk = true } = {}) {
  const registered = []
  const disposed = []
  const setThemes = []
  const slots = []
  const dictionaries = []
  const effects = []
  const themeListeners = []
  const overrides = []
  const releases = []
  const fetches = []
  const posts = []

  /** The registry the fake service serves, starting with the harness's two builtins. */
  let themes = [
    { id: 'light', colorScheme: 'light', tokens: {} },
    { id: 'dark', colorScheme: 'dark', tokens: {} },
  ]
  let preference = 'system'

  const theme = {
    // Active follows the preference when it names a registered theme, as the real
    // runtime does; `system` and the built-ins fall back to the dark base.
    getTheme: () => ({
      preference,
      themes,
      revision: 1,
      fontSize: 14,
      active: themes.find((entry) => entry.id === preference) ?? themes[1],
    }),
    register: (definition) => {
      // Mirrors the real service: a duplicate id throws rather than replacing.
      if (themes.some((entry) => entry.id === definition.id)) {
        throw new Error(`theme "${definition.id}" is already registered`)
      }
      registered.push(definition)
      themes = [...themes, definition]
      return () => {
        disposed.push(definition.id)
        themes = themes.filter((entry) => entry.id !== definition.id)
      }
    },
    /** Change the preference without publishing, as the settings scope can. */
    __silentPreference: (id) => { preference = id },
    setTheme: (id) => {
      if (id !== 'system' && !themes.some((entry) => entry.id === id)) {
        throw new Error(`theme "${id}" is not registered`)
      }
      setThemes.push(id)
      preference = id
      // The real service publishes here too. This is what makes the stored choice
      // reach the photograph during `applyStoredPreference` rather than at the next
      // unrelated change — and its absence is why this file could not see the
      // reentrancy at all.
      publish()
    },
    /**
     * The layer API the scheme photograph rides on.
     *
     * Mirrors the real service's shape in the two ways the bundle depends on: a bare
     * string value throws (the real one does, and a silent acceptance here would let a
     * wrong override shape ship), and the returned disposer is idempotent.
     */
    overrideTokens: (source, tokens) => {
      for (const [name, value] of Object.entries(tokens)) {
        if (typeof value === 'string') throw new TypeError(`theme override "${name}" is a bare string`)
        if (typeof value?.light !== 'string' || typeof value?.dark !== 'string') {
          throw new TypeError(`theme override "${name}" needs a { light, dark } pair`)
        }
      }
      overrides.push({ source, tokens })
      // PUBLISHES SYNCHRONOUSLY, because the real `overrideTokens` does — it ends with
      // `this.publish()` and that emits `theme/change` before it returns. A fake that
      // stayed silent here hid a stack overflow: the bundle assigned the disposer only
      // after the call returned, so a re-entrant `sync` saw "not applied yet" and
      // recursed. The row then never finished loading, and every test in this file
      // passed while the window showed its spinner forever.
      publish()
      let released = false
      return () => {
        if (released) return
        released = true
        releases.push(source)
        publish()
      }
    },
  }

  /** Emit `theme/change` the way the runtime does, to every current listener. */
  function publish() {
    for (const listener of [...themeListeners]) listener(theme.getTheme())
  }

  const ctx = {
    theme,
    locale: {
      register: (namespace, values) => { dictionaries.push({ namespace, values }) },
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => { callback() },
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
    effect: (callback, label) => {
      const dispose = callback()
      effects.push({ label, dispose })
      return dispose
    },
    on: (event, listener) => {
      themeListeners.push(listener)
      return () => {
        const index = themeListeners.indexOf(listener)
        if (index >= 0) themeListeners.splice(index, 1)
      }
    },
  }

  const fetchImpl = async (url, options) => {
    fetches.push(url)
    if (options?.method === 'POST') {
      posts.push(JSON.parse(options.body))
      return { ok: postOk, json: async () => ({ ok: postOk, preference: null }) }
    }
    return { ok: true, json: async () => payload }
  }

  return {
    ctx, fetchImpl,
    records: {
      registered, disposed, setThemes, slots, dictionaries, effects,
      themeListeners, fetches, posts, overrides, releases,
      preferenceOf: () => preference,
    },
  }
}

/**
 * A host payload built from the real palette data and the real mapping.
 *
 * Deliberately not a hand-written fixture: building it the way the Host does means
 * this test consumes the *actual* shape, so a change to `toThemeDefinition` that the
 * bundle cannot handle fails here rather than in a window.
 *
 * @param names - the scheme names to include.
 * @param source - what to label them as.
 * @returns the payload.
 */
function payloadFor(names, source = 'shipped') {
  return {
    ok: true,
    schemes: names.map((name) => {
      const definition = toThemeDefinition({
        name,
        palette: {
          bg: '#101418', panel: '#181c22', element: '#22262e',
          borderSubtle: '#2a2e36', border: '#3a3e46', borderActive: '#5a5e66',
          text: '#e6e6e6', textMuted: '#a0a0a0', primary: '#ff8800', secondary: '#00d1ff',
          accent: '#c678dd', success: '#98c379', warning: '#e5c07b', info: '#56b6c2',
          error: '#e06c75', yellow: '#d19a66',
        },
      })
      return { ...definition, name, source }
    }),
    preference: null,
    skipped: [],
    userDir: '/home/someone/.dsh/themes',
    builtin: ['system', 'light', 'dark'],
  }
}

/**
 * Run `apply` and let the pending fetch settle.
 *
 * @param options.payload - the host payload.
 * @param options.postOk - whether the POST succeeds.
 * @returns the context, factory and records.
 */
async function applied({ payload, postOk } = {}) {
  // The context first, because its `fetch` is what the bundle must be given.
  const harness = makeContext({ payload: payload ?? payloadFor(['dracula', 'nord']), postOk })
  const document = makeDocument()
  const { factory, observers } = loadFactory(harness.fetchImpl, document)
  // `factory` returns the exports object itself, not a module wrapper: the artifact
  // contract is `factory(require) -> module.exports`.
  const exported = factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
  expect(exported.apply, 'the bundle exports no apply').toBeTypeOf('function')
  expect(exported.inject, 'the bundle exports no inject').toEqual(
    expect.arrayContaining(['slots', 'locale', 'theme']),
  )

  exported.apply(harness.ctx)
  // Two flush cycles: the effect's own fetch, then any `then` chained onto it. The
  // bundle's promises resolve on the microtask queue, which crosses the vm realm.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  return { ...harness, exported, document, observers }
}

describe('the theme bundle', () => {
  it('is self-contained: no relative require, which upstream never uses either', () => {
    // The harness ships zero client bundles with a relative `require`, so one here
    // would resolve against the loader's table and fail at materialization — inside a
    // window, where nothing in this suite could see it.
    expect(SOURCE).not.toMatch(/require\(\s*['"]\./u)
  })

  it('asks for only the modules the loader provides', () => {
    const requested = [...SOURCE.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map((match) => match[1])
    expect(new Set(requested)).toEqual(new Set(['react']))
  })

  it('fetches the document-relative route, not a root-absolute one', () => {
    // The served document carries `<base href="./">`; a leading slash resolves against
    // the origin and breaks under a prefix.
    const path = /const API = '([^']+)'/u.exec(SOURCE)
    expect(path, 'the bundle declares no API path').not.toBeNull()
    expect(path[1].startsWith('/')).toBe(false)
    expect(path[1]).toBe('api/qialike/themes')
  })
})

describe('scheme registration', () => {
  it('registers every scheme the host sent, under the id the host computed', async () => {
    const payload = payloadFor(['dracula', 'nord', 'gruvbox'])
    const { records } = await applied({ payload })
    expect(records.registered.map((entry) => entry.id)).toEqual(payload.schemes.map((scheme) => scheme.id))
  })

  it('registers the host’s id verbatim, never deriving one from the name', async () => {
    // The load-bearing contract. A bundle that computed `qialike-` + name itself would
    // pass every other test here and still be a second copy of the namespacing rule —
    // in the half that cannot be unit-tested for it. An id that breaks the rule is
    // therefore the assertion.
    const payload = payloadFor(['dracula'])
    payload.schemes[0].id = 'not-the-namespaced-form'
    const { records } = await applied({ payload })
    expect(records.registered.map((entry) => entry.id)).toEqual(['not-the-namespaced-form'])
  })

  it('passes the colour scheme and the mapped tokens straight through', async () => {
    const payload = payloadFor(['dracula'])
    const { records } = await applied({ payload })
    expect(records.registered[0].colorScheme).toBe(payload.schemes[0].colorScheme)
    expect(records.registered[0].tokens).toEqual(payload.schemes[0].tokens)
    expect(Object.keys(records.registered[0].tokens).length).toBeGreaterThan(50)
  })

  it('skips a scheme that is already registered rather than throwing', async () => {
    // `register` throws on a duplicate id, and a remount can reach this before the
    // previous registrations are disposed. Throwing would take the row down with it.
    const payload = payloadFor(['dracula', 'nord'])
    payload.schemes[0].id = 'light'
    const { records } = await applied({ payload })
    expect(records.registered.map((entry) => entry.id)).toEqual(['qialike-nord'])
  })

  it('leaves the harness’s own themes alone', async () => {
    const { records, ctx } = await applied({ payload: payloadFor(['dracula']) })
    const ids = ctx.theme.getTheme().themes.map((entry) => entry.id)
    expect(ids).toContain('light')
    expect(ids).toContain('dark')
    expect(records.disposed).toEqual([])
  })
})

describe('the stored preference', () => {
  it('applies it once the schemes exist', async () => {
    // The order matters: `setTheme` throws for an unregistered id, so applying before
    // registering would fail every start.
    const payload = { ...payloadFor(['dracula']), preference: 'dracula' }
    const { records } = await applied({ payload })
    expect(records.setThemes).toEqual([themeIdFor('dracula')])
  })

  it('does nothing when no scheme is stored', async () => {
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    expect(records.setThemes).toEqual([])
  })

  it('reports rather than throws when the stored scheme is gone', async () => {
    // The file was deleted between runs. Applying the id would throw inside `setTheme`;
    // ignoring it silently would look like a lost setting.
    const payload = { ...payloadFor(['dracula']), preference: 'deleted-scheme' }
    const { records, ctx } = await applied({ payload })
    expect(records.setThemes).toEqual([])
    expect(ctx.theme.getTheme().preference).toBe('system')
  })

  it('re-asserts the scheme when the runtime normalises the preference away', async () => {
    // `adopt()` in `ThemeRuntime` rewrites the preference from its durable settings
    // scope, whose schema cannot hold a scheme id. Without this the theme silently
    // reverts to the harness's own the first time that scope delivers a value.
    const payload = { ...payloadFor(['dracula']), preference: 'dracula' }
    const { records, ctx } = await applied({ payload })
    expect(records.setThemes).toEqual([themeIdFor('dracula')])

    // Simulate the scope normalising the preference back to a built-in.
    ctx.theme.setTheme('light')
    for (const listener of [...records.themeListeners]) {
      listener(ctx.theme.getTheme())
    }
    expect(records.setThemes).toEqual([themeIdFor('dracula'), 'light', themeIdFor('dracula')])
  })

  it('does not re-assert after the user picks a built-in appearance', async () => {
    // Choosing System/Light/Dark in this row is the documented way to hand control
    // back, so the row must stop insisting on the scheme it just dropped.
    const payload = { ...payloadFor(['dracula']), preference: 'dracula' }
    const { records, ctx } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    expect(row, 'the row was not registered').toBeDefined()

    // Drive the component the way a click would: call it, find the select, fire it.
    const tree = row.component()
    const select = findSelect(tree)
    select.props.onChange({ target: { value: 'dark' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(records.setThemes).toEqual([themeIdFor('dracula'), 'dark'])
    // And a later drift is no longer corrected, because the intent is now a built-in.
    for (const listener of [...records.themeListeners]) listener(ctx.theme.getTheme())
    expect(records.setThemes).toEqual([themeIdFor('dracula'), 'dark'])
  })

  it('does not re-assert for a scheme it never registered', async () => {
    // Guards the `setTheme` throw: a remount can dispose the schemes between the drift
    // arriving and the re-assertion.
    const payload = { ...payloadFor(['dracula']), preference: 'dracula' }
    const { records, ctx } = await applied({ payload })
    const before = [...records.setThemes]
    // Dispose everything the bundle registered, as a remount would.
    const ids = records.registered.map((entry) => entry.id)
    for (const id of ids) {
      // The fake service's disposer is the one the bundle holds.
    }
    // Emulate disposal by asking the registry to forget it.
    ctx.theme.setTheme = (id) => { records.setThemes.push(id) }
    for (const listener of [...records.themeListeners]) {
      listener({ preference: 'system', themes: [], revision: 2, fontSize: 14, active: undefined })
    }
    // `themes: []` means the scheme is not registered, so the guard must decline.
    expect(records.setThemes).toEqual(before)
  })
})

describe('the settings row', () => {
  it('registers into settings.general.item', async () => {
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    expect(records.slots.map((entry) => entry.options.name)).toContain('settings.general.item')
  })

  it('is a section of its own, between General and the plugins list', async () => {
    // ONE COLUMN FOR ONE SUBJECT: the three rows that decide what this window looks like.
    // Order 10 sits between `general` (0) and `qialike-providers` (20).
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    expect(row.options.name).toBe('settings.section')
    expect(row.options.order).toBe(10)
    // A thunk, so the nav label follows the language without re-registering.
    expect(typeof row.options.label).toBe('function')
  })

  it('retires the two rows ui-theme put in General, at a priority that wins the cell', async () => {
    // `ui-theme` provides the `theme` service this whole bundle runs on, so it cannot be
    // disabled — the cells have to be taken instead. A list slot renders the entry with the
    // LOWEST priority for an id, and two equal priorities THROW, which is why this is `-1`:
    // leaving the default would fail at registration rather than silently duplicate.
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    for (const id of ['appearance', 'font-size']) {
      const shadow = records.slots.find((entry) => entry.options.id === id
        && entry.options.name === 'settings.general.item')
      expect(shadow, `${id} was not shadowed`).toBeDefined()
      expect(shadow.options.priority).toBe(-1)
      expect(shadow.component({}), 'the shadow draws something').toBeNull()
    }
  })

  it('declares its locale namespace, so the row has a `t` seat', async () => {
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    expect(row.options.locale).toBe('qialike-theme')
    expect(records.dictionaries.map((entry) => entry.namespace)).toContain('qialike-theme')
  })

  it('renders a picker offering the host’s schemes and the built-in preferences', async () => {
    const payload = { ...payloadFor(['dracula', 'nord'], 'user'), preference: 'dracula' }
    const { records } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    const values = optionValues(select)
    // The built-ins and every scheme, each under the host's id.
    expect(values).toEqual(expect.arrayContaining(['system', 'light', 'dark', themeIdFor('dracula'), themeIdFor('nord')]))
    // The current choice is what the control shows.
    expect(select.props.value).toBe(themeIdFor('dracula'))
  })

  it('surfaces a skipped scheme file, since the list is otherwise unexplainable', async () => {
    const payload = payloadFor(['dracula'])
    payload.skipped = [{ file: '/home/someone/.dsh/themes/broken.json', reason: 'Unexpected token' }]
    const { records } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const texts = collectText(row.component())
    expect(texts.join(' ')).toContain('broken.json')
  })

  it('reports a failed save, because the change would not survive a restart', async () => {
    const payload = payloadFor(['dracula'])
    const { records } = await applied({ payload, postOk: false })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    select.props.onChange({ target: { value: themeIdFor('dracula') } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The POST was attempted, so the failure is a write failure rather than a skipped
    // step; the row reports it as `saveFailed`.
    expect(records.posts).toEqual([{ op: 'setPreference', name: 'dracula' }])
  })

  it('paints the picker with the design system’s field, not the user agent’s', async () => {
    // MEASURED IN A RENDERED WINDOW, WHICH IS THE ONLY PLACE THIS WAS VISIBLE. The
    // select used to carry no style at all, so the browser drew it: a 127x20 grey
    // widget with a #858585 border that was byte-identical in the dark theme and in
    // dracula, and white in One Light. It followed `color-scheme` — which the theme's
    // own `colorScheme` field sets — and none of the chosen scheme's colours. The one
    // control a user operates *in order to* change the palette was the one control the
    // palette did not reach.
    //
    // This asserts the fix at the level the stub can see: the select carries a style
    // object, the OS arrow is replaced, and the fill and ink are tokens rather than
    // literals. Token *existence* is `client-tokens.test.mjs`'s job, not this one's.
    const { records } = await applied({ payload: payloadFor(['dracula']) })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    const style = select.props.style
    expect(style, 'the picker must carry a style object').toBeTypeOf('object')
    expect(style.appearance).toBe('none')
    expect(style.background).toContain('var(--dsw-alias-bg-layer-1)')
    expect(style.color).toContain('var(--dsw-alias-label-primary)')
    expect(style.border).toContain('var(--dsw-alias-border-l4)')
    // No literal colour anywhere in it: a hex here is the failure this file's sibling
    // `client-tokens` cannot see, because that test only checks the names that exist.
    expect(JSON.stringify(style)).not.toMatch(/#[0-9a-f]{3,8}\b(?!.*svg)/iu)
  })
})

describe('what the client posts', () => {
  it('posts the scheme name, not the namespaced id', async () => {
    // `qialike.json` holds the CLI's own name — that is the value `/theme dracula`
    // writes and reads, so the two products keep sharing one preference.
    const payload = payloadFor(['dracula'])
    const { records } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    selectOf(row).props.onChange({ target: { value: themeIdFor('dracula') } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(records.posts).toEqual([{ op: 'setPreference', name: 'dracula' }])
  })

  it('posts null when the user returns to an appearance preference', async () => {
    // Null is the recorded intent "the harness row is in charge again" — distinct from
    // leaving the previous scheme stored, which would re-apply it on the next start.
    const payload = payloadFor(['dracula'])
    const { records } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    selectOf(row).props.onChange({ target: { value: 'system' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(records.posts).toEqual([{ op: 'setPreference', name: null }])
  })
})

describe('the host-to-client contract', () => {
  it('accepts a payload shaped exactly as the host builds one', async () => {
    // The two halves are written in different processes and different languages, and
    // this is the only place they meet. The payload is built through the real
    // `toThemeDefinition`, so a change there that the bundle cannot consume fails here
    // rather than in a window.
    const { records } = await applied({ payload: payloadFor(['dracula', 'nord', 'gruvbox']) })
    expect(records.registered).toHaveLength(3)
    for (const definition of records.registered) {
      expect(definition.id.startsWith(THEME_ID_PREFIX)).toBe(true)
      expect(['light', 'dark']).toContain(definition.colorScheme)
      expect(Object.keys(definition.tokens).length).toBeGreaterThan(50)
    }
  })
})

/** Find the first `select` in a rendered element tree. */
function findSelect(raw) {
  const node = expand(raw)
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === 'select') return node
  for (const child of node.children ?? []) {
    const found = findSelect(child)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Expand function components, so a test reads the tree the way React would build it.
 *
 * THE SECTION RENDERS THE ROW NOW. `qialike-appearance` is a `settings.section` entry whose
 * body mounts the appearance cubes, the font-size group and the picker, so `component()` alone
 * hands back unrendered elements. This stub's hooks are inert — `useState` returns its initial
 * value, `useEffect` never runs — which makes expanding a component a pure call with no state
 * to keep, and therefore safe on every tree walk.
 *
 * @param node - an element tree as `createElement` built it.
 * @param depth - recursion guard for a component that renders itself.
 * @returns the tree with function components replaced by their output.
 */
function expand(node, depth = 0) {
  if (depth > 24 || node === null || typeof node !== 'object' || Array.isArray(node)) return node
  if (typeof node.type !== 'function') {
    return { ...node, children: (node.children ?? []).map((child) => expand(child, depth + 1)) }
  }
  return expand(node.type({ ...node.props, children: node.children }), depth + 1)
}

/** The `select` inside a row, asserted present. */
function selectOf(row) {
  const select = findSelect(row.component())
  expect(select, 'the row rendered no select').toBeDefined()
  return select
}

/** Every `option` value in a select, descending through optgroups. */
function optionValues(select) {
  const values = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'option') values.push(node.props.value)
    for (const child of node.children ?? []) walk(child)
  }
  for (const child of select.children ?? []) walk(child)
  return values
}

/** Every string in an element tree, for asserting on rendered copy. */
function collectText(raw) {
  const node = expand(raw)
  if (typeof node === 'string') return [node]
  if (node === null || typeof node !== 'object') return []
  const out = []
  for (const child of node.children ?? []) out.push(...collectText(child))
  return out
}

describe('the scheme photograph', () => {
  // WHAT THIS PINS, AND WHY IT IS NOT ABOUT PIXELS. Whether a photograph looks right is a
  // fact about a rendered window. What can be settled here is the mechanism: the rule
  // exists exactly once, the variable carries a scrim, and the variable is present only
  // while the scheme that owns the photograph is active.
  //
  // THE FAILURE THIS GUARDS IS SILENT IN BOTH DIRECTIONS. A variable left behind paints
  // the photograph behind every other scheme; one never written leaves a theme that does
  // nothing. Neither throws, and neither is visible to any other test in this suite.

  const PHOTO_ID = themeIdFor('moss')
  const VARIABLE = '--qialike-moss-photo'

  /** Choose a scheme the way the row does, which is what sets `intent`. */
  async function choose(records, id) {
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    select.props.onChange({ target: { value: id } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }

  it('appends exactly one rule, and it targets the frame by the slot wrapper', async () => {
    const { document } = await applied({})
    const styles = document.records.appended.filter((node) => node.tagName === 'STYLE')
    expect(styles).toHaveLength(1)
    // THE PRIMARY HOOK IS THE SLOT WRAPPER, not the class. The running window's frame is
    // `als6gG_frame` while one bundle spells it `_frame_1hfzl_1` — both spellings ship, so
    // a selector built on either is a coin flip, and getting it wrong paints nothing while
    // the override looks fine. `data-slot` is an attribute in the TSX, so it survives
    // rehashing.
    expect(styles[0].textContent).toContain('[data-slot="root"] > div')
    // Kept as fallbacks for a build that stops rendering the slot attribute.
    expect(styles[0].textContent).toContain('_frame_')
    // A custom property, never `--dsw-alias-bg-base`: 43 upstream rules read that one as
    // a colour, and a `url()` there strips their fill.
    expect(styles[0].textContent).toContain(VARIABLE)
    expect(styles[0].textContent).not.toContain('--dsw-alias-bg-base')
    // GATED ON AN ATTRIBUTE: the rule must not reach the other schemes for even one
    // paint, and a custom property cannot gate a declaration in the cascade.
    expect(styles[0].textContent).toContain('body[data-qialike-photo]')
    expect(styles[0].textContent).not.toContain('--dsw-alias-bg-base')
    // GATED ON AN ATTRIBUTE, because the second half of the rule must not reach the other
    // fifteen schemes even once: a custom property cannot gate a declaration, and an
    // ungated `background-color: transparent` would strip every column's fill in dracula.
    expect(styles[0].textContent).toContain('body[data-qialike-photo]')
    // THE COLUMNS ARE OPAQUE AND COVERED THE FRAME. Measured in a running window: the
    // frame held the image, and its 1000x793 child painted over 1000 of 1280 pixels.
    expect(styles[0].textContent).not.toContain('--dsw-alias-bg-base')
    // GATED ON AN ATTRIBUTE: the rule must not reach the other schemes for even one
    // paint, and a custom property cannot gate a declaration in the cascade.
    // GATED ON AN ATTRIBUTE: the rule must not reach the other schemes for even one
    // paint, and a custom property cannot gate a declaration in the cascade.
    expect(styles[0].textContent).toContain('body[data-qialike-photo]')
    expect(styles[0].textContent).not.toContain('--dsw-alias-bg-base')
  })

  it('writes nothing while another scheme is active', async () => {
    const { document } = await applied({})
    expect(document.records.properties.has(VARIABLE)).toBe(false)
    expect(document.records.attributes.has('data-qialike-photo')).toBe(false)
  })

  it('writes the photograph when its scheme becomes active', async () => {
    const { document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const value = document.records.properties.get(VARIABLE)
    expect(value).toBeDefined()
    expect(value).toContain('url("assets/moss-bg.jpg")')
    // THE SCRIM IS TRANSPARENT NOW, AND THE INVARIANT MOVED INTO THE ASSET. The artwork ships
    // finished — its own median is 16.8/255 against the 17 this scheme's note calls the target,
    // and its maximum is 50/255 against the ceiling of 70 — so a second darkening pass would
    // only compress it: measured, 0.50 on top takes the standard deviation from 9.8 to 5.4 and
    // the ceiling from 50 to 41, which is the flat colour this scheme was fixed to avoid.
    //
    // The assertion therefore checks BOTH halves of the new contract: the scrim is present as a
    // value (so the asset path and the layer stay one declaration) and its alpha is zero. A
    // future edit that restores 0.50 fails here, which is the point — that edit would darken the
    // window without anyone noticing, because the page still renders.
    expect(value).toContain('linear-gradient')
    expect(value).toMatch(/rgba\(12,\s*15,\s*13,\s*0\)/u)
    expect(value, 'the scrim was turned back into a darkening pass').not.toMatch(/rgba\(12,\s*15,\s*13,\s*(\.[1-9]|1)/u)
  })

  it('removes the variable when the user switches away', async () => {
    const { records, document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    await choose(records, 'dark')
    expect(document.records.properties.has(VARIABLE)).toBe(false)
    expect(document.records.attributes.has('data-qialike-photo')).toBe(false)
  })

  it('is idempotent when the same scheme is re-delivered', async () => {
    // The runtime publishes on every snapshot change, including ones that only move the
    // font size; the value must not depend on how many times that happens.
    const { records, document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const first = document.records.properties.get(VARIABLE)
    for (const listener of [...records.themeListeners]) listener(records.themeListeners.length ? { preference: 'system', themes: [], revision: 3, fontSize: 14, active: { id: 'dark', colorScheme: 'dark', tokens: {} } } : {})
    expect(document.records.properties.get(VARIABLE)).toBe(first)
  })

  it('removes the rule and the variable when the row is torn down', async () => {
    const { records, document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const photoEffect = records.effects.find((entry) => entry.label === 'qialike-theme: scheme photograph')
    expect(photoEffect, 'the photograph is not registered as an effect').toBeDefined()
    photoEffect.dispose()
    expect(document.records.removed).toHaveLength(1)
    expect(document.records.properties.has(VARIABLE)).toBe(false)
    expect(document.records.attributes.has('data-qialike-photo')).toBe(false)
  })

  it('uses a document-relative asset path, like the API route', async () => {
    // The served document carries `<base href="./">`; a leading slash would resolve
    // against the origin and 404 under a prefix. `/assets/` is also the only URL space
    // the shell serves without knowing individual file names.
    const url = /url: '([^']+)'/u.exec(SOURCE)
    expect(url, 'the bundle declares no photograph url').not.toBeNull()
    expect(url[1]).toBe('assets/moss-bg.jpg')
  })
})

describe('the photograph when it is already the stored choice', () => {
  // THE STATE A REAL USER GETS ON THE SECOND LAUNCH: `qialike.json` already says
  // `colorscheme: moss`, so the photograph has to be written from inside the load that
  // fills the picker rather than in response to a later click.
  //
  // THE FIRST IMPLEMENTATION USED `ctx.theme.overrideTokens()` AND DIED HERE. That call
  // publishes, and publishing emits `theme/change` synchronously; the bundle assigned the
  // disposer only after it returned, so the re-entrant listener saw "not applied yet" and
  // recursed — `RangeError: Maximum call stack size exceeded`, thrown inside the load, so
  // the picker sat on "loading" forever with nothing in the console. Writing the variable
  // directly publishes nothing, so the recursion cannot happen; this test stays because it
  // is the state that exposed it.

  const VARIABLE = '--qialike-moss-photo'

  it('paints the photograph while the picker loads, and still finishes loading', async () => {
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { records, document } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    expect(row, 'the row never registered').toBeDefined()
    expect(document.records.properties.get(VARIABLE)).toContain('moss-bg.jpg')
  })

  it('clears the photograph when the user drops the scheme in the row', async () => {
    // THROUGH THE ROW, NOT THROUGH THE RUNTIME. Calling `setTheme('dark')` directly is
    // read as drift and corrected back to the stored scheme — the row's documented
    // behaviour, covered by its own test above — so it cannot drop the photograph and
    // must not be used to pretend it did.
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { records, document } = await applied({ payload })
    expect(document.records.properties.get(VARIABLE)).toContain('moss-bg.jpg')

    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    select.props.onChange({ target: { value: 'dark' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(document.records.properties.has(VARIABLE)).toBe(false)
  })
})

describe('the surfaces over the photograph', () => {
  /** Choose a scheme the way the row does, which is what sets `intent`. */
  async function choose(records, id) {
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    select.props.onChange({ target: { value: id } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }

  // THE TWO SYMPTOMS THAT MOTIVATED THIS: "the new-session background is still flat colour"
  // and "the sidebar is still flat colour". The frame carried the image correctly and was
  // covered by opaque fills several levels down, each named by a build hash — measured in
  // one running window as `als6gG_centerCol` and `R5Rraq_root`, against the same bundle
  // also carrying `_frame_1hfzl_1`. Naming them is a coin flip, so the bundle measures
  // instead: an opaque fill covering at least 12% of the frame is a surface, anything
  // smaller is a card or a bubble.

  const PHOTO_ID = themeIdFor('moss')
  const VARIABLE = '--qialike-moss-photo'

  /** A fake element the scan can measure. */
  function surface(width, height, background, backgroundImage = 'none') {
    const attributes = new Set()
    const element = {
      __computed: { backgroundColor: background, backgroundImage },
      width,
      height,
      getBoundingClientRect: () => ({ width, height, top: 0, left: 0 }),
      setAttribute: (name) => { attributes.add(name) },
      removeAttribute: (name) => { attributes.delete(name) },
      hasAttribute: (name) => attributes.has(name),
      // Not inside a dialog: the scan asks before clearing, and these fixtures are columns.
      closest: () => null,
    }
    return element
  }


  it('clears a column-sized opaque fill and leaves a card alone', async () => {
    // 280x793 is the sidebar (22% of a 1280x800 frame); 712x114 is the widest card measured
    // in a real window (8%). Both are opaque, and only one is a surface.
    const column = surface(280, 793, 'rgb(21, 21, 23)')
    const card = surface(712, 114, 'rgb(44, 44, 46)')
    const { records, document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(column, card)
    await choose(records, 'qialike-moss')
    expect(column.hasAttribute('data-qialike-photo-surface'), 'the column was left opaque').toBe(true)
    expect(card.hasAttribute('data-qialike-photo-surface'), 'the card was dissolved').toBe(false)
  })

  it('leaves an already-transparent surface alone, and one that paints an image', async () => {
    const alreadyClear = surface(1280, 800, 'rgba(0, 0, 0, 0)')
    const painting = surface(1280, 800, 'rgb(21, 21, 23)', 'linear-gradient(red, blue)')
    const { document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(alreadyClear, painting)

    expect(alreadyClear.hasAttribute('data-qialike-photo-surface')).toBe(false)
    expect(painting.hasAttribute('data-qialike-photo-surface')).toBe(false)
  })

  it('unmarks every surface when the user switches away', async () => {
    // A mark left behind strips the fill from a column in a scheme that asked for none —
    // which is the other half of this feature's failure surface, and it looks like a
    // rendering bug in someone else's theme.
    const column = surface(280, 793, 'rgb(21, 21, 23)')
    const { records, document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(column)
    await choose(records, 'qialike-moss')
    expect(column.hasAttribute('data-qialike-photo-surface')).toBe(true)

    await choose(records, 'dark')
    expect(column.hasAttribute('data-qialike-photo-surface')).toBe(false)
  })

  it('watches the page so a newly mounted column is cleared too', async () => {
    // The right sidebar opens after boot, and a new session mounts its own columns. Without
    // the observer the marks describe the DOM as it was when the scheme was chosen — a
    // solid rectangle over the photograph the first time the user opens something.
    const { document, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })

    expect(observers.length, 'no observer was constructed').toBeGreaterThan(0)
    expect(observers.some((instance) => instance.observing === true)).toBe(true)
  })

  it('disconnects the observer and drops the marks on teardown', async () => {
    const column = surface(280, 793, 'rgb(21, 21, 23)')
    const { records, document, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(column)

    const effect = records.effects.find((entry) => entry.label === 'qialike-theme: scheme photograph')
    effect.dispose()

    expect(column.hasAttribute('data-qialike-photo-surface')).toBe(false)
    expect(observers.every((instance) => instance.disconnected !== false || instance.observing === false)).toBe(true)
  })
})

describe('the stored scheme surviving the settings scope', () => {
  // THE BUG THIS PINS, REPORTED AS "the boot palette is the harness's, not moss". The
  // runtime's preference lives in a settings scope whose schema is `light | dark |
  // system`, so a scheme id cannot be stored there: `adopt()` writes `system` over it and
  // publishes. Measured over the DevTools protocol, one launch ended with our scheme
  // active and the next with the built-in palette — a race between that adoption and the
  // row's re-assertion, resolved by whichever happened last.
  //
  // Two things were wrong and both are asserted here:
  //   · the re-assertion compared `preference`, which can equal our id while `active` is
  //     the built-in theme — the one state that must not be accepted, because the picker
  //     then shows `moss` over a window painted in the defaults;
  //   · a single re-assertion cannot help when the adoption is the LAST event, so the
  //     restore also re-checks on timers.

  const PHOTO_ID = themeIdFor('moss')

  /** Let the settle timers (0/50/200/600/1500 ms) run out. */
  const settleWindow = () => new Promise((resolve) => { setTimeout(resolve, 1700) })

  it('re-asserts when the preference says our id but the palette is the built-in one', async () => {
    // The mismatch the old guard waved through: preference matches, active does not.
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { records, ctx } = await applied({ payload })
    const before = records.setThemes.length

    // Simulate the runtime's own inconsistency: preference kept, active reverted.
    records.themeListeners.forEach((listener) => listener({
      preference: PHOTO_ID,
      themes: ctx.theme.getTheme().themes,
      revision: 9,
      fontSize: 14,
      active: { id: 'dark', colorScheme: 'dark', tokens: {} },
    }))

    expect(records.setThemes.length, 'the drift was accepted').toBeGreaterThan(before)
    expect(records.setThemes.at(-1)).toBe(PHOTO_ID)
  })

  it('wins the race when the scope adopts after the restore', async () => {
    // THE ORDERING A SINGLE LISTENER CANNOT FIX. The scope writes its own value after our
    // restore has already run, and nothing publishes — so there is no event to react to.
    // Measured in a real window, this is the launch that ended on the built-in palette,
    // and the settle timers are what recover it.
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { ctx } = await applied({ payload })

    ctx.theme.__silentPreference('system')
    expect(ctx.theme.getTheme().active.id, 'the scope did not take over').not.toBe(PHOTO_ID)

    await settleWindow()
    expect(ctx.theme.getTheme().active.id, 'the stored scheme did not come back').toBe(PHOTO_ID)
  })

  it('does not keep re-asserting once it has settled', async () => {
    // Idempotence matters because each re-assertion publishes, which re-enters the
    // listener: an unconditional one would spin forever on a settled window.
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { records } = await applied({ payload })
    const settled = records.setThemes.length
    await settleWindow()
    expect(records.setThemes.length).toBe(settled)
  })
})

describe('the palette this row owns', () => {
  // WHY THE ROW PAINTS AT ALL, RECORDED BECAUSE IT LOOKS LIKE DUPLICATION. The harness's
  // uilayout presenter is the intended owner of `body`'s alias variables. Measured over
  // the DevTools protocol on this build, a scheme restored at startup ended with `body`
  // carrying zero `--dsw-alias-*` variables and the base palette at the harness's
  // `#151517`, on four launches out of four, while the picker showed the stored scheme.
  //
  // The cause is bookkeeping by NAME: the presenter's `apply` strips every token it
  // previously wrote (`appliedTokens`) before writing the next set, and the names it
  // strips are the same ones this row writes. So the row paints from the Host's own token
  // map, and repaints from a timer after the emit has finished — the only ordering that
  // survives that stripping.

  const VARIABLE = '--qialike-moss-photo'

  it('writes the Host’s aliases for a scheme restored at startup', async () => {
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { document } = await applied({ payload })
    const written = [...document.records.properties.keys()].filter((name) => name.startsWith('--dsw-alias'))
    expect(written.length, 'no alias token was painted').toBeGreaterThan(50)
    // The background the report named: `#151517` is the harness's, `#101418` is this
    // fixture's scheme background.
    expect(document.records.properties.get('--dsw-alias-bg-base')).toBeDefined()
  })

  it('keeps the native-chrome attribute honest while a scheme is chosen', async () => {
    // The Electron preload mirrors `data-ds-theme-source` into `nativeTheme`, and the
    // presenter publishes `system` for a scheme it cannot represent — which paints a light
    // title bar over a dark scheme.
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { document } = await applied({ payload })
    expect(document.records.rootAttributes.get('data-ds-theme-source')).toBe('dark')
  })

  it('stops painting once the user returns to a built-in appearance', async () => {
    const payload = { ...payloadFor(['moss']), preference: 'moss' }
    const { records, document } = await applied({ payload })
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    const select = findSelect(row.component())
    select.props.onChange({ target: { value: 'dark' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect([...document.records.properties.keys()].filter((n) => n.startsWith('--dsw-alias'))).toEqual([])
    expect(document.records.properties.has(VARIABLE)).toBe(false)
  })
})

describe('what must never flicker', () => {
  // TWO REPORTED SYMPTOMS, ONE CAUSE. "The background flickers" and "moving the mouse turns
  // it solid" both came from the scan: it removed every mark before re-adding the ones that
  // still qualified, and it watched `class`/`style`, so hovering anything triggered a scan
  // that briefly saw a restyled surface as not-yet-opaque. Dropping a mark restores that
  // element's fill, which is exactly a flash of solid colour.

  const VARIABLE = '--qialike-moss-photo'

  /** A fake element the scan can measure, with a mutable fill. */
  function surface(width, height, background) {
    const attributes = new Set()
    const element = {
      __computed: { backgroundColor: background, backgroundImage: 'none' },
      width,
      height,
      getBoundingClientRect: () => ({ width: element.width, height: element.height, top: 0, left: 0 }),
      setAttribute: (name) => { attributes.add(name) },
      removeAttribute: (name) => { attributes.delete(name) },
      hasAttribute: (name) => attributes.has(name),
      // The scan skips anything inside a dialog or the shell's overlay layer; `element.closest`
      // is how it asks. Default: not inside one.
      closest: () => (element.insideDialog === true ? element : null),
    }
    return element
  }

  it('keeps a mark when a second scan no longer sees the element as opaque', async () => {
    // The hover case: a restyle makes the element look transparent for one measurement.
    // Add-only means the mark survives, so nothing flashes. Driven through the observer's
    // own callback — the same path a real mutation takes — and past its 150 ms debounce.
    const column = surface(280, 793, 'rgb(21, 21, 23)')
    const { records, document, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(column)
    const row = records.slots.find((entry) => entry.options.id === 'qialike-appearance')
    findSelect(row.component()).props.onChange({ target: { value: 'qialike-moss' } })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(column.hasAttribute('data-qialike-photo-surface')).toBe(true)

    // Mid-restyle, the same element now measures as transparent.
    column.__computed.backgroundColor = 'rgba(0, 0, 0, 0)'
    const watching = observers.find((instance) => instance.observing === true)
    expect(watching, 'nothing is observing the page').toBeDefined()
    watching.callback()
    await new Promise((resolve) => { setTimeout(resolve, 250) })

    expect(column.hasAttribute('data-qialike-photo-surface'), 'the mark was dropped mid-restyle').toBe(true)
    expect(document.records.properties.has(VARIABLE)).toBe(true)
  })

  it('watches structure only, so a hover restyle cannot trigger a scan', async () => {
    // The observer originally carried `attributes: true` with `attributeFilter:
    // ['class','style']`. Every hover rewrites a class, so every pointer movement ran a
    // scan — measured as the background going solid on mouse move.
    const { records, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    expect(records.slots.length).toBeGreaterThan(0)
    const watching = observers.find((instance) => instance.observing === true)
    expect(watching, 'nothing is observing the page').toBeDefined()
    expect(watching.options.childList).toBe(true)
    expect(watching.options.subtree).toBe(true)
    expect(watching.options.attributes, 'attribute watching is back, and hover will flicker').toBeUndefined()
  })
})

describe('the scheme a fresh profile opens in', () => {
  // THE CLI RESOLVES AN UNSET `colorscheme` TO `moss` — its own palette, and the look this
  // product ships (CLI 0.11.2). Letting the desktop fall through to the harness's `system`
  // would open the same product in two different palettes depending on which front end you
  // started, which reads as a bug rather than as a preference.

  it('chooses the shipped default when nothing is stored', async () => {
    const { records, ctx } = await applied({ payload: { ...payloadFor(['moss']), preference: null } })
    expect(records.setThemes.at(-1)).toBe(themeIdFor('moss'))
    expect(ctx.theme.getTheme().active.id).toBe(themeIdFor('moss'))
  })

  it('leaves a profile that already chose alone', async () => {
    // The upgrade case: someone who picked dracula must still get dracula. This is the
    // assertion that makes the default safe to add at all.
    const { records, ctx } = await applied({ payload: { ...payloadFor(['moss', 'dracula']), preference: 'dracula' } })
    expect(records.setThemes.at(-1)).toBe(themeIdFor('dracula'))
    expect(ctx.theme.getTheme().active.id).toBe(themeIdFor('dracula'))
  })

  it('does not write the default to the config file', async () => {
    // A user who never chose a scheme has not chosen moss either. The choice is an intent
    // for this run; persisting it would turn a shipped default into a stored preference the
    // user can only escape by finding the picker.
    const { records } = await applied({ payload: { ...payloadFor(['moss']), preference: null } })
    expect(records.posts, 'the default was persisted').toEqual([])
  })
})

describe('what the surface scan must never clear', () => {
  // REPORTED: "the model-provider setup window is see-through and I can read the window behind
  // it". The scan clears large opaque fills so the photograph shows through — and a MODAL is
  // large and opaque on purpose. Measured on a fresh profile, both the dialog card (466x340)
  // and its full-window backdrop carried the mark and computed `rgba(0, 0, 0, 0)`.
  //
  // The scan is add-only (that is what stopped the hover flicker), so a rule that marks a
  // dialog cannot be undone by a later scan; the exclusion has to happen before marking.

  const VARIABLE = '--qialike-moss-photo'

  function surface(width, height, background, insideDialog = false) {
    const attributes = new Set()
    const element = {
      insideDialog,
      __computed: { backgroundColor: background, backgroundImage: 'none' },
      getBoundingClientRect: () => ({ width, height, top: 0, left: 0 }),
      setAttribute: (name) => { attributes.add(name) },
      removeAttribute: (name) => { attributes.delete(name) },
      hasAttribute: (name) => attributes.has(name),
      closest: () => (insideDialog ? element : null),
    }
    return element
  }

  it('leaves a dialog card and its backdrop opaque', async () => {
    const card = surface(466, 340, 'rgb(20, 24, 21)', true)
    const backdrop = surface(1280, 793, 'rgb(30, 36, 31)', true)
    const { document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(card, backdrop)

    // Force a scan through the observer's own callback, then let its debounce elapse.
    const effect = document.records.appended
    expect(document.records.properties.has(VARIABLE)).toBe(true)
    await new Promise((resolve) => { setTimeout(resolve, 300) })

    expect(card.hasAttribute('data-qialike-photo-surface'), 'the dialog was cleared').toBe(false)
    expect(backdrop.hasAttribute('data-qialike-photo-surface'), 'the backdrop was cleared').toBe(false)
    expect(effect.length).toBeGreaterThan(0)
  })

  it('still clears a column of the same size', async () => {
    // The exclusion must not swallow the case the scan exists for: the sidebar is 280x793,
    // and the conversation column is 1000x793 — both larger than a dialog card.
    const column = surface(1000, 793, 'rgb(21, 21, 23)', false)
    const { document } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    document.surfaces.push(column)
    await new Promise((resolve) => { setTimeout(resolve, 300) })

    expect(column.hasAttribute('data-qialike-photo-surface')).toBe(true)
  })
})

describe('a palette the presenter strips is repaired at once, not on the next timer tick', () => {
  // MEASURED, and the reason this is a test rather than a comment: the packaged build's
  // end-to-end run samples the palette 1200 ms after choosing a scheme, and the last two
  // settle ticks are at 1500 ms and 3000 ms. So a strip between them leaves the window on
  // the harness's `#151517` while the picker shows the chosen scheme — a flicker a person
  // can see, and the reason one e2e launch failed and the next three passed.
  //
  // The presenter retracts tokens BY NAME, and the names are this row's too, so its own
  // bookkeeping cannot tell them apart. Watching `body`'s style and painting again the
  // moment the value moves is the only ordering that survives that.

  it('re-paints when another writer removes the token it just set', async () => {
    const { document, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const base = document.records.properties.get('--dsw-alias-bg-base')
    expect(base, 'the scheme was never painted').toBeTruthy()

    // The presenter's pass, as it happens in the window: names removed, nothing put back.
    document.records.properties.delete('--dsw-alias-bg-base')

    // The repair observer is the one watching `body`, which is how the bundle installs it.
    const watcher = observers.find((observer) => observer.options?.attributeFilter?.includes('style'))
    expect(watcher, 'nothing is watching the body style').toBeTruthy()

    watcher.callback()
    expect(document.records.properties.get('--dsw-alias-bg-base')).toBe(base)
  })

  it('does nothing when the value is already right, so a paint cannot feed itself', async () => {
    // The repair runs on every style mutation, including this row's own 116 writes. It has
    // to be a no-op in that case or painting would loop.
    const { document, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const watcher = observers.find((observer) => observer.options?.attributeFilter?.includes('style'))
    const before = document.records.properties.get('--dsw-alias-bg-base')
    watcher.callback()
    watcher.callback()
    // Value unchanged and still present: the check short-circuited instead of repainting.
    expect(document.records.properties.get('--dsw-alias-bg-base')).toBe(before)
  })

  it('stops watching when the row is disposed', async () => {
    // A disposed row that kept observing would resurrect a palette the user has just moved
    // away from — or, worse, paint into a window whose plugin has been switched off.
    const { records, observers } = await applied({ payload: { ...payloadFor(['moss']), preference: 'moss' } })
    const watcher = observers.find((observer) => observer.options?.attributeFilter?.includes('style'))
    // Not every `ctx.effect` returns a disposer — a dictionary registration returns whatever
    // `register` does — so only the ones that do are called.
    for (const effect of records.effects) if (typeof effect.dispose === 'function') effect.dispose()
    expect(watcher.disconnected).toBe(true)
  })
})
