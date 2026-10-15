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
  //       english.policy.ap          — no APPLIES, WHEN, APPLIES
  //     procedures/
  //       coding/
  //         scripting/
  //           scaffold.procedure.ap  — APPLIES declared
  //     skills/
  //       security/
  //         scan.ap                 — WHEN + APPLIES declared
  // -----------------------------------------------------------------------

  mkdirSync(join(tmp, 'policies'), { recursive: true });
  writeFileSync(
    join(tmp, 'policies', 'english.policy.ap'),
    [
      '# english',
      'ABOUT  write in english only',
      'APPLIES #english',
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
      'APPLIES #bash #scripting #coding',
      'PROCEDURE scaffold-bash',
      '  DO write strict-mode header',
    ].join('\n'),
    'utf-8',
  );

  mkdirSync(join(tmp, 'skills', 'security'), { recursive: true });
  writeFileSync(
    join(tmp, 'skills', 'security', 'scan.ap'),
    [
      '# security-scan',
      'ABOUT  run a security scan',
      'APPLIES #security agent:auditor',
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
      '  APPLIES #identity',
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
  // english policy — APPLIES with tags only, no WHEN → derived tags from namespace
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
  assert.deepEqual(eng.tags, ['#english'], 'APPLIES #english declared');
  assert.equal(eng.when, 'always', 'absent WHEN → "always"');
  assert.deepEqual(eng.scopes, [], 'no perimeter token → no scopes');
  assert.ok(eng.sizeBytes > 0, 'sizeBytes is measured and positive');

  // -----------------------------------------------------------------------
  // scaffold procedure — declared APPLIES
  // -----------------------------------------------------------------------
  const scaffoldKey = Object.keys(index.exports).find(k => k.includes('scaffold'));
  assert.ok(scaffoldKey, 'scaffold procedure appears in modules');
  const scaffold = index.exports[scaffoldKey];

  assert.equal(scaffold.kind, 'procedure');
  assert.deepEqual(scaffold.tags.sort(), ['#bash', '#coding', '#scripting'].sort());
  assert.equal(scaffold.when, 'always');
  assert.deepEqual(scaffold.scopes, []);

  // -----------------------------------------------------------------------
  // security scan skill (a legacy file-as-unit) — WHEN + APPLIES
  // APPLIES carries a tag and a perimeter token: the tag lands in tags, the token in scopes
  // -----------------------------------------------------------------------
  const scanKey = Object.keys(index.exports).find(k => k.includes('scan') || k.includes('security-scan'));
  assert.ok(scanKey, 'security-scan skill appears in modules');
  const scan = index.exports[scanKey];

  assert.equal(scan.kind, 'skill');
  assert.equal(scan.when, 'a security vulnerability is reported');
  assert.deepEqual(scan.scopes, ['agent:auditor'], 'the perimeter token lands in scopes');
  assert.deepEqual(scan.tags, ['#security']);

  // -----------------------------------------------------------------------
  // byTag inverse index
  // -----------------------------------------------------------------------
  assert.ok(Array.isArray(index.byTag['#bash']), '#bash present in byTag');
  assert.ok(index.byTag['#bash'].includes(scaffoldKey), 'scaffold key under #bash');
  // scan has APPLIES #security, so it appears in byTag['#security']
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
