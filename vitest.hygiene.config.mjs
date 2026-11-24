/**
 * The part of the suite that runs without either upstream checkout.
 *
 * WHY THIS CONFIG EXISTS. The full suite includes a handful of suites that read the two read-only
 * checkouts this application is composed from, or read files the build generates from them. Those are
 * the right tests to have, and they are not runnable on a fresh clone: the harness and the CLI have to
 * be cloned, placed beside this repository, built, and inside the version range the build enforces.
 *
 * CI deliberately does not pay that cost. It runs the suites that need only this repository, so a
 * contributor's first pull request gets a verdict in minutes rather than after two upstream builds.
 * This file is that selection, written once and callable locally — `pnpm run test:hygiene` — so what
 * CI runs is not a second, private command line that can drift from what a contributor can reproduce.
 *
 * WHAT IS EXCLUDED, AND WHY. Each of these needs at least one of the checkouts (`harnessRoot()` or
 * `qialikeRoot()`) or a built runtime tree:
 *
 *   · `checkout-resolution` — proves the real layouts resolve, so it reads the real checkouts.
 *   · `client-tokens`       — reads the harness's compiled client bundles.
 *   · `cli-policy`          — compiles policy modules out of the CLI checkout.
 *   · `harness-farm`        — copies packages out of both checkouts.
 *   · `harness-version`     — reads the harness checkout's manifest as its fallback fixture.
 *   · `theme-legibility`    — reads the harness's token declarations, and the CLI's palettes.
 *   · `theme-schemes`       — proves every scheme token exists upstream, in both checkouts.
 *   · `theme-host`          — imports `packages/qialike-desktop-theme/lib/palettes.js`, which
 *                             `pnpm run build` generates from the CLI checkout.
 *
 * Everything else is expected to pass on a clean clone after `pnpm install` and
 * `pnpm run build:packages`. Suites that need the assembled runtime tree skip themselves when
 * `dist/runtime/dsh` is absent, which it is in CI — they are not excluded here because their
 * repository-facing assertions still run.
 *
 * ADDING A TEST THAT NEEDS A CHECKOUT: exclude it here and say why, in the list above. Removing an
 * entry is only correct once the test no longer reads either checkout.
 *
 * @module qialike-desktop/vitest.hygiene.config
 */

import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config.mjs'

export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: [
      // Vitest's own defaults first, so `node_modules` and friends stay excluded.
      ...configDefaults.exclude,
      'tests/checkout-resolution.test.mjs',
      'tests/client-tokens.test.mjs',
      'tests/cli-policy.test.mjs',
      'tests/harness-farm.test.mjs',
      'tests/harness-version.test.mjs',
      'tests/theme-legibility.test.mjs',
      'tests/theme-schemes.test.mjs',
      'tests/theme-host.test.mjs',
    ],
  },
}))
