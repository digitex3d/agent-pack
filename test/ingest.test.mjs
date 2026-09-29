// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ingestFile, kindFromDir, unitKindOf, deriveNamespace } from '../dist/src/ingest.js';

// --- kindFromDir: the dir-fallback. The kind comes from the kind-folder, never
//     a filename suffix. ---

assert.equal(kindFromDir('/lib/policies/foo.ap'), 'policy');
assert.equal(kindFromDir('/lib/playbooks/foo.ap'), 'playbook');
assert.equal(kindFromDir('/lib/procedures/foo.ap'), 'procedure');
assert.equal(kindFromDir('/lib/templates/foo.ap'), 'template');
assert.equal(kindFromDir('/lib/roles/foo.ap'), 'role');
assert.equal(kindFromDir('/lib/tools/foo.ap'), 'tool');
assert.equal(kindFromDir('/lib/agents/foo.ap'), 'generic', 'no kind-folder → generic');
// The suffix plays no role: a flat `<name>.ap` in a kind-folder takes the folder.
assert.equal(kindFromDir('/lib/policies/foo.policy.ap'), 'policy', 'suffix is irrelevant — dir decides');
// Deepest kind-folder wins so a build-output ancestor named like a kind-folder
// (e.g. a top-level `templates/`) does not poison nested kinds.
assert.equal(kindFromDir('/proj/templates/library/policies/foo.ap'), 'policy', 'deepest kind-folder wins');
assert.equal(kindFromDir('/proj/templates/library/templates/foo.ap'), 'template', 'inner templates wins');

// --- unitKindOf: block-first, then dir-fallback. ---

assert.equal(unitKindOf('/lib/policies/x.ap', 'POLICY english\nALWAYS write in English\n'), 'policy',
  'top-level POLICY block names the kind');
assert.equal(unitKindOf('/lib/whatever/x.ap', 'EXPORT TEMPLATE foo:\n  SLOTS:\n    a: TEXT "x"\n'), 'template',
  'EXPORT block KIND names the kind regardless of dir');
assert.equal(unitKindOf('/lib/playbooks/x.ap', '# x\nWHEN something:\n  DO act\n'), 'playbook',
  'no kind block → dir-fallback to playbook');
assert.equal(unitKindOf('/lib/elsewhere/x.ap', '# x\n\nbody only\n'), 'generic',
  'no kind block and no kind-folder → generic');

const tmp = mkdtempSync(join(tmpdir(), 'ap-ingest-'));

