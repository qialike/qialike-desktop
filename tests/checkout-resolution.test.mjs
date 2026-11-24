/**
 * Resolving the two upstream checkouts.
 *
 * This became load-bearing when the repository moved out of the layout it was
 * developed in. Two failure modes are worth testing and one of them is silent:
 *
 *   · **Missing** — the sibling directory is not there. Noisy: the build stops.
 *   · **Wrong** — a candidate exists but is not the checkout, most dangerously
 *     when a directory named `qialike` holds *this* repository. The build would
 *     then read its own tree expecting the CLI's patches and app sources, and
 *     the failure would surface much later as a missing file inside the farm.
 *
 * Every case below builds a throwaway directory structure, so the resolution is
 * tested without depending on where the real checkouts happen to live.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TARGETS as SIGNING_TARGETS } from '../apps/desktop-bin/lib/signing.mjs'
import {
  DSH_HARNESS_ENV,
  DSH_QIALIKE_ENV,
  HARNESS_ROOT_PACKAGE_NAME,
  OWN_ROOT_PACKAGE_NAME,
  QIALIKE_ROOT_PACKAGE_NAME,
  TARGETS,
  harnessRoot,
  hostTarget,
  qialikeRoot,
  requireHostTarget,
  resolveCheckout,
} from '../apps/desktop-bin/lib/paths.mjs'

let sandbox

/** Write a directory holding a root manifest with the given package name. */
function makeCheckout(dir, name) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  return dir
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'qialike-paths-'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('resolveCheckout', () => {
  const spec = (overrides = {}) => ({
    label: 'thing',
    envVar: 'DSH_THING',
    expectedName: '@scope/thing-root',
    siblingDir: 'thing',
    layoutDir: join('deepseek', 'thing'),
    env: {},
    repoRoot: join(sandbox, 'repo'),
    home: join(sandbox, 'home'),
    ...overrides,
  })

  it('prefers an explicit environment variable', () => {
    const explicit = makeCheckout(join(sandbox, 'explicit'), '@scope/thing-root')
    makeCheckout(join(sandbox, 'repo', '..', 'thing'), '@scope/thing-root')
    expect(resolveCheckout(spec({ env: { DSH_THING: explicit } }))).toBe(explicit)
  })

  it('treats an empty variable as unset', () => {
    // The qialike CLI reads its own variable this way, and a CI that exports an
    // empty value means "no override", not "look in the empty path".
    const sibling = makeCheckout(join(sandbox, 'thing'), '@scope/thing-root')
    expect(resolveCheckout(spec({ env: { DSH_THING: '   ' } }))).toBe(sibling)
  })

  it('falls back to a sibling of this repository', () => {
    const sibling = makeCheckout(join(sandbox, 'thing'), '@scope/thing-root')
    expect(resolveCheckout(spec())).toBe(sibling)
  })

  it('falls back to the maintained development layout', () => {
    const layout = makeCheckout(join(sandbox, 'home', 'deepseek', 'thing'), '@scope/thing-root')
    expect(resolveCheckout(spec())).toBe(layout)
  })

  it('refuses this repository even when a candidate path holds it', () => {
    // The trap the move created: `../qialike` from `~/qialike` is the repository
    // itself. Identity, not existence, is what rejects it.
    const self = makeCheckout(join(sandbox, 'thing'), OWN_ROOT_PACKAGE_NAME)
    const message = (() => {
      try {
        resolveCheckout(spec())
      } catch (error) {
        return error.message
      }
      return ''
    })()
    expect(message).toContain('this is the qialike-desktop repository itself')
    expect(message).toContain(self)
  })

  it('refuses a directory that exists but is not the checkout', () => {
    makeCheckout(join(sandbox, 'thing'), '@scope/something-else')
    expect(() => resolveCheckout(spec())).toThrow(/declares "@scope\/something-else", expected "@scope\/thing-root"/)
  })

  it('refuses a directory with no manifest', () => {
    mkdirSync(join(sandbox, 'thing'), { recursive: true })
    expect(() => resolveCheckout(spec())).toThrow(/no package\.json/)
  })

  it('names every candidate and both remedies when nothing resolves', () => {
    let message = ''
    try {
      resolveCheckout(spec())
    } catch (error) {
      message = error.message
    }
    // The variable name is what the operator has to set; the sibling hint is the
    // alternative. A message with only one of them sends them looking in the
    // wrong place.
    expect(message).toContain('DSH_THING')
    expect(message).toContain('Candidates tried')
    expect(message).toContain('place one beside this repository')
  })

  it('does not repeat a candidate path tried twice', () => {
    // The sibling and the layout can name the same directory; listing it twice
    // makes the failure message look like two problems.
    const dir = makeCheckout(join(sandbox, 'thing'), '@scope/other')
    let message = ''
    try {
      resolveCheckout(spec({ layoutDir: '../thing' }))
    } catch (error) {
      message = error.message
    }
    const occurrences = message.split(dir).length - 1
    expect(occurrences).toBe(1)
  })
})

