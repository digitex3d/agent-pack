// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Bundle-level oracle for the EXPORT block-scoped ingest seam.
 *
 * Fixture: the SAME policy module authored two ways — legacy (file-top
 * ABOUT/TAGS/APPLIES, body at indent 0) and migrated (`EXPORT POLICY <name>:`
 * with metadata + body as block children). Both are imported by an identical
 * agent and run through the real bundle pipeline.
 *
 * Acceptance (task block-scoped-ingest, requirement 4):
 *   - the bundled output is BYTE-IDENTICAL between the two forms;
 *   - the `EXPORT <KIND> <name>:` opener never appears in the bundle;
 *   - ABOUT / TAGS / APPLIES metadata never leaks into the agent prompt.
 *
 * Mirrors the harness of import-metadata-leak.test.mjs (same real entry point).
 */
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bundleAgentToString } from '../dist/src/compiler/index.js';

/** Bundle an agent that imports a single policy module with the given source text. */
async function bundlePolicy(policyText) {
  const tmp = mkdtempSync(join(tmpdir(), 'ap-export-parity-'));
  try {
    const libraryRoot = join(tmp, 'library');
    const policiesDir = join(libraryRoot, 'policies');
    mkdirSync(policiesDir, { recursive: true });
    writeFileSync(join(policiesDir, 'ctx.ap'), policyText, 'utf-8');

    const agentDir = join(tmp, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const agentFile = join(agentDir, 'parity-agent.ap');
    writeFileSync(agentFile, ['IMPORT ctx FROM library.policies', '', 'EXPORT AGENT parity-agent:', '    ABOUT  agent that imports the ctx policy'].join('\n') + '\n', 'utf-8');

    return await bundleAgentToString({
      agentName: 'parity-agent', agentFile,
      agentDir,
      libraryRoot,
      libraryRoots: [libraryRoot],
    });
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// Same module, two authored forms.
const LEGACY = [
  '# ctx',
  'ABOUT  context-engineering rules for multi-agent work',
  'TAGS   #context-engineering #multi-agent #orchestration',
  'APPLIES universal — every agent participating respects these',
  'ALWAYS  engineer the informational environment as a structured blueprint',
  'ALWAYS  chain context: feed each step output as the typed input of the next',
  'NEVER  rely on a single shared prompt across multiple agents',
].join('\n') + '\n';

// EXPORT form exactly as the codemod emits it (opener at indent 0, metadata +
// body re-indented one step as block children).
const EXPORTED = [
  '# ctx',
  'EXPORT POLICY ctx:',
  '  ABOUT  context-engineering rules for multi-agent work',
  '  TAGS   #context-engineering #multi-agent #orchestration',
  '  APPLIES universal — every agent participating respects these',
  '',
  '  ALWAYS  engineer the informational environment as a structured blueprint',
  '  ALWAYS  chain context: feed each step output as the typed input of the next',
  '  NEVER  rely on a single shared prompt across multiple agents',
].join('\n') + '\n';

const legacyBundle = await bundlePolicy(LEGACY);
const exportBundle = await bundlePolicy(EXPORTED);

// --- Core criterion: byte-identical bundle output -------------------------
if (legacyBundle !== exportBundle) {
  const la = legacyBundle.split('\n');
  const ea = exportBundle.split('\n');
  for (let i = 0; i < Math.max(la.length, ea.length); i++) {
    if (la[i] !== ea[i]) {
      console.error(`first diff at line ${i + 1}:`);
      console.error(`  legacy: ${JSON.stringify(la[i])}`);
      console.error(`  export: ${JSON.stringify(ea[i])}`);
      break;
    }
  }
}
assert.equal(exportBundle, legacyBundle, 'EXPORT-form bundle must be byte-identical to the legacy-form bundle');

// --- Zero leakage of the EXPORT opener and metadata into the prompt -------
assert.ok(!/EXPORT/.test(exportBundle), 'EXPORT opener must not appear in the bundle');
assert.ok(!/^\s*ABOUT\b/m.test(exportBundle), 'ABOUT line must not appear in the bundle');
assert.ok(!/^\s*TAGS\b/m.test(exportBundle), 'TAGS line must not appear in the bundle');
assert.ok(!/^\s*APPLIES\b/m.test(exportBundle), 'APPLIES line must not appear in the bundle');
assert.ok(!exportBundle.includes('universal — every agent participating respects these'), 'APPLIES payload must not leak');

// --- The real rule body IS present (the unit content survived) ------------
assert.ok(exportBundle.includes('engineer the informational environment as a structured blueprint'), 'ALWAYS rule text present');
assert.ok(exportBundle.includes('rely on a single shared prompt across multiple agents'), 'NEVER rule text present');

console.log('EXPORT block bundle-parity oracle passed (byte-identical, zero leakage).');
