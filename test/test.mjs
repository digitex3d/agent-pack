// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { strict as assert } from 'assert';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const COMMON_LIB = resolve(PROJECT_ROOT, '../common');

// --- Lint tests (rule grammar) ---

const { lintPolicy, lintPlaybook, lintProcedure, lintTemplate } = await import('../dist/src/lint.js');

{
  const ok = lintPolicy('english.policy.ap', `# english\nABOUT english only\nALWAYS write in English\nNEVER mix languages\n`);
  assert.equal(ok.length, 0, 'valid policy should have no errors');

  const bad = lintPolicy('bad.policy.ap', `# bad\nSHOULD do something\n`);
  assert.ok(bad.length > 0, 'SHOULD keyword should be rejected');
}

{
  const ok = lintPlaybook('ok.playbook.ap', `# ok\nABOUT ok\nWHEN a AND b\nDO something\n`);
  assert.equal(ok.length, 0, 'AND-joined trigger should be accepted');

  const orErr = lintPlaybook('or.playbook.ap', `# or\nABOUT or\nWHEN a OR b\nDO something\n`);
  assert.ok(orErr.some(e => /OR not supported/.test(e.message)), 'OR should be rejected');

  const trailing = lintPlaybook('tr.playbook.ap', `# tr\nABOUT tr\nWHEN a AND \nDO something\n`);
  assert.ok(trailing.some(e => /AND must join non-empty/.test(e.message)), 'trailing AND should be rejected');
}

{
  const ifOr = lintPlaybook('iff.playbook.ap', `# iff\nABOUT iff\nWHEN x\nIF a OR b\n  THEN DO y\n`);
  assert.ok(ifOr.some(e => /IF trigger.*OR not supported/.test(e.message)), 'IF with OR should be rejected');
}

{
  // TAGS validation: valid payload passes, invalid forms produce lint errors
  const validTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nTAGS #typescript #code-review #bash\nALWAYS do something\n`);
  assert.equal(validTags.length, 0, 'valid TAGS payload should produce no errors');

  // Bare TAGS (no payload) is lexed as unknown → rejected as unexpected line
  const emptyTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nTAGS\nALWAYS do something\n`);
  assert.ok(emptyTags.length > 0, 'empty TAGS should be rejected');

  const commaTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nTAGS #a, #b\nALWAYS do something\n`);
  assert.ok(commaTags.some(e => /TAGS token/.test(e.message)), 'comma-separated TAGS should be rejected');

  const slashTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nTAGS #coding/scripting\nALWAYS do something\n`);
  assert.ok(slashTags.some(e => /TAGS token/.test(e.message)), 'hierarchical slash TAGS should be rejected');

  const noHash = lintPolicy('t.policy.ap', `# t\nABOUT t\nTAGS typescript\nALWAYS do something\n`);
  assert.ok(noHash.some(e => /TAGS token/.test(e.message)), 'TAGS token without # should be rejected');
}

console.log('Lint tests passed.');

// --- Block-scoped lint (EXPORT) ---
{
  // EXPORT block missing ABOUT → error
  const noAbout = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY needs-about:\n    TAGS #x\n    ALWAYS do something\n`);
  assert.ok(noAbout.some(e => /exported block requires ABOUT/.test(e.message)),
    'EXPORT block without ABOUT should error');

  // EXPORT block with ABOUT + TAGS + APPLIES → clean
  const full = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY ctx:\n    ABOUT context rules\n    TAGS #multi-agent\n    APPLIES universal\n    ALWAYS engineer the environment\n    NEVER rely on one prompt\n`);
  assert.equal(full.length, 0, 'EXPORT block with ABOUT+TAGS+APPLIES should be clean');

  // EXPORT block without TAGS → clean (TAGS optional)
  const noTags = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY ctx:\n    ABOUT context rules\n    ALWAYS engineer the environment\n`);
  assert.equal(noTags.length, 0, 'EXPORT block without TAGS should be clean (optional)');

  // EXPORT TEMPLATE with nested SLOTS body → clean (nested lines not flagged)
  const tpl = lintTemplate('handoff-digest.template.ap',
    `# t\nEXPORT TEMPLATE handoff-digest:\n    ABOUT digest shape for inter-agent handoff\n    SLOTS:\n        summary: TEXT MAX_WORDS 40 "..."\n`);
  assert.equal(tpl.length, 0, 'EXPORT TEMPLATE with nested SLOTS should be clean');

  // Mixed file: EXPORT block + file-top metadata → error on the file-top metadata
  const mixed = lintPolicy('ctx.policy.ap',
    `# p\nABOUT file-top about\nTAGS #stray\nEXPORT POLICY ctx:\n    ABOUT block about\n    ALWAYS do something\n`);
  assert.ok(mixed.some(e => /file-top is not allowed/.test(e.message) && e.line === 2),
    'file-top ABOUT in an EXPORT file should error');
  assert.ok(mixed.some(e => /file-top is not allowed/.test(e.message) && e.line === 3),
    'file-top TAGS in an EXPORT file should error');

  // Private (non-export) block carrying metadata alongside an EXPORT block → inert
  const privateBlock = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY pub:\n    ABOUT public about\n    ALWAYS do public\n\nPOLICY helper:\n    ABOUT inert about\n    APPLIES universal\n    ALWAYS do helper\n`);
  assert.equal(privateBlock.length, 0,
    'metadata inside a private block should be inert (no error)');

  // Legacy file (no EXPORT block) → unchanged, clean
  const legacy = lintPolicy('ctx.policy.ap',
    `# p\nABOUT context rules\nTAGS #multi-agent\nALWAYS engineer the environment\nNEVER rely on one prompt\n`);
  assert.equal(legacy.length, 0, 'legacy file-top policy should be unchanged (clean)');

  // Legacy file still requires ABOUT (file-top rule not retired)
  const legacyNoAbout = lintPolicy('ctx.policy.ap', `# p\nALWAYS do something\n`);
  assert.ok(legacyNoAbout.some(e => /missing ABOUT/.test(e.message)),
    'legacy file without ABOUT still errors (file-top rule intact)');
}

