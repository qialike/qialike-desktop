# Upstream notes: things worth telling deepseek-harness, and things worth not

This file exists because two categories of finding have nowhere else to live. The first is a **contract
that is real, load-bearing and undocumented** — a bug waiting for its second implementer. The second is a
**deliberate upstream decision that a product integrating with it will trip over** — not a bug, and
reported as such so it is not dismissed as one.

Nothing here has been filed. Both entries are drafts, kept in the repository so the evidence survives the
session that gathered it.

Gathered against deepseek-harness **0.1.7-rc.2**, and **re-verified against 0.2.0-rc.2** when this
repository moved its gate to that release. Both still hold:

- **Note 1** — `apps/web/src/main.ts` still gates the desktop branch on `globalThis.dshDesktopBoot`
  (line 11), and still sets `__DSH_TRANSPORT__` only inside it (line 26).
- **Note 2** — `packages/client/ui-theme/src/styles/design-platform.css` still pins the tooltip and
  toast surfaces to the static bluish ramp (`--dsw-static-neutral-bluish-850` / `-800` backgrounds,
  `-00` label) in both the light and the dark block, so the pair is still fixed dark in every theme.

---

## 1. `dshDesktopBoot` is an undocumented, load-bearing global — and its absence is silent

**Category**: bug (an undeclared interface). **Severity**: silent loss of the client's live connection.

### What happens

`apps/web/src/main.ts` is the Web client's browser entry. It contains one desktop branch:

```ts
interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
...
if (desktop !== undefined) {
  ...
  void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
    const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
    transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
    await applyIndexInjections(injections, ...)
    gate.resolve()
  }).catch((error: unknown) => { gate.reject(error) })
}
```

**That branch is the only place a shell-owned page gets `__DSH_TRANSPORT__`.** A shell that exposes its
bridge under any other name takes the `desktop === undefined` path, so:

- `__DSH_TRANSPORT__` is never set, and
- the injection rows are never applied by this code, and
- **nothing reports any of it.** The entry runs `entry.run(undefined)`, the page renders, HTTP works.

The client's stream carrier then resolves its WebSocket against the fallback:

```ts
// packages/api/gateway/src/client/stream-client.ts
const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
```

`document.baseURI` is the shell's own document origin. For a desktop shell serving a custom scheme that is
an origin no socket can reach, so the carrier retries forever behind a window that renders correctly and
shows "Reconnecting...".

### Why `__DSH_TRANSPORT__.streamBaseUrl` being documented is not enough

`packages/client/connection/README.md` documents the global itself:

> A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned
> Host.

and `apps/desktop/README.md` describes the concept without the name:

> The application preload exposes boot readiness, fatal startup reporting, native directory selection, …

Neither says **which global name** the Web entry looks for. `grep -rn dshDesktopBoot` over `*.md` and
`*.json` across the checkout returns nothing. The name is therefore discoverable only by reading
`apps/web/src/main.ts`, and a shell that does not read it has no way to learn it exists — there is no error,
no warning and no missing-feature symptom, only a connection that never opens.

### How it was found, in case it is useful as a reproduction

A shell that reuses the upstream-built `index.html` and its content-hashed assets (rather than authoring
its own entry) named its own preload bridge `qialikeDesktopBoot`, and set `__DSH_TRANSPORT__` from its own
injected bootstrap so the rows would still be applied. The measurements, from a packaged AppImage on Ubuntu
22.04, DevTools protocol:

```
# the client's own console, repeating every backoff interval
[error]   WebSocket connection to 'ws://127.0.0.1:41561/api/remote.mux' failed:
[warning] [connection] connection lost, retry #6        (through #10)
# a direct handshake to the same URL, from the page: closed, code 1006
# the Host's answer to the unrepaired handshake is 403 (its trust fence requires a credential)
```

Before the shell set the global itself, `__DSH_TRANSPORT__` was `undefined` and the carrier's resolved URL
was `qialike-app://app/api/remote.mux`.

### What would fix it, in preference order

1. **Have the Connection service derive the transport from what the shell declares**, rather than the app
   entry keying off a global by name. The shell already has to provide `streamBaseUrl` through
   `dshDesktopBoot.ready()`; the entry is only forwarding it into a global that a *package* then reads. If
   `packages/client/connection` accepted `ownsHost`/`streamBaseUrl` through the injected page global that a
   shell can set directly, the name of the shell's bridge would stop mattering.
2. **Fail loudly when a shell-owned page has no transport.** The entry can tell that it is running in a
   shell (it was loaded from a document whose origin is not `http(s)`), so `entry.run(reportFailure)` with a
   carrier-less page is a state it could report instead of entering.
3. **At minimum, document the name** — `apps/desktop/README.md` is the natural place, and it already
   describes the rest of the boot contract.

Option 3 is the smallest and would have cost us an afternoon instead of a session.

### What we did meanwhile

Set `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }` from our own injected bootstrap, mirroring the
entry's branch, and assert it in a window (`apps/desktop-bin/e2e.mjs`). Renaming our bridge to
`dshDesktopBoot` would wake the branch and then apply the rows and resolve the gate a second time, so the
clean shape — adopting the harness's entry wholesale and deleting our interpreter — is recorded as
follow-up rather than attempted here.

---

## 2. For theme authors: the tooltip and the toast are dark in every theme, with fixed labels

**Category**: documentation gap for integrators. **Not a bug** — upstream states the intent in its own
comments, and the decision is sound.

`ui-primitives/src/Tooltip.module.css` pairs an *alias* surface with a *static* label:

```css
background: var(--dsw-alias-tooltip-bg);        /* dark in both themes */
color: var(--dsw-static-neutral-bluish-00);     /* white, never flips */
```

and `ui-primitives/src/Toast.module.css` says so outright:

> The design platform's toast surface is dark in BOTH themes (bluish-800 light / bluish-750 dark), so the
> label and the action text below stay fixed instead of flipping with the theme.

A theming layer that repaints `--dsw-alias-*` surfaces — which is the intended way to theme this client —
will therefore **invert that pair** the first time it maps the tooltip surface to a light rung. Measured on
our side, mapping it to the palette's `panel` produced **1.14:1** in One Light and **1.23:1** in Solarized
Light: a near-white rectangle carrying white text, on a surface that only appears on hover, so it is in no
screenshot and no static scan.

**The asymmetry is what makes it a trap**: the surface is an alias (so it *looks* themeable) while the label
is static (so it is not). Two ways to close it, both cheap:

1. Tokenise the labels (`--dsw-alias-tooltip-label`, `--dsw-alias-toast-label` already exists for the toast)
   so the pair is either both themeable or neither.
2. Or state the invariant where a theme author will read it — `ui-theme`'s own token documentation — that
   these two surfaces and their labels must be moved together.

Our side is fixed and asserted (`FIXED_DARK_SURFACES`, `tests/theme-legibility.test.mjs`), and the four
tokens are now deliberately unmapped, which restores upstream's own 13.94:1 / 12.10:1 (light) and 9.59:1
(dark) pairs.

### A related observation, reported without a recommendation

Two fills that carry a **fixed white glyph** *are* ours to repaint, because they are pure aliases:
`--dsw-alias-button-info-fill` (the composer's send button) and `--dsw-alias-state-error-primary` (the
failed-attachment badge). Mapping them to a scheme's `info`/`error` role reaches **1.49:1** against the
white glyph in the palest dark schemes — against upstream's own worst of **2.16:1** for the same glyph on
its dark-theme `deepseek-400`. So the same class of pair exists here with a much smaller error, and it is
not obvious whether upstream would consider a white glyph on a pale accent a defect or a design choice. No
recommendation is attached.
