// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Multi-EXPORT-per-file ingest (task-3).
 *
 * A `.ap` module may hold several `EXPORT <KIND> <name>:` blocks. Each must be
 * independently importable and register under its OWN name and body, so:
 *   1. same-file composition — a block whose slot is `LIST <sibling>` resolves
 *      the sibling to its own block id;
 *   2. the shipped repro — importing `card, feature-card` from the real
 *      multi-template `card-formats.ap` resolves `AS feature-card`, which used to
 *      throw `unknown shape "feature-card"` because only the FIRST block (`card`)
 *      was ever registered.
 *
 * Uses the real bundle entry point (same harness as export-block-bundle-parity).
 */
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { bundleAgentToString } from '../dist/src/compiler/index.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- 1. Same-file composition: two templates in one file, b: LIST <a> ----------
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-multi-'));
  try {
    const tplDir = join(tmp, 'library', 'templates');
    mkdirSync(tplDir, { recursive: true });
    writeFileSync(join(tplDir, 'scaffolds.ap'), [
      '# scaffolds',
      '',
      'EXPORT TEMPLATE a:',
      '  ABOUT  one statement',
      '  SLOTS:',
      '    key: TEXT  "the key"',
      '  BODY:',
      '    {key}',
      '',
      'EXPORT TEMPLATE b:',
      '  ABOUT  a list of a',
      '  SLOTS:',
      '    steps: LIST <a> >=1  "one a per line"',
      '  BODY:',
      '    {steps}',
      '',
    ].join('\n'), 'utf-8');

    const agentDir = join(tmp, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const agentFile = join(agentDir, 'm-agent.ap');
    writeFileSync(agentFile, 'IMPORT a, b FROM library.templates\n\nEXPORT AGENT m-agent:\n    ABOUT  imports both templates\n', 'utf-8');

    const out = await bundleAgentToString({
      agentName: 'm-agent', agentFile, agentDir,
      libraryRoot: join(tmp, 'library'), libraryRoots: [join(tmp, 'library')],
    });

    assert.ok(/^##.*`a`/m.test(out), 'template `a` registered under its own section');
    assert.ok(/^##.*`b`/m.test(out), 'second EXPORT block `b` registered under its own section');
    assert.ok(out.includes('Produce **a**'), 'a renders its own body (own block)');
    assert.ok(out.includes('Produce **b**'), 'b renders its own body (own block)');
    // b's slot references its sibling a — same-file composition must resolve to its id.
    assert.ok(/list of \*\*a\*\* \(tpl-[0-9a-f]{8}\)/.test(out), 'b.steps LIST <a> resolves to its block id');
    console.log('multi-export: same-file composition (b: LIST <a>) ok');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// --- 2. Shipped repro: card-formats.ap holds several EXPORT TEMPLATE blocks ----
//        importing a non-first one (`feature-card`) and binding it via AS must
//        resolve. The fixture imports a verbatim copy of the real library
//        (test/fixtures/library), so the suite needs no project agents.
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-cardrepro-'));
  try {
    const mainLib = resolve(PROJECT_ROOT, 'test/fixtures/library');
    const agentDir = join(tmp, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const agentFile = join(agentDir, 'repro-agent.ap');
    writeFileSync(agentFile, [
      'IMPORT card, feature-card FROM @main.templates',
      '',
      'EXPORT AGENT repro-agent:',
      '    ABOUT  binds a non-first export of a multi-template module',
      '    LENS-OUT feature-card',
    ].join('\n') + '\n', 'utf-8');

    const out = await bundleAgentToString({
      agentName: 'repro-agent', agentFile, agentDir,
      libraryRoot: mainLib, libraryRoots: [mainLib],
      libraries: { '@main': mainLib },
    });

    assert.ok(/^##.*`card`/m.test(out), 'first export `card` still registered');
    assert.ok(/^##.*`feature-card`/m.test(out), 'non-first export `feature-card` now registered (was dropped)');
    // The agent's LENS-OUT binds `feature-card` via AS!: resolves to its section.
    assert.ok(/`feature-card` \(tpl-[0-9a-f]{8}\)/.test(out), 'AS feature-card resolves to its block id (repro fixed)');
    console.log('multi-export: shipped card-formats AS feature-card repro ok');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

console.log('multi-export-per-file tests passed.');
