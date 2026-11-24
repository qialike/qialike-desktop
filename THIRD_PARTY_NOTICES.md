# Third-Party Notices

qialike desktop is an Electron shell over the DeepSeek Harness browser surface. This file lists the
third-party packages **this repository adds directly** — the ones somebody here chose. It is not the
whole picture, and the rest is deliberately not restated:

- **The DeepSeek Harness core and everything it pulls in** are composed into the runtime tree from the
  harness checkout. That checkout's own `THIRD_PARTY_NOTICES.md` is the authoritative list for them,
  and none of it is duplicated here. Note that this document is **not** copied into the artifacts:
  what a shipped artifact carries is each package's own licence text, of which the runtime tree holds
  244 today. To know what an artifact contains, read the artifact.
- **The qialike CLI** is a read-only input as well. Two of its build-time patch modules are imported by
  path, and two of its policy modules are compiled into `packages/qialike-desktop-policy`. Both
  projects are MIT, so no separate notice is required here; its own notices live in its checkout.
- **`react` is not a direct dependency, on purpose.** The client bundles this repository hand-writes —
  in `-brand`, `-edit-follow`, `-providers` and `-theme` — each call `require('react')`, and it is
  resolved by the harness's client module loader from the frontend the harness builds. This repository
  declares no version of it and must not: the version that matters is the one the harness ships.

| Package | Version | License | Used for |
|---|---|---|---|
| [electron](https://www.electronjs.org) | 44.0.0 | MIT | The application shell: the window, the private application scheme, the preload bridge |
| [electron-updater](https://www.electron.build/auto-update) | 6.8.9 | MIT | Checking for, downloading and applying updates, when a feed was configured at build time |
| [electron-builder](https://www.electron.build) | 26.15.3 | MIT | Packaging the AppImage and the deb |
| [semver](https://github.com/npm/node-semver) | 7.8.5 | ISC | Comparing each checkout's version against the range the build enforces |
| [TypeScript](https://www.typescriptlang.org) | 6.0.3 | Apache-2.0 | Compiling the shell, the Host, the bundle and the provider rows |
| [vitest](https://vitest.dev) | 3.2.7 | MIT | The test suite |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 24.19.0 | MIT | Node typings, at compile time only |

**Only `electron-updater` ships.** It is the single runtime dependency this repository declares;
`electron` itself is provided by the packaging step rather than taken from `node_modules`, and the
other five are build- or test-time only. Versions are what the lockfile resolves today —
`pnpm-lock.yaml` is what decides, and a major version moving is a reason to revisit this table.

Licence texts are not reproduced here. Each package ships its own in `node_modules`, and those are
what the artifacts carry; this file is the map, not a substitute.

## How this differs from the CLI

The CLI's notice file lists `ink`, `react`, `commander`, `esbuild`, `js-yaml` and Bun. None of those
is a direct dependency here, and that is the product difference rather than an omission: this
application renders the harness's **browser** surface inside Electron instead of drawing a terminal
interface, and it is packaged by `electron-builder` rather than compiled into one executable by
`bun build --compile`.
