/**
 * The startup-failure dialog, and the log it points at.
 *
 * The failure text below is a real one, reported by a person, and every assertion here is about something
 * that was wrong with how it was shown or kept:
 *
 *   · the headline was 159 characters of transport plumbing with the fact at the end;
 *   · the body listed all ninety-one plugins and then a stack trace through a temporary directory, with
 *     nothing to do about any of it;
 *   · the remedy was in the text — an interrupted AppImage extraction leaves a partial tree, and the path
 *     to remove is right there — and no code read it;
 *   · and there was no file to open afterwards, because the shell had no log of its own.
 *
 * Nothing in this suite can click a native dialog, so these check the two things that reach it — the strings
 * and the file — rather than trusting them.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summariseStartupFailure } from '../apps/desktop/src/startup-failure.ts'
import {
  DESKTOP_LOG_MAX_BYTES,
  DESKTOP_LOG_NAME,
  appendDesktopLog,
  desktopLogPath,
} from '../apps/desktop/src/desktop-log.ts'

/** A real report, verbatim, including the paths that identify what went wrong. */
const REPORTED = `Error invoking remote method 'qialike-desktop:boot': Error: qialike desktop: the Host failed to start: dsh: startup failed: 4 required plugins did not activate

Failed plugins (91):
hmr
Package: @deepseek-ai/dsh-hmr
failed to import
typert-loader
Package: @deepseek-ai/dsh-typert-loader
AggregateError: typert-loader: 1 typert contributor(s) failed to register:

    typert-loader: @deepseek-ai/dsh-llm exports "./typert" but importing /tmp/qialike-pm-dl8DHa/tmp/appimage_extracted_b85948291388198f67adeb6ad469bf25/resources/dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/qialike-pm-dl8DHa/tmp/appimage_extracted_b85948291388198f67adeb6ad469bf25/resources/dsh/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js' imported from /tmp/qialike-pm-dl8DHa/tmp/appimage_extracted_b85948291388198f67adeb6ad469bf25/resources/dsh/node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js
    at Object.apply [as ca`

const EXTRACTION = '/tmp/qialike-pm-dl8DHa/tmp/appimage_extracted_b85948291388198f67adeb6ad469bf25'

/** The path's tail, which is what the removed excerpt used to quote back at the reader. */
const EXTRACTION_TAIL = 'node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js'
const LOG = '/home/someone/.dsh/qialike-desktop.log'

const summarise = (text) => summariseStartupFailure(text, { logPath: LOG })

describe('the startup-failure summary', () => {
  it('puts the fact in the headline rather than the transport that carried it', () => {
    // The reported dialog's headline was "Error invoking remote method 'qialike-desktop:boot': Error: …",
    // and the only sentence that says what happened was its last clause.
    expect(summarise(REPORTED).message).toBe('4 required plugins did not activate')
  })

  it('keeps the headline short enough to read', () => {
    expect(summarise(REPORTED).message.length).toBeLessThan(60)
  })

  it('summarises the plugin list instead of reproducing it', () => {
    const { detail } = summarise(REPORTED)
    // The count comes from the header, and the names are the ones the list actually produced.
    expect(detail).toContain('Plugins that did not load (91): hmr, typert-loader')
    // And the list itself is gone. The reported dialog carried all ninety-one entries and then a stack trace
    // through a temporary directory; a summary that keeps them is not a summary.
    expect(detail).not.toContain('Package:')
    expect(detail).not.toContain('AggregateError')
    expect(detail).not.toContain('ERR_MODULE_NOT_FOUND')
  })

  it('does not claim more hidden names than it read', () => {
    // The first version of this line computed "and N more" as total minus the display limit and announced 86
    // more plugins while holding two. The number must come from the names in hand.
    const { detail } = summarise(REPORTED)
    expect(detail).not.toMatch(/and \d+ more/u)
  })

  it('states how many it is holding back when there are more names than it shows', () => {
    const many = ['Failed plugins (7):']
    for (let i = 0; i < 7; i += 1) many.push(`plugin-${String(i)}`, `Package: @deepseek-ai/dsh-plugin-${String(i)}`, 'failed to import')
    const { detail } = summarise(many.join('\n'))
    expect(detail).toContain('plugin-0, plugin-1, plugin-2, plugin-3, plugin-4, and 2 more')
  })

  it('gives the remedy when the failure names an interrupted extraction', () => {
    // "Restart the application" is the wrong advice here: the next launch finds the same partial tree. The
    // path to remove is in the message, and the only useful thing to do with it is print the command.
    const { detail } = summarise(REPORTED)
    expect(detail).toContain('unpacked copy is incomplete')
    expect(detail).toContain(`rm -rf ${EXTRACTION}`)
  })

  it('names the log file, so the failure can be read without a terminal', () => {
    expect(summarise(REPORTED).detail).toContain(`Full details: ${LOG}`)
  })

  it('stays small when it understood the failure, and shows evidence when it did not', () => {
    // Two dialogs, two shapes. The structured one is short because the parts above it are the summary; the
    // unstructured one carries a bounded excerpt because there is nothing else to show.
    const recognised = summarise(REPORTED)
    expect(recognised.detail.length).toBeLessThan(500)
    expect(recognised.detail).not.toContain(EXTRACTION_TAIL)

    const unrecognised = summarise(`boom\n${'detail line\n'.repeat(200)}tail-of-message`)
    // The headline is the first line, so the evidence is everything after it — not a repeat of the headline.
    expect(unrecognised.message).toBe('boom')
    expect(unrecognised.detail).toContain('detail line')
    expect(unrecognised.detail).not.toContain('boom')
    expect(unrecognised.detail.length).toBeLessThan(1200)
    expect(unrecognised.detail).toContain('…')
  })

  it('offers no remedy it cannot substantiate', () => {
    // An ordinary failure — a plugin that will not import, no extraction path in it — must not be told to
    // delete a directory, and must not be given a plugin count it does not have.
    const plain = summarise('Error: qialike desktop: the Host failed to start: dsh: startup failed: the port is in use')
    expect(plain.message).toBe('the port is in use')
    expect(plain.detail).not.toContain('rm -rf')
    expect(plain.detail).not.toContain('Plugins that did not load')
    expect(plain.detail).toContain(`Full details: ${LOG}`)
  })

  it('shows the evidence itself when the log could not be written', () => {
    // Naming a file that does not exist is worse than showing the text: with the log unavailable, the excerpt
    // is the only copy the reader has — even for a failure the summary understood.
    const noLog = summariseStartupFailure(REPORTED, {})
    expect(noLog.detail).toContain('could not be written')
    expect(noLog.detail).not.toContain('Full details:')
    expect(noLog.detail).toContain('Package:')
    // And the parts that do not depend on the log are still there.
    expect(noLog.message).toBe('4 required plugins did not activate')
    expect(noLog.detail).toContain(`rm -rf ${EXTRACTION}`)
  })

  it('never returns an empty headline, whatever it is handed', () => {
    expect(summarise('').message).toBe('the client reported an unspecified startup failure')
    expect(summarise('Error: ').message.trim()).not.toBe('')
    expect(summarise('\n\n').message.trim()).not.toBe('')
  })

  it('leaves a message that is nothing but wrappers alone rather than emptying it', () => {
    // The floor exists so that stripping cannot produce a headline with no information in it.
    expect(summarise('dsh: startup failed:').message.length).toBeGreaterThan(5)
  })
})

