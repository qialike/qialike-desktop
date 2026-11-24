/**
 * The tool and policy surface the composed profile mounts (M5).
 *
 * TWO DEFECTS THIS SUITE EXISTS FOR, both of which booted cleanly:
 *
 *   · `delete` and `move` were never mounted. The CLI's bundle patch has carried
 *     the `qialike-fs-tools` row all along; ours never had it, so the two
 *     workspace mutations the fs seam does not expose — and which exist precisely
 *     because the shell is an expensive or unavailable path on some hosts — were
 *     simply missing from this product.
 *
 *   · The secrets read guard was never registered, while DESIGN §7.5 stated it
 *     was. The guard refuses tool reads of `.env`-family files, `.git` internals
 *     and the credential document. It lives in the CLI's `index.tsx` behind a
 *     `tools/pre-execute` listener, and that listener is reachable only through
 *     the CLI's *root* entry — which this profile does not mount, because the root
 *     entry statically imports `ink` and `react`.
 *
 * WHY THIS IS NOT A TEST OF SOMEONE ELSE'S CODE. The guard's *rules* are the
 * CLI's and are compiled from its sources (see `cli-policy.mjs`); what is ours is
 * the decision to mount them here, on the right plane, with the effective session
 * mode resolved from the harness's own service. A row that is absent, mounts into
 * the wrong layer, or wires the wrong mode all produce a profile that boots and
 * does not guard — which is the shape both defects had.
 *
 * The probe boots the real profile in a child process, so these run against the
 * assembled runtime tree and are skipped when it is absent.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIST_DIR, ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const RUNTIME_DIR = join(DIST_DIR, 'runtime', 'dsh')
const PROBE = join(ROOT, 'apps', 'desktop-bin', 'lib', 'policy-probe.mjs')
const assembled = existsSync(join(RUNTIME_DIR, 'desktop-runtime.json'))

/** Boot once for every assertion below: the profile takes seconds to settle. */
const probe = (() => {
  let pending
  return () => pending ??= new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, RUNTIME_DIR], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, DSH_HOME: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('exit', (code) => {
      const marker = out.indexOf('__REPORT__')
      if (marker < 0) {
        reject(new Error(`the policy probe produced no report (exit ${String(code)}):\n${out}\n${err}`))
        return
      }
      resolve({ report: JSON.parse(out.slice(marker + '__REPORT__'.length)), stderr: err })
    })
  })
})()

describe.skipIf(!assembled)('the mounted tool surface', () => {
  it('registers delete and move, the two mutations the fs seam does not expose', async () => {
    const { report } = await probe()
    // Registered on the HOST plane, which is what makes them reachable at all: the
    // fs seam publishes only writeText and editText, and writeText already creates
    // parent directories, so `mkdir` needs no tool of its own — these two do.
    expect(report.registered.delete).toBe('present')
    expect(report.registered.move).toBe('present')
  })

  it('does not claim the preset-plane tools, which is how the layers stay separate', async () => {
    // `read`/`write`/`bash` belong to an agent preset, so a global lookup must not
    // find them. Asserted so that a future row mounting the whole `tool-fs` set
    // here — which would put two owners on one name — fails loudly instead of
    // quietly changing which plane owns file access.
    const { report } = await probe()
    for (const name of ['read', 'write', 'edit', 'bash']) {
      expect(report.registered[name], `${name} should be preset-scoped`).toBe('absent')
    }
  })
})

