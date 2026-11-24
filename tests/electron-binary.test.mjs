/**
 * The launcher's Electron resolution, and the script that depends on it.
 *
 * WHY THIS SUITE EXISTS. `pnpm run start:desktop` was `electron apps/desktop` — a bare command name — and it
 * never resolved, from the commit that introduced it until someone ran the menu's start step and reported
 * `sh: 1: electron: not found`. pnpm does not hoist a workspace package's bins to the repository root, so the
 * only `electron` on the machine lives in `apps/desktop/node_modules/.bin/`.
 *
 * Two assertions here would each have caught it, and they are the reason the resolution was extracted into a
 * module at all:
 *
 *   · `electronBinary()` finds an existing executable rather than trusting `PATH`; and
 *   · every `start:*` script in the root manifest names a file that exists in this repository, so a bare
 *     command name cannot be reintroduced.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { electronBinary } from '../apps/desktop-bin/lib/electron-binary.mjs'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('the electron binary', () => {
  it('resolves to an existing executable', () => {
    const binary = electronBinary(ROOT)
    expect(existsSync(binary), `${binary} does not exist`).toBe(true)
    // Executable by someone: the launcher spawns it, so a non-executable file is the same failure with a
    // different message.
    //
    // ONLY MEANINGFUL ON POSIX. Windows has no execute bit: a `.exe` is runnable by
    // virtue of its extension and the ACL that admits the user, and `statSync` there
    // reports regular file modes (`0o666`) for it. Requiring `0o111` would fail for
    // the one binary that does work. The resolution above is the real assertion on
    // Windows, and the launcher's own behaviour is what proves it.
    if (process.platform !== 'win32') {
      expect(statSync(binary).mode & 0o111, `${binary} is not executable`).not.toBe(0)
    }
  })

  it('does not depend on PATH, which is what the broken script assumed', () => {
    // The resolution must succeed with an empty PATH: the failure it replaces was `sh: 1: electron: not found`,
    // which is precisely a PATH lookup failing. Nothing here may shell out to find it.
    const original = process.env.PATH
    process.env.PATH = ''
    try {
      expect(() => electronBinary(ROOT)).not.toThrow()
    } finally {
      process.env.PATH = original
    }
  })

  it('resolves the real executable rather than the generated shim, when it can', () => {
    // The shim is a Posix shell script that re-executes the real thing. Asking the package's own declaration
    // first means the launcher works even if the shim was never generated — and it is the reason this cannot
    // be a `PATH` lookup.
    const binary = electronBinary(ROOT)
    expect(binary).not.toContain(join('node_modules', '.bin'))
    expect(readFileSync(binary).subarray(0, 4).toString('hex')).not.toBe('23212f73') // not "#!/s"
  })

  it('says what it looked for when the tree has no electron at all', () => {
    // The message is the whole diagnosis someone gets: it should name the paths it tried and the command that
    // fixes it, rather than surfacing a shell's "not found".
    //
    // RUN IN A CHILD PROCESS, and that is not caution — it is the only way the case is reachable. Inside
    // vitest, `require('electron')` resolves through the runner's own module graph, rooted at this repository,
    // so an isolated directory still finds the repository's Electron and the failure never happens. A plain
    // `node` process resolves the way the launcher does. The first version of this test asserted the throw
    // in-process and could not fail, which is the same class of mistake as the assertion it replaced.
    const isolated = mkdtempSync(join(tmpdir(), 'qialike-no-electron-'))
    try {
      // `pathToFileURL`, because a bare absolute path is not a valid ESM specifier on
      // Windows: `C:\...` parses as a URL with the scheme `c:`, the import fails, the
      // child prints nothing on stdout, and the test reads that emptiness as "did not
      // throw". A `file://` URL is the spelling both platforms agree on.
      const moduleUrl = pathToFileURL(join(ROOT, 'apps/desktop-bin/lib/electron-binary.mjs')).href
      const script = `
        import { electronBinary } from ${JSON.stringify(moduleUrl)}
        try {
          const found = electronBinary(${JSON.stringify(isolated)})
          process.stdout.write('FOUND:' + found)
        } catch (error) {
          process.stdout.write('THREW:' + error.message)
        }
      `
      // A CLEAN ENVIRONMENT, and this is the whole reason the case is reachable at all. Vitest exports
      // `NODE_PATH` pointing into the repository's `.pnpm/node_modules`, and `spawnSync` inherits it — so the
      // child resolved the repository's Electron from an unrelated directory and the throw never happened.
      // (That is also why the broken `electron` script could appear to work under some runners.) The launcher
      // runs from a shell, so the child gets a shell's environment.
      //
      // Windows needs `SystemRoot` and `ComSpec` as well: without them the child cannot
      // start at all, which would look like the same empty stdout as the bug above.
      const env = {}
      for (const key of ['PATH', 'HOME', 'LANG', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })
      const out = result.stdout ?? ''
      expect(out.startsWith('THREW:'), `expected a throw, got: ${out.slice(0, 200)} ${result.stderr ?? ''}`.trim()).toBe(true)
      expect(out).toMatch(/could not find the electron executable/u)
      expect(out).toMatch(/pnpm install/u)
      // And it says where it looked, so the message does not send someone hunting.
      expect(out).toMatch(/node_modules/u)
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })
})

describe('the scripts that launch something', () => {
  const launchers = Object.entries(manifest.scripts ?? {})
    .filter(([name]) => name.startsWith('start:'))

  it('has a start script to check', () => {
    expect(launchers.length).toBeGreaterThan(0)
  })

  it('names a file in this repository rather than a bare command', () => {
    // The regression guard. A bare `electron apps/desktop` passes a person's eye and fails at runtime; this
    // requires the script's program to be a path that exists here.
    for (const [name, script] of launchers) {
      const [program, ...rest] = script.split(' ')
      // `node <path>` is the shape the repository uses for its own tools; anything else would have to justify
      // itself, and nothing currently does.
      expect(program, `${name} does not run through node`).toBe('node')
      const target = rest.find((token) => !token.startsWith('-'))
      expect(target, `${name} names no file`).toBeDefined()
      expect(existsSync(join(ROOT, target)), `${name} points at ${target}, which does not exist`).toBe(true)
    }
  })
})