describe('the desktop log', () => {
  let root

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qialike-log-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lives beside the Host log, under $DSH_HOME', () => {
    // The one directory a user of this product already knows, because the CLI keeps its log there.
    // `join` rather than a spelled-out `/`: the separator is the host's, and the property
    // being asserted is that the log sits *beside* the Host log, not which character separates.
    expect(desktopLogPath('/home/someone/.dsh')).toBe(join('/home/someone/.dsh', DESKTOP_LOG_NAME))
    expect(DESKTOP_LOG_NAME).toBe('qialike-desktop.log')
  })

  it('writes an entry with a timestamp, and appends rather than replacing', () => {
    const path = join(root, DESKTOP_LOG_NAME)
    expect(appendDesktopLog(path, 'first failure')).toBe(true)
    expect(appendDesktopLog(path, 'second failure')).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] first failure\n/u)
    expect(text).toContain('second failure')
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(2)
  })

  it('creates the directory it needs', () => {
    const path = join(root, 'nested', 'deeper', DESKTOP_LOG_NAME)
    expect(appendDesktopLog(path, 'created')).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('rotates to .1 at the same threshold the Host uses, rather than growing without bound', () => {
    const path = join(root, DESKTOP_LOG_NAME)
    writeFileSync(path, 'x'.repeat(DESKTOP_LOG_MAX_BYTES + 1))
    expect(appendDesktopLog(path, 'after rotation')).toBe(true)
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(DESKTOP_LOG_MAX_BYTES + 1)
    const current = readFileSync(path, 'utf8')
    expect(current).toContain('after rotation')
    expect(current.length).toBeLessThan(DESKTOP_LOG_MAX_BYTES)
  })

  it('reports failure instead of throwing, because it runs while something else is already failing', () => {
    // A log that cannot be written must not become a second failure inside the handler for the first.
    const path = join(root, 'not-a-directory', DESKTOP_LOG_NAME)
    writeFileSync(join(root, 'not-a-directory'), 'this is a file')
    expect(() => appendDesktopLog(path, 'x')).not.toThrow()
    expect(appendDesktopLog(path, 'x')).toBe(false)
  })

  it('writes the file owner-only, since failures quote paths from a personal directory', () => {
    const path = join(root, DESKTOP_LOG_NAME)
    appendDesktopLog(path, 'x')
    // POSIX states this as a mode; Windows has none to assert, because `chmod` there
    // only toggles the read-only attribute and readability is decided by the inherited
    // ACL. The log lives under the user's own profile, so it is owner-only by that
    // inheritance rather than by a bit set here. Asserting 0o600 on Windows would be
    // asserting the host. What still matters there is that the restricted-mode write
    // produced the file at all.
    if (process.platform === 'win32') {
      expect(existsSync(path)).toBe(true)
      return
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