console.log('Block-scoped lint (EXPORT) tests passed.');

// --- Project context: PROJECT.ap → AGENTS.md block, harness pointers ---

{
  const { emitProjectContext, ensureProjectPointers } = await import('../dist/src/projectContext.js');
  const { loadConfig } = await import('../dist/src/config.js');
  const { default: claudeCodeAdapter } = await import('../dist/adapters/claude-code/index.js');
  const { existsSync, readFileSync } = await import('fs');

  const tmp = '/tmp/agent-pack-project-context-test';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'library'), { recursive: true });

  const prevCwd = process.cwd();
  process.chdir(tmp);

  // PROJECT.ap missing → false, nothing written
  let config = await loadConfig([]);
  assert.equal(await emitProjectContext(tmp, config), false, 'no PROJECT.ap → no-op');
  assert.equal(existsSync(join(tmp, 'AGENTS.md')), false, 'no AGENTS.md written when PROJECT.ap is absent');

  // PROJECT.ap present → compiled into the project block of AGENTS.md
  writeFileSync(join(tmp, 'PROJECT.ap'), [
    '# Project Rules',
    '',
    'ABOUT  always-on rules',
    '',
    'Use TypeScript strict mode.',
    'You MUST run tests before merging.',
    '',
  ].join('\n'), 'utf-8');
  config = await loadConfig([]);
  assert.equal(await emitProjectContext(tmp, config), true, 'PROJECT.ap present → written');
  let out = readFileSync(join(tmp, 'AGENTS.md'), 'utf-8');
  assert.ok(out.includes('<!-- agent-pack:project:start -->'), 'content lives in a managed block');
  assert.ok(out.includes('Use TypeScript strict mode.'), 'body content preserved');
  assert.ok(!out.includes('ABOUT  always-on rules'), 'ABOUT keyword stripped');

  // The user's own text in AGENTS.md survives a rebuild
  writeFileSync(join(tmp, 'AGENTS.md'), `My own notes.\n\n${out}`, 'utf-8');
  await emitProjectContext(tmp, config);
  out = readFileSync(join(tmp, 'AGENTS.md'), 'utf-8');
  assert.ok(out.startsWith('My own notes.'), 'text outside the managed block is untouched');
  assert.equal(out.split('agent-pack:project:start').length, 2, 'the block is replaced, not duplicated');

  // Claude Code gets a pointer: CLAUDE.md imports AGENTS.md
  assert.deepEqual(ensureProjectPointers(tmp, [claudeCodeAdapter()]), ['CLAUDE.md'], 'pointer written');
  assert.ok(readFileSync(join(tmp, 'CLAUDE.md'), 'utf-8').includes('@AGENTS.md'), 'CLAUDE.md imports AGENTS.md');
  assert.deepEqual(ensureProjectPointers(tmp, [claudeCodeAdapter()]), [], 'pointer is idempotent');

  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true });

  console.log('Project context tests passed.');
}


// --- Vars / @var / generateEntrypoint tests ---
await import('./vars.test.mjs');

// --- Force level config (single source of truth) ---
await import('./forceLevelConfig.test.mjs');

// --- Enum primitives (CONTEXT and future KEYWORD <value> rewrites) ---
await import('./enumPrimitives.test.mjs');

// --- Force level alias desugaring ---
await import('./forceLevelDesugar.test.mjs');

// --- Force levels ---
await import('./forceLevel.test.mjs');

// --- Recursive body renderer (sequence grouping + leaf reuse) ---
await import('./renderTree.test.mjs');


// --- Ingest ---
await import('./ingest.test.mjs');

// --- AS shape resolution + force-level rendering ---
await import('./as.test.mjs');

// --- Library index generator ---
await import('./libraryIndex.test.mjs');