describe('which locations each checkout accepts', () => {
  /**
   * The two real resolvers, driven against a sandbox instead of this machine's layout.
   *
   * `harnessRoot`/`qialikeRoot` spread their options last, so `repoRoot` and `home` can be
   * redirected here — which is what makes these assertions about the *configured chains*
   * rather than about where the checkouts happen to live on the machine running the tests.
   */
  const at = () => ({ repoRoot: join(sandbox, 'repo'), home: join(sandbox, 'home') })

  it('refuses to find deepseek-harness in the old ~/deepseek layout', () => {
    // THE RESTRICTION, ASSERTED SO IT CANNOT BE UNDONE BY ACCIDENT. The harness has two
    // locations — the `DSH_HARNESS` variable, or a sibling of this repository — and the
    // layout fallback
    // was removed on purpose. A checkout placed at the old path must therefore NOT be
    // found, even though it is a valid checkout by identity.
    //
    // Why removal rather than a warning: when both locations hold a valid copy the sibling
    // simply wins, so nothing ever reports the duplicate. The fallback only fires once the
    // intended checkout disappears — at which point the build succeeds from a tree nobody
    // is looking at. Failing loudly is the honest outcome.
    makeCheckout(join(sandbox, 'home', 'deepseek', 'deepseek-harness'), HARNESS_ROOT_PACKAGE_NAME)
    expect(() => harnessRoot({}, at())).toThrow(/cannot find the deepseek-harness checkout/u)
    // And the message must not pretend to have looked somewhere it did not.
    let message = ''
    try {
      harnessRoot({}, at())
    } catch (error) {
      message = error.message
    }
    expect(message).toContain('Candidates tried')
    expect(message).not.toContain('maintained development layout')
  })

  it('still accepts a sibling deepseek-harness, and an explicit variable over any of it', () => {
    const sibling = makeCheckout(join(sandbox, 'deepseek-harness'), HARNESS_ROOT_PACKAGE_NAME)
    expect(harnessRoot({}, at())).toBe(sibling)

    const explicit = makeCheckout(join(sandbox, 'elsewhere'), HARNESS_ROOT_PACKAGE_NAME)
    expect(harnessRoot({ [DSH_HARNESS_ENV]: explicit }, at())).toBe(explicit)
    // Empty means unset, as the CLI reads it — not "look in the empty path".
    expect(harnessRoot({ [DSH_HARNESS_ENV]: '  ' }, at())).toBe(sibling)
  })

  it('keeps the ~/deepseek fallback for the qialike CLI, which is the asymmetry', () => {
    // THE OTHER HALF, and the reason the two resolvers differ. `../qialike` from this
    // repository is not a checkout — the module note records that the sibling rule once
    // resolved to this repository itself — so the CLI is normally found at `~/deepseek`.
    // Restricting it the way the harness is restricted would make the build fail for every
    // layout except the one this repository happens to be developed in.
    const layout = makeCheckout(join(sandbox, 'home', 'deepseek', 'qialike'), QIALIKE_ROOT_PACKAGE_NAME)
    expect(qialikeRoot({}, at())).toBe(layout)
  })
})

