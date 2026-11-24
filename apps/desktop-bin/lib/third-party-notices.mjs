/**
 * Write the aggregate third-party notice an artifact carries.
 *
 * WHY THIS EXISTS. `THIRD_PARTY_NOTICES.md` at the repository root is a map, not a substitute: it
 * records the packages this repository *chooses* and says, correctly, that each package ships its
 * own licence text and those are what an artifact carries. That reasoning has one hole, found by
 * reading an artifact instead of assuming the rule held: a package whose bytes are INLINED into a
 * bundle leaves no package behind to carry its text.
 *
 * The case that exposed it is KaTeX. Its twenty font files sit in
 * `dsh-web-frontend/dist/assets/fonts/` beside Inter, JetBrains Mono and Montserrat — and beside
 * those three are `LICENSE-Inter.txt`, `LICENSE-JetBrainsMono.txt` and `Montserrat-OFL.txt`, while
 * KaTeX has nothing. Its code and its `@font-face` rules were compiled into a vendor CSS bundle, so
 * the `katex` package is not in the tree at all and its MIT notice travelled nowhere. Measured on
 * 0.4.9's Linux artifact: 25 font files, 3 licences.
 *
 * WHAT THIS FILE IS, AND IS NOT. It is three things in one document:
 *
 *   1. The repository's own notice, verbatim — the table of what this project chose.
 *   2. A COMPLETE index of every package in the runtime tree: name, version, licence. Not the
 *      licence texts; those already travel inside each package and duplicating 654 of them would
 *      add megabytes to argue a point the packages themselves make. The index is what makes the
 *      artifact self-describing — you can read it without the source tree.
 *   3. The full text of every licence that would otherwise be LOST, which is the inlined-font case.
 *
 * WHY AN INDEX RATHER THAN ONLY THE GAPS. A notice that lists nothing but exceptions cannot be
 * audited: a reader has no way to tell whether a package is missing because it was handled or
 * because nobody looked. The index makes absence visible.
 *
 * @module apps/desktop-bin/lib/third-party-notices
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Names a licence file may take, in the order a package is likely to use them. */
function isLicenceName(name) {
  const lower = name.toLowerCase()
  return lower.startsWith('licen') || lower.startsWith('copying')
}

/**
 * Bundles whose third-party content has no package of its own in the tree.
 *
 * WHY A TABLE AND NOT A SCAN. There is no general way to ask a compiled bundle which licences its
 * bytes came from — that knowledge lives in the build that produced it. So each entry is written
 * down, with the evidence for it, and a test asserts the fonts it names are still present. When the
 * harness inlines something new, that test is what notices the missing entry.
 */