// --- Desugar: alias resolution pass ---
await import('./desugar.test.mjs');

// --- Lifecycle hooks: ON-* aliases desugar to canonical WHEN ---
await import('./lifecycles.test.mjs');

// --- ROLE / EXPERTISE / MANDATE agent-level identity primitives ---
await import('./identity.test.mjs');

// --- resolveImports: tools kind ---
{
  const { resolveImports } = await import('../dist/src/dispatch/imports.js');
  const { existsSync } = await import('fs');

  // Self-contained fixture: the legacy templates/library tools were removed, so
  // build a throwaway library on disk to exercise the tools-kind resolution.
  const tmp = '/tmp/agent-pack-resolve-tools-test';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'tools'), { recursive: true });
  writeFileSync(join(tmp, 'tools', 'board.ap'), '# board\nABOUT a board tool\n', 'utf-8');

  const libraries = { '@builtin': tmp };

  const raw = 'IMPORT board FROM @builtin.tools';
  const resolved = resolveImports(raw, [], libraries);

  assert.equal(resolved.length, 1, 'resolveImports resolves one tool entry');
  assert.equal(resolved[0].name, 'board', 'resolved name is board');
  assert.equal(resolved[0].kind, 'tools', 'resolved kind is tools');
  assert.ok(existsSync(resolved[0].absolutePath), 'resolved path exists on disk');
  assert.ok(resolved[0].absolutePath.endsWith('board.ap'), 'resolved path ends with board.ap');

  rmSync(tmp, { recursive: true, force: true });
  console.log('resolveImports tools kind test passed.');
}

// --- Metadata stripping: APPLIES/TAGS not leaked to rendered body ---
await import('./metadata-stripping.test.mjs');

// --- Integration: metadata keywords must not leak from imported modules ---
await import('./import-metadata-leak.test.mjs');

// --- Oracle: EXPORT-form bundle is byte-identical to legacy-form bundle ---
await import('./export-block-bundle-parity.test.mjs');

// --- Multiple EXPORT blocks per file: independent registration + composition ---
await import('./multiExport.test.mjs');

// --- FLOW primitive: parser, lint, bundle render ---
await import('./flow.test.mjs');


// --- Definition registry: defaults, strategyFor, allRunnables, resolveRunTarget ---
await import('./definition.test.mjs');

// --- Tag similarity helpers ---
await import('./tagSimilarity.test.mjs');

// --- Tag registry composable (useTagRegistry) ---
await import('./tagRegistry.test.mjs');

// --- Library index lint: untagged + similar-tag errors ---
await import('./libraryIndexLint.test.mjs');

// --- Tag hierarchy (FCA-derived) ---
await import('./tagHierarchy.test.mjs');

// --- Cross-references chapter rendering ---

// --- Nested breadcrumb rendering inside emitChapter ---
await import('./tagHierarchyChapter.test.mjs');

// --- parseBlocks: universal <KEY> <name>: <block> grammar ---
await import('./parseBlocks.test.mjs');

// --- roleIndex: role→agent binding, precedence, ambiguity ---
await import('./roleIndex.test.mjs');

// --- Template compiler: SLOTS/BODY/EXAMPLE contract ---
await import('./shapeCompiler.test.mjs');






// --- Unified IMPORT resolver: EXPORT-unit model + legacy-parity gate ---
await import('./unifiedResolver.test.mjs');

// --- Dynamic RUN: skeleton in the bundle, body fetched on demand ---

// --- Team-scoped shared block (team.ap): resolution, injection, scaffolding ---
await import('./teamShared.test.mjs');

// --- Per-member team-membership section (# Your team): resolution, injection ---
await import('./teamMembership.test.mjs');

// --- User-level config cascade (default → user → project), reserved @user alias ---
await import('./userConfigCascade.test.mjs');

// --- User-home (global) agents: name resolution + discovery walk, project shadows global ---
await import('./userHomeAgents.test.mjs');


await import('./claudeCodeApx.test.mjs');

// --- config names the built-in adapters instead of importing them ---
await import('./adapterNames.test.mjs');

// --- MEM: remember an event, force levels, shape, Claude Code memory ---
await import('./mem.test.mjs');

// --- DISTILL: the mark, its ids, the apx bridge, orphan scripts ---
await import('./distill.test.mjs');

// --- EXTENDS: parent rules first; a missing parent or a cycle fails ---
await import('./extends.test.mjs');

// --- a broken source never compiles quietly: names, words, levels, values, vars, store slots ---
await import('./compileErrors.test.mjs');

// --- apx engine: start/quiz, scope, ls, get, refs, find, md, errors, stores ---
await import('./apx.test.mjs');

// --- Inline blocks: ABOUT/TAGS lifted through the same seam as imported units ---
await import('./inlineBlocks.test.mjs');

// --- Slot-schema validator: TYPE grammar + record validation against a TEMPLATE ---
await import('./shapeSchema.test.mjs');

console.log('All tests passed.');