describe('release targets', () => {
  it('names every target so its prefix is a signing-policy key', () => {
    // THE INVARIANT THAT MAKES `split('-')[0]` LEGITIMATE. `package.mjs` derives the coarse
    // signing name from the target name by taking everything before the first dash, and the
    // signing policy is keyed by `linux` / `mac` / `win`. That holds for all four targets
    // today and would break silently if a target were ever named, say, `linux-musl-x64` or
    // `windows-x64` — the split would yield a key the policy does not have, and the decision
    // would come back "unknown target" for a target that is fine.
    for (const name of Object.keys(TARGETS)) {
      const prefix = name.split('-')[0]
      expect(SIGNING_TARGETS[prefix], `${name} → "${prefix}" is not a signing-policy key`).toBeDefined()
    }
  })

  it('are all describable, so a bad --target lists something useful', () => {
    // Every message that rejects a target prints this list, so a target without a platform
    // would produce a table entry nothing can build.
    for (const [name, entry] of Object.entries(TARGETS)) {
      expect(entry.platform, `${name} has no platform`).toBeTypeOf('string')
      expect(entry.arch, `${name} has no arch`).toBeTypeOf('string')
    }
  })

  it('fails loudly on a host that is not one of them, instead of a TypeError', () => {
    // WHAT THIS REPLACES, and it was measured rather than imagined. `package.mjs` used to do
    // `hostTarget().split('-')[0]` with no guard. There is no `linux-arm64` in the table, so
    // `pnpm run package:linux` on an arm64 machine — or any host outside the table — threw
    // `TypeError: Cannot read properties of undefined (reading 'split')`, which names neither
    // the host, nor the targets, nor the reason. `build.mjs` had the guard all along; this is
    // that guard, in the one place both callers can reach.
    //
    // The host cannot be faked in-process (it reads `process.platform`/`arch`), so the
    // message is asserted through a host that genuinely is not a target if one exists, and
    // the shape is asserted unconditionally.
    const host = `${process.platform}-${process.arch}`
    const isTarget = Object.values(TARGETS)
      .some((entry) => entry.platform === process.platform && entry.arch === process.arch)
    if (isTarget) {
      // On a release-target host the guard must stand aside.
      expect(requireHostTarget()).toBe(hostTarget())
    } else {
      expect(() => requireHostTarget()).toThrow(/is not a release target/u)
      let message = ''
      try {
        requireHostTarget()
      } catch (error) {
        message = error.message
      }
      // It names the host it saw and every target that exists — the two things a reader needs.
      expect(message).toContain(host)
      for (const name of Object.keys(TARGETS)) expect(message).toContain(name)
      // And it does NOT advertise `--target`, which cannot help: the prebuilds are not
      // cross-producible. `build.mjs` adds that hint itself because it takes the flag.
      expect(message).not.toContain('--target')
    }
  })
})

describe('the environment variable names', () => {
  it('are the exact strings the qialike CLI and its CI already use', () => {
    // THE VALUE IS A CONTRACT WITH A DIFFERENT REPOSITORY, so it is pinned here rather than
    // left to the constant's definition. The CLI's build reads `process.env.DSH_HARNESS` and
    // its CI sets that name (`qialike/.github/workflows/ci.yml`); the harness's own
    // `DSH_HOME_ENV = 'DSH_HOME'` is the same shape. Every other reference in this repository
    // now goes through the constant, which means a change to its *value* would otherwise be
    // invisible to this suite — every test would follow along, and only the other repository
    // would break.
    expect(DSH_HARNESS_ENV).toBe('DSH_HARNESS')
    expect(DSH_QIALIKE_ENV).toBe('DSH_QIALIKE')
  })

  it('are the keys the resolvers actually consult', () => {
    // The other half: a constant nothing reads is a comment. Redirecting the resolvers into a
    // sandbox that holds only an environment-named checkout proves each key is the one looked
    // up — so the pinned values above are the values that matter.
    const harnessNamed = makeCheckout(join(sandbox, 'env-named-harness'), HARNESS_ROOT_PACKAGE_NAME)
    expect(harnessRoot({ [DSH_HARNESS_ENV]: harnessNamed }, { repoRoot: join(sandbox, 'repo'), home: join(sandbox, 'home') }))
      .toBe(harnessNamed)
    const cliNamed = makeCheckout(join(sandbox, 'env-named-cli'), QIALIKE_ROOT_PACKAGE_NAME)
    expect(qialikeRoot({ [DSH_QIALIKE_ENV]: cliNamed }, { repoRoot: join(sandbox, 'repo'), home: join(sandbox, 'home') }))
      .toBe(cliNamed)
  })
})

describe('the real checkouts', () => {
  it('resolves deepseek-harness to a manifest identifying it', () => {
    const root = harnessRoot()
    expect(root).not.toBe(undefined)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(HARNESS_ROOT_PACKAGE_NAME)
  })

  it('resolves qialike to the CLI, never to this repository', () => {
    const root = qialikeRoot()
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(QIALIKE_ROOT_PACKAGE_NAME)
    // The specific hazard: a directory named `qialike` could hold the desktop
    // repository itself, and the build would then patch its own tree.
    expect(manifest.name).not.toBe(OWN_ROOT_PACKAGE_NAME)
  })
})
