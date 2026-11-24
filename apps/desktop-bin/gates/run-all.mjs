#!/usr/bin/env node
/**
 * Run every build gate against an existing farm.
 *
 * Gates are separate from the build on purpose: the build proves the farm can be
 * produced, the gates prove the produced farm is one this application can
 * actually compose. Keeping them callable on their own lets CI run them against
 * a cached farm without paying for the copy again.
 *
 * @module qialike-desktop/gates/run-all
 */

import { existsSync } from 'node:fs'
import { FARM_DIR } from '../lib/paths.mjs'
import * as profileBundles from './profile-bundles.mjs'
import * as runtimeTree from './runtime-tree.mjs'
import * as uiFreeShared from './ui-free-shared.mjs'

/**
 * Every gate, with how to invoke it.
 *
 * Each returns `{ ok, violations }` and exposes a `format`. A gate needing no
 * farm ignores its argument.
 */
const GATES = [
  { name: 'ui-free-shared', module: uiFreeShared, needsFarm: false },
  { name: 'profile-bundles', module: profileBundles, needsFarm: true },
  { name: 'runtime-tree', module: runtimeTree, needsFarm: true },
]

const farmMissing = !existsSync(FARM_DIR)
const results = []
for (const gate of GATES) {
  if (gate.needsFarm && farmMissing) {
    results.push({ name: gate.name, ok: false, output: `${gate.name}: SKIPPED — no farm at ${FARM_DIR}; run the build first` })
    continue
  }
  const result = gate.module.run(FARM_DIR)
  results.push({ name: gate.name, ok: result.ok, output: gate.module.format(result) })
}

for (const result of results) process.stdout.write(`${result.output}\n`)

const failed = results.filter((result) => !result.ok)
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length} of ${results.length} gate(s) failed\n`)
  process.exit(1)
}
process.stdout.write(`\nall ${results.length} gate(s) passed\n`)
