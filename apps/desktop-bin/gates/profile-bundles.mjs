/**
 * Gate: the composed profile's bundle layers must be resolvable and must not
 * collide with another product's profile.
 *
 * Three things can go wrong here, and all three are silent at runtime:
 *
 *  1. A bundle name in {@link PROFILE_BUNDLES} that no farm package provides.
 *     Cordis reports a missing bundle by skipping it, so the profile boots with
 *     a layer missing and the only symptom is absent functionality.
 *  2. A bundle that does not declare `dsh.bundle.patch`. Without that manifest
 *     field the package is a normal dependency and contributes no rows, so the
 *     layer is inert.
 *  3. A profile name that another product already owns. The official Electron
 *     shell owns `profiles/desktop` and the CLI owns `profiles/tui`; sharing one
 *     would let two applications race on the same installed plugin set and
 *     lockfile (DESIGN §3, upstream's "State ownership" decision).
 *
 * @module qialike-desktop/gates/profile-bundles
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_BUNDLES, PROFILE_NAME, ROOT } from '../lib/paths.mjs'

/**
 * Where a bundle layer can come from.
 *
 * The composed profile resolves its bundles from two places, exactly as the
 * runtime does: the farm, which carries the harness's own packages, and this
 * repository's workspace packages, which carry ours. Checking only the farm
 * would report our own bundle as missing; checking only the workspace would miss
 * the harness ones.
 */
function bundleLocations(farmDir) {
  const locations = new Map()
  if (farmDir !== undefined && existsSync(farmDir)) {
    for (const entry of readdirSync(farmDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(farmDir, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') locations.set(manifest.name, join(farmDir, entry.name))
    }
  }
  const workspace = join(ROOT, 'packages')
  if (existsSync(workspace)) {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(workspace, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') locations.set(manifest.name, join(workspace, entry.name))
    }
  }
  return locations
}

/**
 * Profile names owned by products this application ships beside.
 *
 * Both may be present on the same machine at the same time and share
 * `$DSH_HOME`, so a collision here is a correctness problem rather than a
 * cosmetic one.
 */
export const FOREIGN_PROFILE_NAMES = new Set([
  'desktop', // the official @deepseek-ai/dsh-desktop shell
  'tui', // the qialike CLI
  'web', // `dsh web`
  'acp',
  'sdk',
  'sdk-minimal',
  'headless',
])

/**
 * Check the composed profile against a farm.
 *
 * @param farmDir - the farm root.
 * @returns one violation per problem, empty when clean.
 */
export function checkProfileBundles(farmDir) {
  const violations = []
  const locations = bundleLocations(farmDir)

  if (FOREIGN_PROFILE_NAMES.has(PROFILE_NAME)) {
    violations.push({
      detail: `the profile name ${JSON.stringify(PROFILE_NAME)} belongs to another product; `
        + 'sharing it would let two applications race on one installed plugin set.',
    })
  }
  if (PROFILE_BUNDLES.length === 0) {
    violations.push({ detail: 'PROFILE_BUNDLES is empty, so the profile would compose nothing.' })
  }

  for (const name of PROFILE_BUNDLES) {
    const dir = locations.get(name)
    if (dir === undefined) {
      violations.push({
        detail: `the bundle ${name} resolves from neither the farm nor this workspace's packages/. `
          + 'A missing bundle is skipped at boot, so the profile would start with that layer '
          + 'silently absent.',
      })
      continue
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const patch = manifest.dsh?.bundle?.patch
    if (patch === undefined) {
      violations.push({
        detail: `${name} declares no dsh.bundle.patch, so it contributes no rows and is an inert layer.`,
      })
      continue
    }
    // The patch field is a single path or a list of layers applied in order.
    const patchPaths = Array.isArray(patch) ? patch : [patch]
    for (const patchPath of patchPaths) {
      if (!existsSync(join(dir, patchPath))) {
        violations.push({
          detail: `${name} declares dsh.bundle.patch ${patchPath}, which does not exist beside its manifest.`,
        })
      }
    }
  }
  return violations
}

/**
 * Gate entry point.
 * @param farmDir - the farm root.
 * @returns `{ ok, violations }`.
 */
export function run(farmDir) {
  const violations = checkProfileBundles(farmDir)
  return { ok: violations.length === 0, violations }
}

/** Render the gate result for a CLI run. */
export function format(result) {
  if (result.ok) return 'profile-bundles: ok'
  return ['profile-bundles: FAILED', ...result.violations.map((v) => `  - ${v.detail}`)].join('\n')
}