const INLINED = [
  {
    name: 'KaTeX',
    version: null,
    licence: 'MIT',
    homepage: 'https://katex.org',
    // The fonts are derived from the Computer Modern faces. KaTeX's repository carries no separate
    // font licence and its README states the project is MIT; downstream notices attribute these
    // files under the SIL Open Font License 1.1. Both are reproduced below, because an artifact
    // that carries the stricter reading cannot be wrong under the looser one.
    fontLicence: 'SIL OFL 1.1 (as attributed by downstream redistributors)',
    evidence: 'fonts present in the web frontend bundle with no package alongside',
    text: `The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
    fontText: `The KaTeX font files are distributed under the SIL Open Font License, Version 1.1.

Copyright (c) 2013-2020 Khan Academy and other contributors

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`,
  },
]

/**
 * Package families whose licence text lives at a SOURCE ROOT rather than in each package.
 *
 * THE SECOND GAP THIS FILE CLOSES, and the larger one. The DeepSeek Harness is a monorepo with a
 * single `LICENSE` at its root; its 297 packages each declare `"license": "MIT"` in their manifest
 * and none of them carries a licence file. Because the runtime tree is composed from built packages
 * rather than from a checkout, that root file travels nowhere — so the artifact would have shipped
 * 297 packages whose declared terms had no text anywhere inside it.
 *
 * Measured on a 0.4.9 tree: 655 packages, 329 with no licence file, and 297 of those were
 * `@deepseek-ai/*`. The remaining 32 are ordinary npm packages that declare a licence in their
 * manifest and ship no file, which is their business and not something this document can fix; they
 * are listed by name instead.
 *
 * The text below is the harness's own `LICENSE`, reproduced so the artifact carries it.
 */
const ROOT_LICENSED = [
  {
    prefix: '@deepseek-ai/',
    holder: 'DeepSeek',
    licence: 'MIT',
    text: `MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },
]

/** The root-licence family a package belongs to, if any. */
function rootLicenceFor(name) {
  return ROOT_LICENSED.find((entry) => name.startsWith(entry.prefix))
}

/** Read one package's licence identifier, preferring the manifest's own field. */
function licenceOf(manifest) {
  const field = manifest.license
  if (typeof field === 'string' && field.trim() !== '') return field.trim()
  if (field !== null && typeof field === 'object' && typeof field.type === 'string') return field.type
  // The deprecated array/spdx forms, still present in older packages.
  if (Array.isArray(field)) {
    const named = field.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean)
    if (named.length > 0) return named.join(' OR ')
  }
  if (typeof manifest.licenses === 'string') return manifest.licenses
  if (Array.isArray(manifest.licenses)) {
    const named = manifest.licenses.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean)
    if (named.length > 0) return named.join(' OR ')
  }
  return undefined
}

/** Whether a package directory carries licence text of its own. */
function hasLicenceFile(dir) {
  // A PREFIX TEST, CASE-INSENSITIVE, because a fixed list was wrong by about 130 packages. Measured
  // on a real runtime tree, the names actually in use are: `LICENSE` (190), **`license` (121)**,
  // `LICENSE.txt`, `LICENSE.md`, `License`, `license.md`, `license-mit`, `license-cc0`, `licenses`,
  // `LICENSE-MIT.txt`, `COPYING`. A list of exact names reported every lower-case package as
  // shipping no licence — a false finding, in the one file whose purpose is to be trusted on it.
  try {
    return readdirSync(dir).some(isLicenceName)
  } catch {
    return false
  }
}

/**
 * Walk `node_modules` and describe every package, including scoped ones.
 *
 * @param nodeModules - the runtime tree's `node_modules` directory.
 * @returns `{ name, version, licence, hasText, dir }[]`, sorted by name.
 */
export function surveyPackages(nodeModules) {
  const found = []
  const walk = (dir, scope) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.name.startsWith('@')) {
        // A scope directory: its children are packages, and a scope may also be a package itself.
        walk(path, entry.name)
        continue
      }
      const manifestPath = join(path, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        continue
      }
      const name = manifest.name ?? (scope === undefined ? entry.name : `${scope}/${entry.name}`)
      const hasText = hasLicenceFile(path)
      found.push({
        name,
        version: typeof manifest.version === 'string' ? manifest.version : '',
        licence: licenceOf(manifest),
        hasText,
        // Which family's root licence covers it, when its own text is absent. Recorded here rather
        // than inferred later so the document can say "covered" instead of listing 297 names.
        rootLicence: hasText ? undefined : rootLicenceFor(name)?.licence,
        dir: path,
      })
    }
  }
  walk(nodeModules, undefined)
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** The font files an artifact carries, relative to the runtime tree. */
function fontsIn(runtimeDir) {
  const root = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets', 'fonts')
  if (!existsSync(root)) return { dir: undefined, files: [] }
  const files = readdirSync(root).filter((name) => /\.(woff2?|ttf|otf)$/iu.test(name))
  return { dir: root, files: files.sort() }
}

/**
 * Compose the notice document.
 *
 * @param options - runtime tree, the repository notice to reproduce, and the product version.
 * @returns the Markdown text.
 */
export function composeNotices({ runtimeDir, repositoryNotice, version }) {
  const packages = surveyPackages(join(runtimeDir, 'node_modules'))
  const fonts = fontsIn(runtimeDir)
  const withoutText = packages.filter((entry) => !entry.hasText)
  const lines = []

  lines.push('# Third-Party Notices', '')
  lines.push(`Qialike Desktop ${version}`, '')
  lines.push(
    'This file is generated when the runtime tree is assembled, so it describes the artifact it',
    'ships inside rather than the repository that produced it. It has three parts: what this',
    'project chose directly, an index of every package the runtime tree contains, and the full',
    'text of any licence that would otherwise be lost because its package was compiled into a',
    'bundle instead of being shipped as files.',
    '',
  )

  lines.push('## 1. What this project adds directly', '')
  // ITS OWN TITLE IS DROPPED, and the remaining headings are demoted by one. Reproduced verbatim the
  // repository file contributes a second `# Third-Party Notices`; demoted only by one it becomes a
  // `##` sitting beside the section headings of this document rather than under one. Dropping the
  // title and demoting the rest keeps exactly one H1 and a hierarchy that reads.
  const demoted = repositoryNotice
    .trim()
    .split('\n')
    .filter((line, index) => !(index === 0 && /^#\s/u.test(line)))
    .map((line) => (line.startsWith('#') ? `#${line}` : line))
    .join('\n')
  lines.push(demoted, '')

  lines.push('## 2. Every package in the runtime tree', '')
  lines.push(
    `${packages.length} packages. Licence identifiers are read from each package's own manifest.`,
    'The licence TEXT for each of these travels inside the package itself, as its own `LICENSE`',
    'file — reproducing 650 of them here would add megabytes to repeat what is already present.',
    'This index is what makes the tree auditable without the source checkout: a package that is',
    'absent from it is absent from the artifact.',
    '',
  )
  lines.push('| Package | Version | License | Text included |', '|---|---|---|---|')
  for (const entry of packages) {
    lines.push(`| ${entry.name} | ${entry.version || '—'} | ${entry.licence ?? '**not declared**'} | ${entry.hasText ? 'yes' : '**no**'} |`)
  }
  lines.push('')

  const covered = withoutText.filter((entry) => entry.rootLicence !== undefined)
  const uncovered = withoutText.filter((entry) => entry.rootLicence === undefined)
  if (covered.length > 0) {
    lines.push('### Packages whose licence text is at their source root', '')
    lines.push(
      `${covered.length} packages declare a licence in their manifest and carry no file of their own.`,
      'Their text is reproduced in §3, because the root file it lives in is not part of an artifact.',
      '',
    )
    for (const family of ROOT_LICENSED) {
      const members = covered.filter((entry) => entry.name.startsWith(family.prefix))
      if (members.length === 0) continue
      lines.push(`- \`${family.prefix}*\` — ${members.length} packages, ${family.licence}, © ${family.holder}; see §3`)
    }
    lines.push('')
  }
  if (uncovered.length > 0) {
    lines.push('### Packages that declare a licence and ship no text', '')
    lines.push(
      'Listed rather than hidden: an entry here is a package to check, not a defect to assume.',
      'These are ordinary npm packages whose text is absent from the registry tarball.',
      '',
    )
    for (const entry of uncovered) {
      lines.push(`- \`${entry.name}\`${entry.version ? ` ${entry.version}` : ''} — licence ${entry.licence ?? '**not declared**'}, no licence file`)
    }
    lines.push('')
  }

  lines.push('## 3. Licences carried here because they are not inside any package', '')
  lines.push(
    'Two shapes produce these. A package family built from a monorepo has one licence at its source',
    'root, not one per package. A package whose bytes are compiled into a bundle leaves no package',
    'behind at all. In both cases the text travels nowhere, so it is reproduced here — which is what',
    'makes the artifact satisfy the notice requirement on its own.',
    '',
  )
  for (const family of ROOT_LICENSED) {
    const members = packages.filter((entry) => entry.rootLicence === family.licence && entry.name.startsWith(family.prefix))
    if (members.length === 0) continue
    lines.push(`### ${family.prefix}* — ${family.licence}`, '')
    lines.push(`${members.length} packages, © ${family.holder}. The licence file lives at the monorepo root.`, '')
    lines.push('```text', family.text.trimEnd(), '```', '')
  }
  if (fonts.files.length > 0) {
    // A DISPLAY PATH, SO IT IS SPELLED ONE WAY ON EVERY HOST. `relative()` returns the host's
    // separator, and this string goes into a Markdown document that ships in the artifact: built on
    // Windows it read `node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\fonts`, so the same
    // release described the same tree two different ways depending on who built it, and the test
    // that asserts the path — written against the POSIX spelling — failed only on Windows.
    const fontsPath = relative(runtimeDir, fonts.dir).split(sep).join('/')
    lines.push(`Fonts present in \`${fontsPath}\`: ${fonts.files.length} files.`, '')
  }
  for (const entry of INLINED) {
    lines.push(`### ${entry.name}${entry.version ? ` ${entry.version}` : ''} — ${entry.licence}`, '')
    if (entry.homepage !== undefined) lines.push(`Homepage: ${entry.homepage}`, '')
    lines.push(`Present because: ${entry.evidence}.`, '')
    lines.push('```text', entry.text.trimEnd(), '```', '')
    if (entry.fontText !== undefined) {
      lines.push(`Font files: ${entry.fontLicence}.`, '')
      lines.push('```text', entry.fontText.trimEnd(), '```', '')
    }
  }

  lines.push('## 4. What this file does not do', '')
  lines.push(
    '- It does not reproduce the licence text of the 650 packages that ship their own. Read the',
    '  package, or read its row above to find it.',
    '- It does not cover Electron itself: `electron-builder` writes `LICENSE.electron.txt` and',
    '  `LICENSES.chromium.html` beside the application, which is where those belong.',
    '- It is not a legal opinion. It is a record of what is in the artifact and under what terms,',
    '  written so the answer does not depend on someone remembering to check.',
    '',
  )
  return lines.join('\n')
}

/**
 * Write `THIRD_PARTY_NOTICES.md` into a runtime tree.
 *
 * PLACEMENT MATTERS TWICE. It runs after `pruneNonRuntimeFiles`, because that step walks the whole
 * tree and a file written before it would be walked too; and before `writeRuntimeDescriptor`,
 * because the descriptor inventories the tree and this file is part of what an artifact contains.
 *
 * @param options - runtime tree, repository notice text, product version, and a logger.
 * @returns what was written.
 */
export function writeThirdPartyNotices({ runtimeDir, repositoryNotice, version, log = () => {} }) {
  const text = composeNotices({ runtimeDir, repositoryNotice, version })
  const path = join(runtimeDir, 'THIRD_PARTY_NOTICES.md')
  writeFileSync(path, text, 'utf8')
  const packages = surveyPackages(join(runtimeDir, 'node_modules')).length
  log(`notices: ${packages} packages indexed, ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KiB`)
  return { path, bytes: Buffer.byteLength(text, 'utf8'), packages }
}
