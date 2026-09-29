// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Integration test: metadata keywords (APPLIES, TAGS, OWNS) declared
 * in an imported library module must NOT appear in the compiled agent bundle.
 *
 * Regression for: imported module bodies were inlined via ingestRaw without
 * stripping AGENT_METADATA_KEYWORDS — only ABOUT was stripped.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bundleAgentToString } from '../dist/src/compiler/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'ap-import-leak-'));

try {
  // ---- fixture library ----------------------------------------------------
  const libraryRoot = join(tmp, 'library');
  const policiesDir = join(libraryRoot, 'policies');
  mkdirSync(policiesDir, { recursive: true });

  // A policy module that carries APPLIES and TAGS (catalog metadata) plus real rule content.
  // OWNS is an agent-dir-only keyword not valid in library policy files.
  writeFileSync(
    join(policiesDir, 'test-rules.ap'),
    [
      '# test-rules',
      'ABOUT  rules used in import-metadata-leak test',
      'APPLIES universal — every agent that imports this',
      'TAGS #test-tag #leak-check',
      'ALWAYS follow the test-rules policy',
      'NEVER skip the test-rules policy',
    ].join('\n') + '\n',
    'utf-8',
  );

  // ---- fixture agent -------------------------------------------------------
  const agentDir = join(tmp, 'agent');
  mkdirSync(agentDir, { recursive: true });

  const agentFile = join(agentDir, 'leak-check-agent.ap');
  writeFileSync(
    agentFile,
    [
      'IMPORT test-rules FROM library.policies',
      '',
      'EXPORT AGENT leak-check-agent:',
      '    ABOUT  agent that imports a module with metadata keywords',
    ].join('\n') + '\n',
    'utf-8',
  );

  // ---- run the real bundle pipeline ----------------------------------------
  const output = await bundleAgentToString({
    agentName: 'leak-check-agent',
    agentFile,
    agentDir,
    libraryRoot,
    libraryRoots: [libraryRoot],
  });

  // Metadata keywords (APPLIES, TAGS) must NOT appear as raw `KEYWORD …` lines:
  // those are compiler directives, not rendered content. The tag *tokens*
  // (`#test-tag`, `#leak-check`) MAY appear inside an inline `Tags:` summary
  // for the entry that declared them — this is intentional surfacing of
  // explicit (non-breadcrumb-derived) tags for cross-reference.
  assert.ok(!output.match(/^APPLIES\b/m),   'APPLIES line must not appear in rendered bundle');
  assert.ok(!output.match(/^TAGS\b/m),      'TAGS line must not appear in rendered bundle');
  assert.ok(!output.includes('every agent that imports this'), 'APPLIES payload must not appear');

  // (b) the module's real rule text IS present
  assert.ok(output.includes('follow the test-rules policy'), 'ALWAYS rule text is present in bundle');
  assert.ok(output.includes('skip the test-rules policy'),  'NEVER rule text is present in bundle');

  console.log('import-metadata-leak integration test passed.');

} finally {
  rmSync(tmp, { recursive: true });
}
