// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const COMMON_LIB = resolve(PROJECT_ROOT, '../common');

// --- Lint tests (rule grammar) ---

const { lintPolicy, lintRole, lintProcedure, lintTemplate } = await import('../dist/src/lint.js');

{
  const ok = lintPolicy('english.policy.ap', `# english\nABOUT english only\nALWAYS write in English\nNEVER mix languages\n`);
  assert.equal(ok.length, 0, 'valid policy should have no errors');

  const bad = lintPolicy('bad.policy.ap', `# bad\nSHOULD do something\n`);
  assert.ok(bad.length > 0, 'SHOULD keyword should be rejected');
}

{
  const ok = lintRole('ok.role.ap', `# ok\nABOUT ok\nWHEN a AND b\nDO something\n`);
  assert.equal(ok.length, 0, 'AND-joined trigger should be accepted');

  const orErr = lintRole('or.role.ap', `# or\nABOUT or\nWHEN a OR b\nDO something\n`);
  assert.ok(orErr.some(e => /OR not supported/.test(e.message)), 'OR should be rejected');

  const trailing = lintRole('tr.role.ap', `# tr\nABOUT tr\nWHEN a AND \nDO something\n`);
  assert.ok(trailing.some(e => /AND must join non-empty/.test(e.message)), 'trailing AND should be rejected');
}

{
  const ifOr = lintRole('iff.role.ap', `# iff\nABOUT iff\nWHEN x\nIF a OR b\n  THEN DO y\n`);
  assert.ok(ifOr.some(e => /IF trigger.*OR not supported/.test(e.message)), 'IF with OR should be rejected');
}

{
  // APPLIES validation: valid payload passes, invalid forms produce lint errors
  const validTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nAPPLIES #typescript, #code-review, #bash\nALWAYS do something\n`);
  assert.equal(validTags.length, 0, 'valid APPLIES payload should produce no errors');

  // Bare APPLIES (no payload) is lexed as unknown → rejected as unexpected line
  const emptyTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nAPPLIES\nALWAYS do something\n`);
  assert.ok(emptyTags.length > 0, 'empty APPLIES should be rejected');

  const spacedTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nAPPLIES #a #b\nALWAYS do something\n`);
  assert.deepEqual(spacedTags.map(e => e.message).filter(m => /APPLIES/.test(m)), ['`APPLIES #a #b`: separate the items with commas — `APPLIES #a, #b`'], 'space-separated APPLIES is refused once, with the line to write');

  const slashTags = lintPolicy('t.policy.ap', `# t\nABOUT t\nAPPLIES #coding/scripting\nALWAYS do something\n`);
  assert.ok(slashTags.some(e => /APPLIES token/.test(e.message)), 'hierarchical slash APPLIES should be rejected');

  const noHash = lintPolicy('t.policy.ap', `# t\nABOUT t\nAPPLIES typescript\nALWAYS do something\n`);
  assert.ok(noHash.some(e => /APPLIES token/.test(e.message)), 'APPLIES token without # should be rejected');
}

console.log('Lint tests passed.');

