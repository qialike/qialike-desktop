/**
 * The compiled CLI policy modules, and the shell fences they carry.
 *
 * WHAT THIS COVERS THAT THE PROFILE PROBE CANNOT. `policy-surface.test.mjs` boots
 * the real profile and proves the rows are *mounted* — that a credential read is
 * denied through the live pipeline. What it cannot reach is the shell half: those
 * decisions depend on the effective sandbox mode, which in a live session comes
 * from a session's log, and constructing one would test the harness's session
 * plumbing rather than this product's wiring.
 *
 * WHY THE CLI'S FUNCTIONS ARE TESTED HERE AT ALL. They are not ours, but the
 * *reliance* is: this product mounts them, on a plane the CLI does not use, with the
 * mode resolved from a different service. That makes three things worth pinning:
 *
 *   · the fences still behave as documented, so a rule change upstream surfaces as a
 *     failing test here rather than as a silently weaker boundary;
 *   · the compiled artifact carries **no runtime import** — the property that makes
 *     compiling them safe, and the one that would drag `ink` into the Host if the
 *     CLI ever added a non-type import;
 *   · the committed compile step is deterministic, so the generated file cannot
 *     drift from the sources it claims to come from.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileCliPolicy } from '../apps/desktop-bin/lib/cli-policy.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'
import { qialikeRoot } from '../apps/desktop-bin/lib/paths.mjs'

const LIB = join(ROOT, 'packages', 'qialike-desktop-policy', 'lib')
const compiled = existsSync(join(LIB, 'read-policy.js')) && existsSync(join(LIB, 'bash-policy.js'))

/** The compiled modules, loaded once. */
const modules = compiled
  ? {
    read: await import(join(LIB, 'read-policy.js')),
    bash: await import(join(LIB, 'bash-policy.js')),
  }
  : undefined

describe.skipIf(!compiled)('the compiled read guard', () => {
  it('refuses the secret families and nothing else', () => {
    const { blockedReadDecision } = modules.read
    const decide = (file) => blockedReadDecision({ name: 'read', arguments: { file_path: file } })
    for (const path of ['/p/.env', '/p/.env.local', '/h/.credentials.yaml', '/h/.credentials.yml', '/p/.git/config']) {
      expect(decide(path), path).toBeDefined()
    }
    // The `.env.example` exception is deliberate: the committed template is the file
    // an agent is *supposed* to read, and denying it would break ordinary setup.
    for (const path of ['/p/.env.example', '/p/src/index.ts', '/p/README.md']) {
      expect(decide(path), path).toBeUndefined()
    }
  })

  it('reads only the argument each tool declares as a path', () => {
    const { blockedReadDecision } = modules.read
    // `glob`'s `pattern` is a path glob, so it is guarded…
    expect(blockedReadDecision({ name: 'glob', arguments: { pattern: '**/.env*' } })).toBeDefined()
    // …while `grep`'s `pattern` is a REGEX. Searching for the literal text `.env` is
    // an ordinary search, and a guard that checked every string argument would deny
    // it. Only `path` names a file for `grep`.
    expect(blockedReadDecision({ name: 'grep', arguments: { pattern: '.env' } })).toBeUndefined()
    expect(blockedReadDecision({ name: 'grep', arguments: { path: '/p/.env' } })).toBeDefined()
  })

  it('is mode-independent by construction, which is what makes it a confidentiality rule', () => {
    // The guard takes no mode argument at all — that is the point, and it is why the
    // policy row evaluates it before touching the sandbox services. Asserted as an
    // arity/documentation fact so a future edit that adds a mode parameter has to
    // confront what that would mean: `danger-full-access` would start lifting a
    // confidentiality rule. The denial's own copy states the same thing to the model.
    expect(modules.read.blockedReadDecision.length).toBe(1)
    const denial = modules.read.blockedReadDecision({ name: 'read', arguments: { file_path: '.env' } })
    expect(denial.reason).toMatch(/not a sandbox-mode restriction/u)
    expect(denial.reason).toMatch(/no sandbox_permissions escalation lifts it/u)
  })

  it('denies rather than asks, so no escalation is invited', () => {
    // A `deny` is final. An `ask` would be worse than useless here: the harness's
    // escalation hint invites the model to request a wider mode, which cannot lift
    // this rule.
    expect(modules.read.blockedReadDecision({ name: 'read', arguments: { file_path: '.env' } }).kind).toBe('deny')
  })
})

