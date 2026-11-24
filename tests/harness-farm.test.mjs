/**
 * The package farm and its gates.
 *
 * These run against the **real** harness checkout rather than fixtures, because
 * what they check is a property of that checkout: which packages exist, whether
 * the native prebuilds were built, and whether the anchor files the three
 * patches target are still shaped the way the patches expect. A fixture would
 * only prove the fixture works.
 *
 * The suite skips itself when no checkout is present, so a contributor without
 * one still gets the unit tests.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_NON_MIT_SDK_PACKAGES,
  NATIVE_ENTRY_PACKAGE,
  NATIVE_PLATFORM_PREFIX,
  SCAN_ROOTS,
  externalDependencies,
  flattenPackageName,
  nativePlatformPackage,
  readPrebuilds,
  scanPackages,
  stripSourceExports,
  verifyNativeBinaries,
} from '../apps/desktop-bin/lib/harness-farm.mjs'
import { FARM_DIR, harnessRoot, qialikeRoot } from '../apps/desktop-bin/lib/paths.mjs'
import * as profileBundles from '../apps/desktop-bin/gates/profile-bundles.mjs'
import * as uiFreeShared from '../apps/desktop-bin/gates/ui-free-shared.mjs'

const harness = harnessRoot()
const harnessPresent = existsSync(join(harness, 'package.json'))
// The gates need a composed farm; the farm tests only need the checkout.
const farmPresent = existsSync(FARM_DIR)

describe.skipIf(!harnessPresent)('scanPackages', () => {
  it('finds harness packages across all three scan roots', () => {
    const found = scanPackages(harness)
    expect(found.size).toBeGreaterThan(100)
    // The CLI's scanner stops at vendor/ and packages/; the native tree is the
    // root this application adds, and losing it would drop every prebuild.
    for (const root of SCAN_ROOTS) {
      const fromRoot = [...found.values()].filter((entry) => entry.group === root)
      expect(fromRoot.length, `no packages found under ${root}/`).toBeGreaterThan(0)
    }
  })

  it('includes the native platform packages the CLI never scans', () => {
    const found = scanPackages(harness)
    expect(found.has(NATIVE_ENTRY_PACKAGE)).toBe(true)
    for (const name of found.keys()) {
      if (!name.startsWith(NATIVE_PLATFORM_PREFIX) || name === NATIVE_ENTRY_PACKAGE) continue
      expect(name).toMatch(/^@deepseek-ai\/node-addon-system-(darwin|linux)-(arm64|x64)$/)
    }
  })

  it('never carries a non-MIT SDK package', () => {
    const found = scanPackages(harness)
    for (const excluded of EXCLUDED_NON_MIT_SDK_PACKAGES) {
      expect(found.has(excluded)).toBe(false)
    }
  })

  it('reports a checkout whose layout moved instead of returning nothing', () => {
    expect(() => scanPackages('/nonexistent-checkout')).toThrow(/no vendor\/ directory/)
  })
})

describe('nativePlatformPackage', () => {
  it('names the platform package for a target', () => {
    expect(nativePlatformPackage('linux', 'x64')).toBe('@deepseek-ai/node-addon-system-linux-x64')
    expect(nativePlatformPackage('darwin', 'arm64')).toBe('@deepseek-ai/node-addon-system-darwin-arm64')
  })
})

describe('stripSourceExports', () => {
  it('removes /src subpaths and their targets', () => {
    const manifest = {
      exports: {
        '.': './lib/index.js',
        './src/*': './src/*',
        './types': { default: './lib/types/index.d.ts' },
        './other': { default: './src/other.ts' },
      },
    }
    expect(stripSourceExports(manifest)).toBe(2)
    expect(Object.keys(manifest.exports)).toEqual(['.', './types'])
  })

  it('leaves a manifest with no exports alone', () => {
    const manifest = {}
    expect(stripSourceExports(manifest)).toBe(0)
    expect(manifest).toEqual({})
  })
})

describe('flattenPackageName', () => {
  it('produces a filesystem-safe directory name', () => {
    expect(flattenPackageName('@deepseek-ai/dsh-sandbox')).toBe('-deepseek-ai-dsh-sandbox')
  })
})

describe.skipIf(!farmPresent)('the composed farm', () => {
  it('pruned every foreign native platform package', () => {
    const found = readPrebuilds(FARM_DIR, process.platform, process.arch)
    if (found === undefined) return // the host is not a release target; build.mjs refuses earlier
    const entries = readdirNames(FARM_DIR)
    const foreign = entries.filter((name) => {
      const manifest = join(FARM_DIR, name, 'package.json')
      if (!existsSync(manifest)) return false
      const packageName = JSON.parse(readFileSync(manifest, 'utf8')).name ?? ''
      return packageName.startsWith(NATIVE_PLATFORM_PREFIX)
        && packageName !== nativePlatformPackage(process.platform, process.arch)
    })
    expect(foreign).toEqual([])
  })

  it('keeps the native entry package that fans out to the prebuilds', () => {
    const manifest = join(FARM_DIR, flattenPackageName(NATIVE_ENTRY_PACKAGE), 'package.json')
    expect(existsSync(manifest)).toBe(true)
  })

  it('carries no node_modules or tsbuildinfo from the checkout', () => {
    for (const name of readdirNames(FARM_DIR).slice(0, 40)) {
      expect(existsSync(join(FARM_DIR, name, 'node_modules'))).toBe(false)
    }
  })

  it('records a non-empty external dependency closure', () => {
    const external = externalDependencies(FARM_DIR)
    expect(external.length).toBeGreaterThan(0)
    // Harness packages are the farm's own layer, never "external".
    expect(external.some((name) => name.startsWith('@deepseek-ai/'))).toBe(false)
  })

  it('verifyNativeBinaries reports what a partial native build is missing', () => {
    // Not asserted to be empty: this checkout is legitimately mid-build, and the
    // build is expected to *report* that rather than pretend. What is asserted is
    // that each gap names a real declared binary and a remedy the operator can run.
    const missing = verifyNativeBinaries(FARM_DIR, process.platform, process.arch)
    for (const entry of missing) {
      expect(entry.path).toMatch(/^bin\//)
      expect(entry.reason).toMatch(/declared in prebuilds\.json|not in the farm/)
    }
  })

  it('verifyNativeBinaries reports a target with no native package at all', () => {
    const missing = verifyNativeBinaries(FARM_DIR, 'sunos', 'sparc')
    expect(missing).toHaveLength(1)
    expect(missing[0].reason).toMatch(/not in the farm at all/)
  })

  it('does not require the POSIX addon on win32, which binds kernel32 through koffi', () => {
    // Windows has no native prebuild and cannot have one: the addon is `flock(2)`
    // plus a Landlock launcher, and on win32 the session lock and the atomic
    // publishes go through `session-persistence-jsonl/src/win32.ts` (koffi ->
    // `CreateSemaphoreW` / `MoveFileExW`) instead. The harness's own release matrix
    // lists only linux-x64, linux-arm64, darwin-x64 and darwin-arm64, and
    // `native/system/scripts/github-matrix.mjs` throws for any other platform — so
    // "no `prebuilds.json` at all" here means "not built for this platform", not
    // "an unbuilt checkout", and the build must not refuse the one target the
    // application is otherwise ready to produce.
    expect(verifyNativeBinaries(FARM_DIR, 'win32', 'x64')).toEqual([])
  })

  it('still refuses a platform that is merely absent from that matrix', () => {
    // THE GUARD ON THE GUARD. The win32 exemption is a named list, deliberately not
    // "whatever has no prebuilds.json": freebsd is absent from the matrix too, but
    // `lease.ts` takes the POSIX path there, so the addon genuinely is required and
    // its absence must stay fatal. Without this, the exemption could quietly become
    // a general "a missing native package is fine" rule.
    const missing = verifyNativeBinaries(FARM_DIR, 'freebsd', 'x64')
    expect(missing).toHaveLength(1)
    expect(missing[0].reason).toMatch(/not in the farm at all/)
  })

  it('applied all three patches to the farm', () => {
    const sandbox = readFileSync(join(FARM_DIR, '-deepseek-ai-dsh-sandbox/lib/index.js'), 'utf8')
    expect(sandbox).toContain('qialike: Windows grants the workspace root alone')

    const policy = readFileSync(join(FARM_DIR, '-deepseek-ai-dsh-sandbox-policy/lib/index.js'), 'utf8')
    expect(policy).toContain('writableRoots(policy)')

    const sandboxLocal = readFileSync(join(FARM_DIR, '-deepseek-ai-dsh-sandbox-local/lib/index.js'), 'utf8')
    expect(sandboxLocal).toContain('sweepStaleTempEntries')
  })
})

describe('profile-bundles gate', () => {
  it.skipIf(!farmPresent)('accepts the composed profile against the real farm', () => {
    const result = profileBundles.run(FARM_DIR)
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects a farm that lacks a bundle', () => {
    const violations = profileBundles.checkProfileBundles('/nonexistent-farm')
    expect(violations.length).toBeGreaterThan(0)
  })
})

const qialike = qialikeRoot()
const qialikePresent = existsSync(join(qialike, 'packages/qialike-app/src/llm.ts'))

describe('ui-free-shared gate', () => {
  it.skipIf(!qialikePresent)('passes against the real shared modules', () => {
    const result = uiFreeShared.run()
    expect(result.violations).toEqual([])
  })

  it('extracts every import form', () => {
    const specifiers = uiFreeShared.importSpecifiers([
      "import { a } from 'one'",
      "import 'two'",
      "export { b } from 'three'",
      "const c = await import('four')",
      "const d = require('five')",
    ].join('\n'))
    expect(specifiers).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  it('treats a lazily imported UI module as a violation', () => {
    // The point of scanning source rather than output: a dynamic import of a
    // panel would still pull Ink into the host process.
    expect(uiFreeShared.FORBIDDEN_SPECIFIERS.has('ink')).toBe(true)
    expect(uiFreeShared.FORBIDDEN_SPECIFIERS.has('@qialike/qialike-app/panels-models')).toBe(true)
  })
})

/** Directory names directly under a path. */
function readdirNames(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}