// --- Block-scoped lint (EXPORT) ---
{
  // EXPORT block missing ABOUT → error
  const noAbout = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY needs-about:\n    APPLIES #x\n    ALWAYS do something\n`);
  assert.ok(noAbout.some(e => /exported block requires ABOUT/.test(e.message)),
    'EXPORT block without ABOUT should error');

  // EXPORT block with ABOUT + APPLIES → clean
  const full = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY ctx:\n    ABOUT context rules\n    APPLIES #multi-agent, universal\n    ALWAYS engineer the environment\n    NEVER rely on one prompt\n`);
  assert.equal(full.length, 0, 'EXPORT block with ABOUT+APPLIES should be clean');

  // EXPORT block without APPLIES → clean (APPLIES optional)
  const noTags = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY ctx:\n    ABOUT context rules\n    ALWAYS engineer the environment\n`);
  assert.equal(noTags.length, 0, 'EXPORT block without APPLIES should be clean (optional)');

  // EXPORT TEMPLATE with nested SLOTS body → clean (nested lines not flagged)
  const tpl = lintTemplate('handoff-digest.template.ap',
    `# t\nEXPORT TEMPLATE handoff-digest:\n    ABOUT digest shape for inter-agent handoff\n    SLOTS:\n        summary: TEXT MAX_WORDS 40 "..."\n`);
  assert.equal(tpl.length, 0, 'EXPORT TEMPLATE with nested SLOTS should be clean');

  // Mixed file: EXPORT block + file-top metadata → error on the file-top metadata
  const mixed = lintPolicy('ctx.policy.ap',
    `# p\nABOUT file-top about\nAPPLIES #stray\nEXPORT POLICY ctx:\n    ABOUT block about\n    ALWAYS do something\n`);
  assert.ok(mixed.some(e => /file-top is not allowed/.test(e.message) && e.line === 2),
    'file-top ABOUT in an EXPORT file should error');
  assert.ok(mixed.some(e => /file-top is not allowed/.test(e.message) && e.line === 3),
    'file-top APPLIES in an EXPORT file should error');

  // Private (non-export) block carrying metadata alongside an EXPORT block → inert
  const privateBlock = lintPolicy('ctx.policy.ap',
    `# p\nEXPORT POLICY pub:\n    ABOUT public about\n    ALWAYS do public\n\nPOLICY helper:\n    ABOUT inert about\n    APPLIES universal\n    ALWAYS do helper\n`);
  assert.equal(privateBlock.length, 0,
    'metadata inside a private block should be inert (no error)');

  // Legacy file (no EXPORT block) → unchanged, clean
  const legacy = lintPolicy('ctx.policy.ap',
    `# p\nABOUT context rules\nAPPLIES #multi-agent\nALWAYS engineer the environment\nNEVER rely on one prompt\n`);
  assert.equal(legacy.length, 0, 'legacy file-top policy should be unchanged (clean)');

  // Legacy file still requires ABOUT (file-top rule not retired)
  const legacyNoAbout = lintPolicy('ctx.policy.ap', `# p\nALWAYS do something\n`);
  assert.ok(legacyNoAbout.some(e => /missing ABOUT/.test(e.message)),
    'legacy file without ABOUT still errors (file-top rule intact)');
}

console.log('Block-scoped lint (EXPORT) tests passed.');

// --- The main: the project's root .ap file → AGENTS.md block, the orchestration it lists, harness pointers ---
await import('./main.test.mjs');


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
  const { existsSync } = await import('node:fs');

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

// --- Metadata stripping: APPLIES not leaked to rendered body ---
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

// --- lint of ROLE and PROCEDURE: characterisation of the lines each accepts or rejects, and the errors ---
await import('./lint-role-procedure-specs.test.mjs');

// --- Tag hierarchy (FCA-derived) ---
await import('./tagHierarchy.test.mjs');

// --- Cross-references chapter rendering ---

// --- Nested tag rendering inside emitChapter ---
await import('./tagHierarchyChapter.test.mjs');

// --- parseBlocks: universal <KEY> <name>: <block> grammar ---
await import('./parseBlocks.test.mjs');

// --- roleIndex: role→agent binding, precedence, ambiguity ---
await import('./roleIndex.test.mjs');
// --- several roles on one agent, BY <role> with a shared role ---
await import('./roles.test.mjs');

// --- Template compiler: SLOTS/BODY/EXAMPLE contract ---
await import('./shapeCompiler.test.mjs');






// --- Unified IMPORT resolver: EXPORT-unit model + legacy-parity gate ---
await import('./unifiedResolver.test.mjs');

// --- Dynamic RUN: skeleton in the bundle, body fetched on demand ---

// --- Team-scoped shared block (team.ap): resolution, injection, scaffolding ---
await import('./teamShared.test.mjs');

// --- Per-member team-membership section (# Your team): resolution, injection ---
await import('./teamMembership.test.mjs');

// --- The team block: EXPORT TEAM <name> in <team>.ap — roster, routing, flows ---
await import('./team.test.mjs');

// --- Background work and contracts: DELEGATE~ / WAIT on the registry; MARK, a DELEGATE of a list, copies, merge and land ---
await import('./delegations.test.mjs');
await import('./marks.test.mjs');
await import('./guard.test.mjs');
await import('./harness.test.mjs');
await import('./harnessContracts.test.mjs');
await import('./acp.test.mjs');
await import('./chat.test.mjs');
await import('./ask.test.mjs');
await import('./tui.test.mjs');