describe.skipIf(!compiled)('the compiled shell fences', () => {
  it('denies mutating commands under read-only and allows reading ones', () => {
    const { readOnlyBashDecision } = modules.bash
    const decide = (command) => readOnlyBashDecision({ name: 'bash', arguments: { command } }, 'read-only')
    for (const command of ['rm -rf /tmp/x', 'echo hi > f', 'mkdir -p d']) {
      expect(decide(command), command).toBeDefined()
    }
    for (const command of ['ls -la', 'cat f']) {
      expect(decide(command), command).toBeUndefined()
    }
  })

  it('leaves the shell alone in the wider modes', () => {
    const { readOnlyBashDecision } = modules.bash
    for (const mode of ['workspace-write', 'danger-full-access']) {
      expect(readOnlyBashDecision({ name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, mode), mode)
        .toBeUndefined()
    }
  })

  it('does not touch tools that are not shells', () => {
    // The fences are disjoint by tool name, which is why the policy row may order
    // them freely — and why the read guard can run first without weakening them.
    const { readOnlyBashDecision, unconfinedShellAskDecision } = modules.bash
    const read = { name: 'read', arguments: { file_path: '/p/x' } }
    expect(readOnlyBashDecision(read, 'read-only')).toBeUndefined()
    expect(unconfinedShellAskDecision(read, { permission: 'read-only', shellConfines: false })).toBeUndefined()
  })

  it('asks on every shell call when the host applies no kernel confinement', () => {
    const { unconfinedShellAskDecision } = modules.bash
    const bash = { name: 'bash', arguments: { command: 'ls' } }
    // The security-relevant case, and the one this product is actually exposed to:
    // the runtime tree ships no `bin/landlock-run`, so a host with no bwrap mounts an
    // executor that reports no `sandboxMode`. Without this fence such a host would
    // advertise `workspace-write` to the model while the shell ignored it entirely.
    const ask = unconfinedShellAskDecision(bash, { permission: 'workspace-write', shellConfines: false })
    expect(ask?.kind).toBe('ask')
    expect(ask.reason).toMatch(/full user authority/u)
  })

  it('stays quiet when the host confines, or when the user chose no boundary', () => {
    const { unconfinedShellAskDecision } = modules.bash
    const bash = { name: 'bash', arguments: { command: 'ls' } }
    expect(unconfinedShellAskDecision(bash, { permission: 'workspace-write', shellConfines: true })).toBeUndefined()
    // `danger-full-access` exempt deliberately: the user selected "no boundary", and
    // prompting there would contradict the mode the model was told it has.
    expect(unconfinedShellAskDecision(bash, { permission: 'danger-full-access', shellConfines: false }))
      .toBeUndefined()
  })
})

describe.skipIf(!compiled)('the compiled artifacts', () => {
  it('carry no runtime import, and no TUI reference in their code', () => {
    // The property that makes compiling these two files safe. A non-type import
    // would have to resolve inside the Host process — and on `ink` or `react` it
    // would drag a terminal UI into a Node-mode child, which is what §7.5 forbids and
    // what the `ui-free-shared` gate guards at the source. This asserts the artifact.
    //
    // The banner names `ink` and `react` on purpose, explaining why the module is
    // compiled rather than imported, so the check runs against the code with comments
    // removed. Grepping the raw text would match the explanation and teach the next
    // reader to weaken the assertion.
    for (const file of ['read-policy.js', 'bash-policy.js']) {
      const text = readFileSync(join(LIB, file), 'utf8')
      expect([...text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gmu)], file).toEqual([])
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').split('\n')
        .filter((line) => !/^\s*\/\//u.test(line)).join('\n')
      expect(code, file).not.toMatch(/\bink\b|\breact\b/u)
      // And the banner is still there, so this cannot pass by the file being empty.
      expect(text, file).toMatch(/GENERATED/u)
    }
  })

  it('say that they are generated, and from what', () => {
    // Generated code that reads as hand-written is a trap: the next editor's change
    // disappears at the next build.
    const text = readFileSync(join(LIB, 'read-policy.js'), 'utf8')
    expect(text).toMatch(/GENERATED — do not edit/u)
    expect(text).toContain('qialike-app/src/read-policy.ts')
  })

  it('are exactly what the compile step produces from the sources', () => {
    // Freshness and determinism in one assertion. These files are gitignored, so a
    // stale copy survives a checkout; and a compile step that is not deterministic
    // would churn them on every build. Recompiling into a scratch directory and
    // comparing bytes answers both without mutating the tree under test.
    const scratch = join(ROOT, '.build-scratch', 'cli-policy-freshness')
    compileCliPolicy({ qialike: qialikeRoot(), outDir: scratch })
    for (const file of ['read-policy.js', 'bash-policy.js']) {
      expect(readFileSync(join(LIB, file), 'utf8'), file).toBe(readFileSync(join(scratch, file), 'utf8'))
    }
  })

  it('fail the build rather than skipping when a source is missing', () => {
    // The anchor-mismatch principle the other build-time steps follow: a policy
    // module that cannot be compiled is a build failure, because the alternative is
    // shipping a product whose guard mounts as nothing.
    expect(() => compileCliPolicy({
      qialike: join(ROOT, '.build-scratch', 'no-such-checkout'),
      outDir: join(ROOT, '.build-scratch', 'cli-policy-missing'),
    })).toThrow(/is missing from/u)
  })
})
