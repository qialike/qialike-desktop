/**
 * The changelog's format, for the version currently being written.
 *
 * WHY THIS EXISTS. The format became "one line per change point" in 0.2.1, and the rules behind it lived only
 * in prose at the top of the file — nothing failed if a later entry quietly grew to five lines, or if someone
 * reintroduced the commit hashes that the previous record file carried. `UPDATELOG`'s rules had eleven
 * assertions holding them up; when that file was deleted, its replacement was left with none. This restores
 * the enforcement without restoring the file.
 *
 * WHAT IS ENFORCED:
 *
 *   · **the file header states the format** — once, not in every section. Until 2026-10-13 the same sentence
 *     was repeated at the top of all five sections, and it carried a pointer to a path inside the developer's
 *     home directory: five copies of a note, and a path that means nothing to anyone reading the published
 *     changelog. It is stated once in the header now, and this is what keeps it stated at all. Note what the
 *     header does *not* do: it does not try to reconcile the older sections with the newer ones. An attempt
 *     at that sentence was written on 2026-10-13 and removed the same day, when it turned out to describe them
 *     wrongly (see the NOT ENFORCED note below for what the difference actually was).
 *   · **for the newest section**: every entry is exactly one line — a wrapped entry is how this format
 *     decays, since one more sentence is always tempting and prose is what it replaced;
 *   · **for the newest section**: no commit hashes — the changelog ships with the repository, and a hash in a
 *     released document is both unreadable to its audience and a self-reference problem for the commit that
 *     writes it;
 *   · **for the newest section**: entries exist at all, so an empty section cannot pass by being trivially
 *     well-formed.
 *
 * WHAT IS DELIBERATELY NOT ENFORCED:
 *
 *   · released sections, even though the checks would now pass on them. Four things were wrong with the older
 *     sections until 2026-10-13: 0.1.0 and 0.2.0 wrapped each entry over several lines (13 and 31 indented
 *     continuation lines) and 0.2.0 also carried a pointer to a path inside the developer's home directory.
 *     Those were fixed on request — the two sections were unwrapped to one line per change point and the
 *     pointer was dropped — so every section in both files now satisfies the rules above, and this suite was
 *     checked against all fourteen of them. The scope stays "newest" anyway, and deliberately: a released
 *     section is the record of what was published, so a future divergence must not be able to fail the suite
 *     retroactively and teach people to run it with an exemption.
 *   · which categories are used. `Added` / `Changed` / `Fixed` are conventions, not a schema.
 *
 * WHY "NEWEST" IS THE RIGHT SCOPE. The rule is for the version being prepared; once a version is tagged its
 * text is history. Widening it would make a released section able to fail the suite, and the response to that
 * would be to weaken the test until it checked nothing — which is the failure this file exists to prevent, not
 * to reintroduce.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../apps/desktop-bin/lib/paths.mjs'

const FILES = ['CHANGELOG.md', 'CHANGELOG.zh.md']

/**
 * The text of the newest version section.
 *
 * @param text - the whole changelog.
 * @returns the section's heading and its entry lines.
 */
function newestSection(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^## \[/u.test(line))
  expect(start, 'no version section at all').toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## \[/u.test(line))
  const body = end < 0 ? rest : rest.slice(0, end)
  const heading = lines[start]

  const entries = body.filter((line) => line.startsWith('- '))
  return { heading, entries }
}

describe('the changelog format', () => {
  for (const file of FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8')

    describe(file, () => {
      it('states the format it is written in, once, in the file header', () => {
        // IT IS ASSERTED IN THE HEADER, NOT PER SECTION. The note used to sit at the top of all five sections
        // with a pointer to a path inside the developer's home directory — repeated boilerplate, and a path
        // that means nothing to a reader of the published changelog. The header is where a reader starts, so
        // that is where the one copy lives; this is what notices if it is dropped entirely.
        const lines = text.split('\n')
        const firstSection = lines.findIndex((line) => /^## \[/u.test(line))
        const header = lines.slice(0, firstSection < 0 ? lines.length : firstSection).join('\n')
        expect(header.length, 'the file has no header at all').toBeGreaterThan(40)
        expect(header, 'the header does not state the format the entries are written in')
          .toMatch(/one line per change point|每个改动点一行/iu)
      })

      it('leads every entry with a bolded change point, which is what makes it scannable', () => {
        // The convention that makes one line readable at a glance: the change point is bold, the explanation
        // follows in plain text. An entry written the other way round — a sentence with the fact buried in it
        // — is exactly what this format replaced, so it should not pass as well-formed.
        const { heading, entries } = newestSection(text)
        expect(entries.length, `${heading} has no entries`).toBeGreaterThan(0)
        const unbolded = entries.filter((entry) => !entry.startsWith('- **'))
        expect(unbolded.map((entry) => entry.slice(0, 60)), 'an entry does not lead with a bold change point')
          .toEqual([])
      })

      it('has no indented continuation lines under any entry', () => {
        // The real check for "one line each": a wrapped entry shows up as an indented line inside the section
        // that is not a category heading and not part of the intro.
        const lines = text.split('\n')
        const start = lines.findIndex((line) => /^## \[/u.test(line))
        const rest = lines.slice(start + 1)
        const end = rest.findIndex((line) => /^## \[/u.test(line))
        const body = end < 0 ? rest : rest.slice(0, end)
        const firstBullet = body.findIndex((line) => line.startsWith('- '))
        const wrapped = body
          .slice(firstBullet)
          .filter((line) => /^\s+\S/u.test(line))
        expect(wrapped, 'an entry wraps onto a continuation line').toEqual([])
      })

      it('carries no commit hashes in the newest section', () => {
        // The changelog ships with the repository. A hash is unreadable to its audience and it re-creates the
        // self-reference problem the deleted record file had: a commit cannot contain its own.
        const lines = text.split('\n')
        const start = lines.findIndex((line) => /^## \[/u.test(line))
        const rest = lines.slice(start + 1)
        const end = rest.findIndex((line) => /^## \[/u.test(line))
        const body = (end < 0 ? rest : rest.slice(0, end)).join('\n')
        expect(body).not.toMatch(/`[0-9a-f]{7,40}`/u)
      })

      it('dates the newest section, rather than leaving it undated or marked unreleased', () => {
        // The date is the day the tag is made, which is a convention with precedent (both earlier versions).
        // A missing date is how a section stays "unreleased" after it has shipped.
        const { heading } = newestSection(text)
        expect(heading).toMatch(/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/u)
      })
    })
  }

  it('keeps the two languages in step', () => {
    // Entry counts, not text: the languages are written independently and a paragraph is translated rather
    // than transcribed. A count is what catches a change point added to one file and forgotten in the other.
    const counts = FILES.map((file) => newestSection(readFileSync(join(ROOT, file), 'utf8')).entries.length)
    expect(counts[1], 'the two changelogs list a different number of change points').toBe(counts[0])
  })
})