try {
  // --- Template: kind from the `templates/` folder, name from TEMPLATE keyword ---
  {
    const dir = join(tmp, 'templates');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'bug-report.ap');
    writeFileSync(file, [
      '# bug-report',
      '',
      'ABOUT  shape of a bug report',
      '',
      'TEMPLATE bug-report',
      '  summary: <summary>',
      '  repro: <steps>',
    ].join('\n'), 'utf-8');

    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'template');
    assert.equal(r.name, 'bug-report', 'name from TEMPLATE keyword');
    assert.equal(r.about, 'shape of a bug report');
    assert.equal(r.namespace, 'library.templates', 'namespace derived from directory path relative to library root');
    assert.ok(!r.body.includes('# bug-report'), 'H1 stripped');
    assert.ok(!r.body.match(/^ABOUT/m), 'ABOUT stripped');
    assert.ok(r.body.match(/^TEMPLATE bug-report$/m), 'TEMPLATE keyword line preserved in body');
    assert.ok(r.body.includes('summary: <summary>'), 'body content preserved');
    assert.ok(r.body.includes('repro: <steps>'));
  }

  // --- Template: kind from folder, name from H1 when keyword missing ---
  {
    const dir = join(tmp, 'templates', 'sub1');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'fallback.ap');
    writeFileSync(file, '# header\n\nbody only\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'template');
    // No TEMPLATE keyword: falls back to H1 (per priority: structural keyword > H1 > filename)
    assert.equal(r.name, 'header');
  }

  // --- Template: name from filename when no keyword and no H1 ---
  {
    const dir = join(tmp, 'templates', 'sub2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'no-headers.ap');
    writeFileSync(file, 'just body text\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'template');
    assert.equal(r.name, 'no-headers');
  }

  // --- Policy: kind from the `policies/` folder, name from POLICY keyword ---
  {
    const dir = join(tmp, 'policies');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'p.ap');
    writeFileSync(file, [
      '# english',
      'ABOUT  english only',
      'POLICY english',
      'ALWAYS write in English',
    ].join('\n'), 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'policy');
    assert.equal(r.name, 'english', 'name from POLICY keyword');
    assert.equal(r.about, 'english only');
    assert.ok(r.body.includes('ALWAYS write in English'));
  }

  // --- Generic: name from H1 ---
  {
    const dir = join(tmp, 'generic');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'whatever.ap');
    writeFileSync(file, '# my generic\n\nABOUT  generic about\n\nbody\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'generic');
    assert.equal(r.name, 'my generic');
    assert.equal(r.about, 'generic about');
  }

  // --- Generic: filename fallback when no H1 ---
  {
    const dir = join(tmp, 'generic2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'plain.ap');
    writeFileSync(file, 'just body\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.name, 'plain');
  }

  // --- Namespace: derived from directory path relative to library root ---
  {
    const root = join(tmp, 'lib');
    mkdirSync(join(root, 'policies', 'coding', 'quality'), { recursive: true });
    const file = join(root, 'policies', 'coding', 'quality', 'dry.ap');
    writeFileSync(file, '# dry\nABOUT  do not repeat\nPOLICY dry\nALWAYS DRY\n', 'utf-8');

    const r = ingestFile(file, { libraryRoot: root });
    assert.equal(r.namespace, 'library.policies.coding.quality', 'namespace is dotted path relative to library root');
    assert.equal(r.kind, 'policy');
    assert.equal(r.name, 'dry');
  }

  // --- Namespace: file at library root level gets just the prefix ---
  {
    const root = join(tmp, 'root-level');
    mkdirSync(root, { recursive: true });
    const file = join(root, 'x.ap');
    writeFileSync(file, 'POLICY x\nABOUT  whatever\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: root });
    assert.equal(r.namespace, 'library', 'file at root level gets bare library prefix');
  }

  // --- Namespace: file outside libraryRoot returns empty string ---
  {
    const outside = mkdtempSync(join(tmpdir(), 'ap-outside-'));
    try {
      const file = join(outside, 'x.ap');
      writeFileSync(file, 'POLICY x\n', 'utf-8');
      assert.equal(deriveNamespace(file, tmp), '', 'file outside libraryRoot must return empty namespace');
    } finally {
      rmSync(outside, { recursive: true });
    }
  }

  // --- Namespace: alias-qualified via libraries map ---
  {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ap-project-'));
    const sharedRoot = mkdtempSync(join(tmpdir(), 'ap-shared-'));
    try {
      mkdirSync(join(sharedRoot, 'policies', 'web'), { recursive: true });
      const file = join(sharedRoot, 'policies', 'web', 'no-inline-style.ap');
      writeFileSync(file, 'POLICY no-inline-style\nNEVER use inline styles\n', 'utf-8');

      // project root does not contain the file — must still resolve via sharedRoot
      const ns = deriveNamespace(file, [projectRoot, sharedRoot], { '@shared': sharedRoot });
      assert.equal(ns, '@shared.policies.web', 'namespace uses alias prefix when libraries map is provided');
    } finally {
      rmSync(projectRoot, { recursive: true });
      rmSync(sharedRoot, { recursive: true });
    }
  }

  // --- Agent: kind from the EXPORT AGENT block (flat `<name>.ap`), name from the block ---
  {
    // No `.agent.ap` suffix: a flat agent file is detected by its block, not its name.
    assert.equal(kindFromDir('/agents/foo.ap'), 'generic');
    assert.equal(unitKindOf('simplifier-impl.ap',
      'EXPORT AGENT simplifier-impl AS simplifier:\n  MANDATE keep it lean\n'), 'agent');

    const dir = join(tmp, 'agents');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'simplifier-impl.ap');
    writeFileSync(file, [
      'EXPORT AGENT simplifier-impl AS simplifier:',
      '  ABOUT  the lean implementer',
      '  MANDATE keep it lean',
    ].join('\n'), 'utf-8');

    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'agent');
    assert.equal(r.name, 'simplifier-impl', 'name from the EXPORT AGENT block, AS clause excluded');
    assert.equal(r.about, 'the lean implementer');
  }

  // --- A `.ap` file with no EXPORT AGENT block is generic, not an agent ---
  {
    const dir = join(tmp, 'agents2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'fallback.ap');
    writeFileSync(file, '# fallback-header\n\nbody only\n', 'utf-8');
    const r = ingestFile(file, { libraryRoot: tmp });
    assert.equal(r.kind, 'generic', 'no EXPORT AGENT block: not an agent kind');
    assert.equal(r.name, 'fallback-header', 'falls back to H1 for the name');
  }

  // --- File not found throws ---
  {
    assert.throws(
      () => ingestFile(join(tmp, 'does-not-exist.ap'), { libraryRoot: tmp }),
      /file not found/,
    );
  }
} finally {
  rmSync(tmp, { recursive: true });
}

console.log('Ingest tests passed.');
