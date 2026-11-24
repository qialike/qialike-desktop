# Contributing

English | [中文](CONTRIBUTING.zh.md)

This repository is the **qialike desktop application**: a desktop agent built on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It is released under the
[MIT](LICENSE) licence. Supported systems: Linux and Windows, any model, plugin-based design.
**Users do not need to build** — install the released AppImage, deb or Windows installer, as
described in [README.md](README.md).

## Before you start

**This repository is one of three, and it may not write in the other two.** The application is
composed from two upstream checkouts — a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) checkout and the qialike CLI
checkout — and both are **read-only inputs**. Anything this repository wants changed in them is
applied as a patch at build time, to a farm copied under `.farm/` (see "The patch layer"). A change
that writes inside either checkout is a defect, however convenient it is locally.

**Two of the guides live outside this repository**, beside it in `docs/desktop/`, because they record
rejected alternatives and superseded decisions — not something a checkout of the code should carry:

| Document | What it owns |
|---|---|
| `../docs/desktop/DESIGN.md` | why this is a layer over the harness browser surface rather than a rewrite, and which parts of the CLI are reused versus reimplemented |
| `../docs/desktop/qialike-desktop-dev.md` | building, packaging and shipping per platform, the release scripts, the engineering notes, and the measurements behind the trade-offs |

## Build

Prerequisites:

- **Node.js `^22.19.0 || >=24.0.0`** and **pnpm `11.28.5`**, the latter pinned in `packageManager`.
  The Node floor is the harness's own.
- **Both upstream checkouts, already built.** The build reads each one's built output and fails
  without it: run `pnpm install && pnpm build` in the harness checkout first, and build the CLI too.
- Both must fall inside the version range this repository enforces. **The range's single source of
  truth is `apps/desktop-bin/lib/harness-version.mjs`** — `HARNESS_VERSION_MIN`,
  `HARNESS_VERSION_MAX`, and the CLI's own ceiling beside them. Read it there rather than trusting a
  number written in a document, including this one, and raise it only after validating against the
  new release.
- **The CLI checkout must be the exact release `CLI_VERSION` names**, also in
  `harness-version.mjs`. Unlike the harness, the CLI is not adapted to: its built output is copied
  into the runtime tree, so the build refuses a checkout at any other version rather than shipping a
  provider layer nobody checked. A version string alone is not enough — `lib/` is what gets copied,
  so the checkout must have been built at that release.
- **For a Windows target, nothing extra to install.** The bundled Office engine imports five MSVC
  runtime DLLs that Windows does not supply, and they are read out of the engine binary at build
  time and recorded in the runtime descriptor — not shipped. The shell checks at startup whether the
  engine can start and tells the user to install the Visual C++ 2015-2022 Redistributable (x64) when
  it cannot. See `apps/desktop-bin/lib/vc-runtime.mjs` and `apps/desktop/src/office-runtime.ts`.

The checkouts are located in this order, and nothing is ever written inside either:

| Checkout | Variable | Default |
|---|---|---|
| DeepSeek Harness | `DSH_HARNESS` | `../deepseek-harness` |
| qialike CLI | `DSH_QIALIKE` | `../qialike`, then `~/deepseek/qialike` |

`apps/desktop-bin/lib/paths.mjs` is the contract — read it rather than reproducing the chain from
memory, and note that an **empty** variable means "unset".

```sh
pnpm install
cp .env.example .env.local  # optional: the checkouts, store, feed and signing settings
pnpm run build:packages   # compile the bundle, the provider rows, the Host and the shell
pnpm run build            # compose the farm and assemble the runtime tree
pnpm run gates            # the three build gates
pnpm test
pnpm run typecheck
pnpm run package:linux    # AppImage + deb into dist/packages/ (package:mac / package:win elsewhere)
```

**Nothing reads `.env.local` automatically** — load it into the shell (`set -a; . ./.env.local; set +a`)
or export the variables directly. `.env.example` documents every variable and its default; the two
that matter for a first build are `DSH_HARNESS` and `DSH_QIALIKE`, and they are only needed when the
checkouts are not siblings of this repository.

**`pnpm install` and `pnpm run build:packages` need neither upstream checkout.** Everything from
`pnpm run build` onward does, which is the line CI draws: it can compile and type-check a fresh clone,
then run the part of the suite that reads only this repository.