// --- User-level config cascade (default → user → project), reserved @user alias ---
await import('./userConfigCascade.test.mjs');

// --- User-home (global) agents: name resolution + discovery walk, project shadows global ---
await import('./userHomeAgents.test.mjs');


await import('./claudeCodeApx.test.mjs');

// --- config names the built-in adapters instead of importing them ---
await import('./adapterNames.test.mjs');

// --- MEM: remember an event, force levels, shape, Claude Code memory ---
await import('./mem.test.mjs');
await import('./whenShape.test.mjs');
await import('./exampleCompose.test.mjs');
await import('./reporter.test.mjs');
await import('./version.test.mjs');
await import('./keywordCatalog.test.mjs');
await import('./workspace.test.mjs');
await import('./lists.test.mjs');
await import('./perimeter.test.mjs');

// --- programs: a COMPUTE / PROCEDURE** / IF** carried out by its program — apx run, tests, refusal, timeout, orphans ---
await import('./programs.test.mjs');

// --- EXTENDS: parent rules first; a missing parent or a cycle fails ---
await import('./extends.test.mjs');

// --- a broken source never compiles quietly: names, words, levels, values, vars, store slots ---
await import('./compileErrors.test.mjs');

// --- apx engine: start/quiz, scope, ls, get, refs, find, md, errors, stores ---
await import('./apx.test.mjs');

// --- Inline blocks: ABOUT/APPLIES lifted through the same seam as imported units ---
await import('./inlineBlocks.test.mjs');

// --- Slot-schema validator: TYPE grammar + record validation against a TEMPLATE ---
await import('./shapeSchema.test.mjs');
await import('./apdocLines.test.mjs');
await import('./judge.test.mjs');

// --- IF/ELSE inside a flow STEP: lint, document lines, md, apx flow, Workflow script ---
await import('./stepIf.test.mjs');

// --- PARALLEL EACH: the head, its lint, the list's type, md, apx, Workflow script ---
await import('./each.test.mjs');

// --- force-level lines in PROCEDURE, STEP and STEP IF/ELSE bodies: lint, document, md, apx, Workflow script ---
await import('./forceInBodies.test.mjs');

// --- force-level lines at an AGENT's top level: every family — lint, document, md, apx ---
await import('./forceInAgent.test.mjs');

// --- executors (I2): DO / ASK / COMPUTE lines, IF* / IF** / UNTIL* / UNTIL** heads, ASK … BY ---
await import('./executors.test.mjs');

// --- variables: constants, session variables (VAR x:, DO … INTO x, {{x}}), their types, the apx get/set ---
await import('./variables.test.mjs');

// --- IF!/IF!!/UNTIL!!: checked conditions, the question, the apx asking a (fake) judge ---
await import('./check.test.mjs');

// --- library files compile like inline blocks: procedure LENS-IN, role ELSE and IMPORTs; team flows render the reads of their imports ---
await import('./libraryUnits.test.mjs');

// --- skills: agents the adapter writes as skills ---
await import('./skills.test.mjs');
await import('./opencode.test.mjs');

// --- block decorators: one structure for every decorator — lexer, parser, lint, resolution, scope, rendering ---
await import('./decorators.test.mjs');

// --- dimensions (D43): answers about the code, kept by the apx — the block, its catalog, the cache and its verbs ---
await import('./dimensions.test.mjs');

// --- plugins: a block and the apx commands that serve it, from a plugin folder in the config ---
await import('./plugins.test.mjs');

// --- lint: one switch over the block kinds ---
await import('./lintKindSwitch.test.mjs');

// --- store drivers: the contract, shipped drivers and a module's ---
await import('./storeDrivers.test.mjs');

// the pack: the container of every apx — sections, offsets, seal
await import('./pack.test.mjs');

// agent-pack pack: an apx compiled by Bun into one binary — split, embedded data, the command
await import('./executable.test.mjs');

// the engine's own tables as stores, through the one store API
await import('./engineStores.test.mjs');

// the affinity engine: free text matched against keys through a prebuilt word table
await import('./affinity.test.mjs');

// the call envelope: the call template as the introduction to calling an apx, asked in the quiz; every call logged, its verb alone
await import('./callEnvelope.test.mjs');

console.log('All tests passed.');