describe.skipIf(!assembled)('the mounted secrets read guard', () => {
  it('denies the credential document', async () => {
    const { report } = await probe()
    const decision = report.decisions['read-credentials']
    expect(decision.kind, 'reading the credential store must be refused').toBe('deny')
    // `reachedNext` false is the other half: a decision that came from the
    // fallback would mean no listener is mounted at all.
    expect(decision.reachedNext).toBe(false)
  })

  it('denies the .env family and .git internals', async () => {
    const { report } = await probe()
    for (const id of ['read-env', 'read-env-local', 'read-git-internals']) {
      expect(report.decisions[id].kind, id).toBe('deny')
      expect(report.decisions[id].reachedNext, id).toBe(false)
    }
  })

  it('covers the other read tools, whose path arguments differ', async () => {
    // `read_image` names its path the same way `read` does; `glob`'s `pattern`
    // genuinely is a path glob; `grep`'s path is the second key it declares. A
    // guard wired to one tool's key would pass the first test and fail these.
    const { report } = await probe()
    expect(report.decisions['read-image-env'].kind).toBe('deny')
    expect(report.decisions['glob-env'].kind).toBe('deny')
    expect(report.decisions['grep-env-path'].kind).toBe('deny')
  })

  it('leaves ordinary reads alone', async () => {
    // The control. A guard that denied everything would satisfy every test above
    // and make the product unusable.
    const { report } = await probe()
    for (const id of ['read-ordinary', 'glob-ordinary']) {
      expect(report.decisions[id].kind, id).toBe('allow')
      expect(report.decisions[id].reachedNext, id).toBe(true)
    }
  })

  it('keeps the two documented exceptions', async () => {
    const { report } = await probe()
    // `.env.example` is the committed template an agent is *supposed* to read.
    expect(report.decisions['read-env-example'].kind).toBe('allow')
    // `grep`'s `pattern` is a regex, not a path: searching FOR the text ".env" is
    // an ordinary search. A guard that checked every string argument would deny it.
    expect(report.decisions['grep-env-as-pattern'].kind).toBe('allow')
  })

  it('says in the denial that no escalation lifts it', async () => {
    // Load-bearing copy, not decoration. The harness's escalation hint invites the
    // model to ask for a wider sandbox mode; without this sentence the model would
    // retry forever against a rule no mode can widen — and a reader of the code
    // could mistake the guard for a file-effect boundary.
    const { report } = await probe()
    const reason = report.decisions['read-env'].reason ?? ''
    expect(reason).toMatch(/secret or repository-internal/u)
    expect(reason).toMatch(/no sandbox_permissions escalation lifts it/u)
  })
})


describe.skipIf(!assembled)('the retained sandbox posture', () => {
  /** §7.5's second claim, as a list rather than a reading of the YAML. */
  const RETAINED = [
    'sandbox', 'sandbox-policy', 'fs-sandbox', 'bash-sandbox', 'pwsh-sandbox',
    'approval', 'permission', 'fs-observation-policy',
  ]

  it('keeps every sandbox and policy row mounted', async () => {
    // The failure this guards is a later patch disabling one of these. It would not
    // be visible as a build failure or as a broken UI: the profile boots, serves and
    // renders with the sandbox gone, and the only symptom is a boundary that is no
    // longer there. §7.5 promises the CLI's posture, so the promise is asserted.
    const { report } = await probe()
    for (const id of RETAINED) {
      expect(report.rows[id]?.present, `${id} is not mounted`).toBe(true)
    }
  })

  it('leaves them enabled, except the shell stack the base gates to the other platform', async () => {
    const { report } = await probe()
    // `bash-sandbox` and its twin `pwsh-sandbox` are the same capability for two
    // shells, and the base patch gates them by platform — `bash-sandbox` carries
    // `disabled: !!js process.platform === 'win32'` and `pwsh-sandbox` the inverted
    // expression — so exactly one shell stack mounts per host. Asserting the
    // platform relationship rather than a constant keeps this honest everywhere; an
    // earlier version only knew about `pwsh-sandbox`, which read as "bash-sandbox is
    // unexpectedly disabled" on Windows and was really this table being half-written.
    const PLATFORM_GATED = {
      'bash-sandbox': (onWindows) => onWindows,
      'pwsh-sandbox': (onWindows) => !onWindows,
    }
    const onWindows = process.platform === 'win32'
    for (const id of RETAINED) {
      const row = report.rows[id]
      const gate = PLATFORM_GATED[id]
      const expectedDisabled = gate === undefined ? false : gate(onWindows)
      expect(row.disabled, `${id} disabled state`).toBe(expectedDisabled)
    }
  })

  it('runs under workspace-write by default', async () => {
    // §8's product promise, read from the service that actually answers it rather
    // than from the patch that declares it.
    const { report } = await probe()
    expect(report.sandbox.defaultMode).toBe('workspace-write')
  })

  it("fences the shell with the CLI's own timeout", async () => {
    // The parity question that started this suite: the CLI's patch restates
    // `timeoutMs: 60000` for `bash-sandbox`, and this profile does not — because
    // `dsh-base` already sets it. Asserting the resolved value is what makes that
    // "already aligned" claim checkable instead of asserted.
    const { report } = await probe()
    expect(report.rows['bash-sandbox'].config?.timeoutMs).toBe(60_000)
  })

  it('does not claim to know the per-session approval policy', async () => {
    // Recorded as a boundary rather than left implicit. The approval policy is a
    // *session* fact — it arrives through `approval/policy` events, and the service
    // exposes none — which is the same reason the shell fences are covered by unit
    // tests and not by this probe. Asserting a value here would mean inventing one.
    const { report } = await probe()
    expect(report.rows.approval.present).toBe(true)
    expect(report.sandbox.approvalPolicy).toBeNull()
  })
})