**The farm is a copy**, and `pnpm run build` **replaces `dist/runtime/dsh`** — if the application is
running when you rebuild, the rebuild interrupts it.

**Packaging is per-platform and refuses to run anywhere else**, because the native components cannot
be cross-produced: `package:mac` off macOS fails by policy, not by accident.

## Tests and checks

| Command | What it does |
|---|---|
| `pnpm test` | The full suite — unit and integration, run by vitest; needs both checkouts built |
| `pnpm run test:hygiene` | The part of the suite that needs neither checkout — what CI runs |
| `pnpm run typecheck` | Type-checks the workspace |
| `pnpm run gates` | Three build gates: the shared UI is not forked, the profile bundles are complete, the runtime tree is what it claims to be |
| `pnpm run test:boot` | The profile-boot path on its own |

The gates are worth understanding rather than treating as a formality: the ways a composed runtime
tree can be wrong are exactly the ways that still look fine.

**CI runs `pnpm run typecheck` and `pnpm run test:hygiene`** (`.github/workflows/ci.yml`), and both
are reproducible from a fresh clone after `pnpm install` and `pnpm run build:packages`. The suites
`test:hygiene` leaves out are the ones that read a checkout or a file the build generates from one;
`vitest.hygiene.config.mjs` names each and says why. That is the whole of the remote gate — patch
anchors, theme tokens, the farm, the assembled runtime tree and anything needing a packaged artifact
are **not** checked there.

Further verification — the release chain, and the probes that need a real window — is driven by
scripts that live **outside this repository**, beside it in `scripts/desktop/`. They are deliberately
not in version control: they are this machine's tooling, not the product. The development guide
documents them, including which probes the test suite already covers.

## The patch layer

Everything this repository changes in an upstream checkout is applied by
`apps/desktop-bin/lib/apply-patches.mjs` **to the farm copy**, never to the checkout. There are seven
patches, and they come from two places:

- **two are the CLI's own**, read out of its `apps/tui-bin/harness-patches/` and imported by path, so
  that both products edit the shared engine identically instead of each keeping a copy that drifts.
  They are the security-relevant pair about the confined token's reach and the prompt sentence derived
  from it, and they must be applied together: the second generates that sentence from a live call to
  the function the first narrows.
- **five are authored here**: the Windows writable-roots narrowing, the application scheme, the brand
  title, the hero headline, and the session-list parity change.

The count and the list are the `applied[...]` assignments in that module, not this paragraph — an
earlier version of that module's own header said "five" and had been wrong for two patches' worth of
history. A patch whose anchor has moved **fails the build** rather than shipping a silently
unpatched boundary, which is the point of doing it here instead of by hand.

## Contributions

- **Licence**: contributions are accepted under the [MIT](LICENSE) licence that covers this
  repository (inbound = outbound). By opening a pull request you confirm you have the right to submit
  the work on those terms; there is no separate CLA to sign.
- **Security**: do **not** open a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
- **Commits**: Conventional Commits — `type(scope): subject`, with `!` after the type or scope for a
  breaking change. Keep a change reviewable on its own.
- **Dependencies**: if you add one, add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the
  same change. Nothing enforces that file, so nothing will remind you.
- **User-visible changes**: add one line to `CHANGELOG.md` **and** `CHANGELOG.zh.md`. The two
  languages must list the same number of change points, and `tests/changelog-format.test.mjs` holds
  the newest section to the format — one line each, the change point in bold first, no commit hashes.

## Repository layout

```
apps/desktop/           the Electron shell: main, preload, the application scheme, the window
apps/desktop-host/      the Host process the shell boots and supervises
apps/desktop-bin/       tooling: build, package, gates, probes, and the paths/version contract
apps/desktop-web/       our half of the served page: the document, the stylesheet, the brand assets
packages/qialike-desktop-app/          the bundle: layered over dsh-base + dsh-web-app
packages/qialike-desktop-providers/    the provider rows and the settings page
packages/qialike-desktop-brand/        the mark, the wordmark, and the seats they occupy
packages/qialike-desktop-policy/       the CLI's policy modules, compiled in
packages/qialike-desktop-theme/        the colour schemes
packages/qialike-desktop-edit-follow/  follow-the-edited-file
tests/                  the suite, run by `pnpm test`
docs/                   notes about upstream that its own checkout does not record
```

That is a map, not an inventory: `pnpm-workspace.yaml` is what decides which packages exist.
