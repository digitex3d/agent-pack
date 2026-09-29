// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildMetadataIndex } from '../dist/src/libraryIndex.js';
import { existsSync, readFileSync } from 'fs';


const tmp = mkdtempSync(join(tmpdir(), 'ap-libindex-'));

/**
 * Build a minimal Config-shaped object that points at a controlled temp tree.
 * Only the fields consumed by buildMetadataIndex are populated.
 */
function makeConfig(libraryRoot, sharedLibraries = []) {
  return {
    libraryRoot,
    sharedLibraries,
  };
}

try {
  // -----------------------------------------------------------------------
  // Fixture tree
  //
  //   <tmp>/
  //     policies/
  //       english.policy.ap          — no TAGS, WHEN, APPLIES
  //     procedures/
  //       coding/
  //         scripting/
  //           scaffold.procedure.ap  — TAGS declared
  //     playbooks/
  //       security/
  //         scan.playbook.ap        — WHEN + APPLIES declared
  // -----------------------------------------------------------------------

  mkdirSync(join(tmp, 'policies'), { recursive: true });
  writeFileSync(
    join(tmp, 'policies', 'english.policy.ap'),
    [
      '# english',
      'ABOUT  write in english only',
      'TAGS #english',
      'ALWAYS write in English',
    ].join('\n'),
    'utf-8',
  );

  mkdirSync(join(tmp, 'procedures', 'coding', 'scripting'), { recursive: true });
  writeFileSync(
    join(tmp, 'procedures', 'coding', 'scripting', 'scaffold.procedure.ap'),
    [
      '# scaffold-bash',
      'ABOUT  scaffold a bash script',
      'TAGS #bash #scripting #coding',
      'PROCEDURE scaffold-bash',
      '  DO write strict-mode header',
    ].join('\n'),
    'utf-8',
  );

  mkdirSync(join(tmp, 'playbooks', 'security'), { recursive: true });
  writeFileSync(
    join(tmp, 'playbooks', 'security', 'scan.playbook.ap'),
    [
      '# security-scan',
      'ABOUT  run a security scan',
      'TAGS #security',
      'APPLIES requires:security-role enable for agents with security clearance',
      'WHEN a security vulnerability is reported',
      'DO run the scanner',
    ].join('\n'),
    'utf-8',
  );

  // EXPORT AGENT block — first-class agent unit, kind resolved to 'agent'.
  mkdirSync(join(tmp, 'agents'), { recursive: true });
  writeFileSync(
    join(tmp, 'agents', 'simplifier-impl.agent.ap'),
    [
      'EXPORT AGENT simplifier-impl AS simplifier:',
      '  ABOUT  the lean implementer',
      '  TAGS #identity',
      '  MANDATE keep it lean',
    ].join('\n'),
    'utf-8',
  );

  const config = makeConfig(tmp);
  const index = buildMetadataIndex(config);

  // -----------------------------------------------------------------------
  // EXPORT AGENT block enters the library pipeline with kind 'agent'
  // -----------------------------------------------------------------------
  const agentKey = Object.keys(index.exports).find(k => k.includes('simplifier-impl'));
  assert.ok(agentKey, 'EXPORT AGENT block appears in exports');
  const agentEntry = index.exports[agentKey];
  assert.equal(agentEntry.kind, 'agent', 'EXPORT AGENT block indexed with kind agent');
  assert.equal(agentEntry.name, 'simplifier-impl');
  assert.equal(agentEntry.about, 'the lean implementer');

  // -----------------------------------------------------------------------
  // english policy — no TAGS, no WHEN, no APPLIES → derived tags from namespace
  //
  // namespace = library.policies (no sub-path segments beyond 'policies')
  // kind segment = policies → stripped → [] → empty derived tags
  // -----------------------------------------------------------------------
  const englishKey = Object.keys(index.exports).find(k => k.includes('english'));
  assert.ok(englishKey, 'english policy appears in modules');
  const eng = index.exports[englishKey];

  assert.equal(eng.name, 'english');
  assert.equal(eng.kind, 'policy');
  assert.equal(eng.about, 'write in english only');
  assert.deepEqual(eng.tags, ['#english'], 'TAGS #english declared');
  assert.equal(eng.when, 'always', 'absent WHEN → "always"');
  assert.equal(eng.applies, null, 'absent APPLIES → null');
  assert.ok(eng.sizeBytes > 0, 'sizeBytes is measured and positive');

  // -----------------------------------------------------------------------
  // scaffold procedure — declared TAGS
  // -----------------------------------------------------------------------
  const scaffoldKey = Object.keys(index.exports).find(k => k.includes('scaffold'));
  assert.ok(scaffoldKey, 'scaffold procedure appears in modules');
  const scaffold = index.exports[scaffoldKey];

  assert.equal(scaffold.kind, 'procedure');
  assert.deepEqual(scaffold.tags.sort(), ['#bash', '#coding', '#scripting'].sort());
  assert.equal(scaffold.when, 'always');
  assert.equal(scaffold.applies, null);

  // -----------------------------------------------------------------------
  // security scan playbook — WHEN + APPLIES
  // TAGS absent → tags = [] (no namespace-derivation; metadata is read, not synthesized)
  // applies is the raw verbatim string after the APPLIES keyword
  // -----------------------------------------------------------------------
  const scanKey = Object.keys(index.exports).find(k => k.includes('scan') || k.includes('security-scan'));
  assert.ok(scanKey, 'security-scan playbook appears in modules');
  const scan = index.exports[scanKey];

  assert.equal(scan.kind, 'playbook');
  assert.equal(scan.when, 'a security vulnerability is reported');
  assert.ok(scan.applies !== null, 'APPLIES is present');
  assert.ok(scan.applies.startsWith('requires:security-role'), 'APPLIES raw text preserved verbatim');
  assert.deepEqual(scan.tags, ['#security']);

  // -----------------------------------------------------------------------
  // byTag inverse index
  // -----------------------------------------------------------------------
  assert.ok(Array.isArray(index.byTag['#bash']), '#bash present in byTag');
  assert.ok(index.byTag['#bash'].includes(scaffoldKey), 'scaffold key under #bash');
  // scan has TAGS #security, so it appears in byTag['#security']
  assert.ok(Array.isArray(index.byTag['#security']), '#security present in byTag');
  assert.ok(index.byTag['#security'].includes(scanKey), 'scan key in #security');
  assert.equal(index.byTag['#bash'].length, 1, '#bash has exactly one entry');

  assert.ok(Array.isArray(index.errors), 'errors field is present');
  assert.equal(index.errors.length, 0, 'no errors for fully-tagged fixtures');

  // -----------------------------------------------------------------------
  // namespace/name key format: "<namespace>/<name>"
  // -----------------------------------------------------------------------
  for (const key of Object.keys(index.exports)) {
    const entry = index.exports[key];
    assert.equal(key, `${entry.namespace}/${entry.name}`, `key must be <namespace>/<name> for ${key}`);
  }

  console.log('Library index tests passed.');
} finally {
  rmSync(tmp, { recursive: true });
}
