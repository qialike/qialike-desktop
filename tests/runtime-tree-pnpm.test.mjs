/**
 * How the build reaches `pnpm` to resolve the runtime dependency tree.
 *
 * WHY THIS IS WORTH A SUITE. The obvious call, `spawnSync('pnpm', …)`, is wrong on
 * Windows in a way that cannot be seen by reading it: the name resolves to a `.cmd`
 * shim, Node's spawn does not apply `PATHEXT`, and `spawnSync` therefore fails with
 * `ENOENT` — while `spawnSync('pnpm.cmd', …)` fails with `EINVAL`, because Node
 * refuses to spawn a batch file without a shell. Both were measured. The step this
 * feeds is the last one in `pnpm run build`, so getting it wrong costs a whole
 * build to discover.
 *
 * The properties asserted here are the ones that make it work: the pinned pnpm is
 * preferred over whatever is on `PATH`, the choice is not made by guessing from a
 * path alone, and no spelling that Node cannot execute is ever returned.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { pnpmInvocation } from '../apps/desktop-bin/lib/runtime-tree.mjs'

/** The two variables the choice reads, saved so each case starts from a known state. */
const SAVED = {
  execpath: process.env.npm_execpath,
  agent: process.env.npm_config_user_agent,
}

/** Put a specific package manager into the environment, as a runner would. */
function running(spec) {
  if (spec === undefined) {
    delete process.env.npm_execpath
    delete process.env.npm_config_user_agent
    return
  }
  process.env.npm_execpath = spec.execpath
  process.env.npm_config_user_agent = spec.agent
}

afterEach(() => {
  running(SAVED.execpath === undefined ? undefined : { execpath: SAVED.execpath, agent: SAVED.agent })
})

describe('pnpmInvocation', () => {
  it('runs the invoking pnpm through node, so the pinned version resolves the tree', () => {
    // The reason this matters: `package.json` pins pnpm 11.28.5, but the machine
    // this was fixed on had pnpm 12.2.0 on PATH. Resolving the runtime tree with a
    // different pnpm than the workspace is not an equivalent act, and nothing in
    // the output would announce the substitution.
    running({
      execpath: '/opt/pnpm/11.28.5/bin/pnpm.mjs',
      agent: 'pnpm/11.28.5 npm/? node/v24.19.0 win32 x64',
    })
    const invocation = pnpmInvocation(['install', '--no-frozen-lockfile'])
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.args).toEqual(['/opt/pnpm/11.28.5/bin/pnpm.mjs', 'install', '--no-frozen-lockfile'])
    // Named in the log, so a build log says which pnpm resolved the tree.
    expect(invocation.via).toContain('pnpm/11.28.5')
  })

  it('does not mistake npm for pnpm, even though npm also sets npm_execpath', () => {
    // `node <npm-cli.js> install` is a different program with different flags, so
    // treating the variable as "the package manager" rather than "pnpm" would swap
    // the resolver rather than reuse it.
    running({
      execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      agent: 'npm/11.17.0 node/v24.19.0 win32 x64',
    })
    expect(pnpmInvocation(['install']).command).not.toBe(process.execPath)
  })

  it('never returns a spelling Node cannot execute', () => {
    // The two measured failures, asserted as an invariant so neither can come back:
    // a bare `.cmd` (EINVAL) or, on Windows, a bare `pnpm` that is really a `.cmd`
    // (ENOENT). Whatever branch is taken, the program must be runnable.
    for (const spec of [
      undefined,
      { execpath: '/opt/pnpm/11.28.5/bin/pnpm.mjs', agent: 'pnpm/11.28.5 npm/? node/v24.19.0 win32 x64' },
    ]) {
      running(spec)
      const { command } = pnpmInvocation(['install'])
      expect(command.endsWith('.cmd')).toBe(false)
      expect(command.endsWith('.bat')).toBe(false)
      if (process.platform === 'win32') {
        // Either node, or the shell Node insists on for a batch shim.
        expect([process.execPath, process.env.ComSpec ?? 'cmd.exe']).toContain(command)
      }
    }
  })

  it.skipIf(process.platform !== 'win32')('uses cmd.exe for the fallback on Windows', () => {
    // Reached only when the build runs outside a package manager, where there is no
    // `npm_execpath` to inherit. `cmd.exe /d /s /c` is the shell Node requires for a
    // `.cmd` shim, and the program stays a separate argv entry rather than being
    // concatenated into a command line.
    running(undefined)
    const invocation = pnpmInvocation(['install', '--store-dir', 'C:\\a b\\store'])
    expect(invocation.command).toBe(process.env.ComSpec ?? 'cmd.exe')
    expect(invocation.args.slice(0, 4)).toEqual(['/d', '/s', '/c', 'pnpm'])
    expect(invocation.args).toContain('install')
  })

  it.skipIf(process.platform === 'win32')('uses pnpm from PATH on POSIX, where it is a script', () => {
    running(undefined)
    const invocation = pnpmInvocation(['install'])
    expect(invocation.command).toBe('pnpm')
    expect(invocation.args).toEqual(['install'])
  })
})
