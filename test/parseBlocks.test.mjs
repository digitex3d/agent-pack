// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { parseBlocks } from '../dist/src/parseBlocks.js';

// --- 1. Single PROCEDURE block ---
{
  const src = `PROCEDURE foo:
  DO  something
  RUN other
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '1: no errors');
  assert.equal(r.blocks.length, 1, '1: one block');
  assert.equal(r.blocks[0].key, 'PROCEDURE');
  assert.equal(r.blocks[0].name, 'foo');
  assert.equal(r.blocks[0].rest, '');
  assert.equal(r.blocks[0].children.length, 2, '1: two child lines');
  assert.equal(r.blocks[0].children[0].type, 'line');
  assert.equal(r.blocks[0].children[0].keyword, 'DO');
  assert.equal(r.blocks[0].children[0].rest, 'something');
  assert.equal(r.blocks[0].children[1].keyword, 'RUN');
  console.log('1. single PROCEDURE ok');
}

// --- 2. Single TEMPLATE block ---
{
  const src = `TEMPLATE bar:
  field-a: value-a
  field-b: value-b
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '2: no errors');
  assert.equal(r.blocks[0].key, 'TEMPLATE');
  assert.equal(r.blocks[0].name, 'bar');
  console.log('2. single TEMPLATE ok');
}

// --- 3. POLICY block ---
{
  const src = `POLICY security:
  ALWAYS validate every input
  NEVER  commit credentials
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '3: no errors');
  assert.equal(r.blocks[0].key, 'POLICY');
  assert.equal(r.blocks[0].name, 'security');
  assert.equal(r.blocks[0].children.length, 2);
  assert.equal(r.blocks[0].children[0].keyword, 'ALWAYS');
  // `NEVER` is desugared to `!ALWAYS` (force-level negation prefix form).
  assert.equal(r.blocks[0].children[1].keyword, '!ALWAYS');
  console.log('3. POLICY ok');
}

// --- 4. PLAYBOOK block ---
{
  const src = `PLAYBOOK draw-architecture:
  WHEN asked to design the architecture
  DO   confirm the scope
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '4: no errors');
  assert.equal(r.blocks[0].key, 'PLAYBOOK');
  assert.equal(r.blocks[0].name, 'draw-architecture');
  console.log('4. PLAYBOOK ok');
}

// --- 5. ROLE block ---
{
  const src = `ROLE architect:
  EXPERTISE plantuml system-design
  ALWAYS    model the system as nodes and labelled edges
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '5: no errors');
  assert.equal(r.blocks[0].key, 'ROLE');
  assert.equal(r.blocks[0].name, 'architect');
  console.log('5. ROLE ok');
}

// --- 6. VOCABULARY block (now named, uniform with other primitives) ---
{
  const src = `VOCABULARY orchestration:
  TERM team := a named group of agents
  TERM purpose := what an agent is for
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '6: no errors');
  assert.equal(r.blocks[0].key, 'VOCABULARY');
  assert.equal(r.blocks[0].name, 'orchestration', '6: VOCABULARY is named');
  assert.equal(r.blocks[0].children.length, 2);
  console.log('6. VOCABULARY ok');
}

// --- 7. AGENT with nested WHEN/IF ---
{
  const src = `AGENT architect:
  ABOUT      Maintains diagrams
  ROLE       software architect

  WHEN asked to design the architecture:
    IF the feature has already been developed:
      DO update existing diagrams
    RUN draw-component-diagram
    RUN draw-sequence-diagram

PROCEDURE draw-component-diagram:
  DO list runtime pieces
  DO label every edge
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '7: no errors, got: ' + JSON.stringify(r.errors));
  assert.equal(r.blocks.length, 2, '7: two top-level blocks');

  const agent = r.blocks[0];
  assert.equal(agent.key, 'AGENT');
  assert.equal(agent.name, 'architect');

  // Find the WHEN inside AGENT. WHEN is now treated as a control-flow block:
  // not in BLOCK_TYPES → no "requires a name" check, but the universal name
  // split still runs and captures the first word of the trigger phrase.
  const whenBlock = agent.children.find(c => c.type === 'block' && c.key === 'WHEN');
  assert.ok(whenBlock, '7: nested WHEN found');
  assert.equal(whenBlock.name, 'asked', '7: WHEN "name" is the first word of the trigger');
  assert.equal(whenBlock.rest, 'to design the architecture');

  // IF nested inside WHEN
  const ifBlock = whenBlock.children.find(c => c.type === 'block' && c.key === 'IF');
  assert.ok(ifBlock, '7: nested IF found inside WHEN');
  assert.equal(ifBlock.name, 'the');
  assert.equal(ifBlock.rest, 'feature has already been developed');
  assert.equal(ifBlock.children.length, 1, '7: IF has one DO child');
  assert.equal(ifBlock.children[0].keyword, 'DO');

  // Two sibling RUN lines under WHEN (after IF)
  const runLines = whenBlock.children.filter(c => c.type === 'line' && c.keyword === 'RUN');
  assert.equal(runLines.length, 2, '7: two RUN lines under WHEN');

  // Second top-level: PROCEDURE
  const proc = r.blocks[1];
  assert.equal(proc.key, 'PROCEDURE');
  assert.equal(proc.name, 'draw-component-diagram');
  assert.equal(proc.children.length, 2);
  console.log('7. AGENT with nested WHEN/IF + sibling PROCEDURE ok');
}

// --- 8. IMPORT prologue + single block ---
{
  const src = `IMPORT foo, bar FROM @main.procedures.architecture
IMPORT baz FROM @main.templates.diagrams

PROCEDURE main-flow:
  RUN foo
  RUN bar
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '8: no errors');
  // Prologue contains the two IMPORT keyword tokens + blank line
  const importTokens = r.prologue.filter(t => t.kind === 'keyword' && t.keyword === 'IMPORT');
  assert.equal(importTokens.length, 2, '8: two IMPORT lines in prologue');
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].name, 'main-flow');
  console.log('8. IMPORT prologue ok');
}

// --- 9. ERROR: content before first header ---
{
  const src = `ALWAYS this is illegal at top level

PROCEDURE foo:
  DO ok
`;
  const r = parseBlocks(src);
  assert.ok(r.errors.length >= 1, '9: at least one error');
  assert.ok(
    r.errors.some(e => /content before first primitive header/.test(e.message)),
    '9: error mentions content-before-header',
  );
  // The PROCEDURE still parses
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].name, 'foo');
  console.log('9. error on content before header ok');
}

// --- 10. ERROR: no blocks at all ---
{
  const src = `# just a comment
# and another

`;
  const r = parseBlocks(src);
  assert.equal(r.blocks.length, 0);
  assert.ok(r.errors.some(e => /no primitive blocks/.test(e.message)), '10: error on empty file');
  console.log('10. error on no blocks ok');
}

// --- 11. ERROR: duplicate (key, name) within the same file ---
{
  const src = `PROCEDURE foo:
  DO first

PROCEDURE foo:
  DO second
`;
  const r = parseBlocks(src);
  assert.equal(r.blocks.length, 2, '11: both blocks still parsed');
  assert.ok(
    r.errors.some(e => /duplicate primitive procedure foo/.test(e.message)),
    '11: duplicate error raised',
  );
  console.log('11. duplicate detection ok');
}

// --- 12. Legacy form without `:` flagged as content-before-header ---
{
  // The lexer emits 'keyword' (not 'blockOpener') for `PROCEDURE foo` without
  // colon, and asBlockOpener rejects keyword tokens whose rest doesn't end
  // with `:`. Phase 1 of parseBlocks therefore consumes the line as
  // "content before first primitive header". PR2's migration adds the `:`
  // to every legacy primitive declaration.
  const src = `PROCEDURE legacy
  DO body
`;
  const r = parseBlocks(src);
  assert.ok(
    r.errors.some(e => /content before first primitive header/.test(e.message)),
    '12: legacy no-colon form flagged for migration',
  );
  console.log('12. legacy no-colon form flagged ok');
}

// --- 13. Trailing `:` tolerance on name (defensive) ---
{
  // Already-stripped by BLOCK_OPENER_RE, but a user who writes `PROCEDURE foo : ` (space + colon)
  // would have the space-colon stripped by the regex. Verify name is clean.
  const src = `PROCEDURE foo:
  DO body
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0);
  assert.equal(r.blocks[0].name, 'foo', 'name has no trailing colon');
  console.log('13. name cleanliness ok');
}

// --- 14. Unknown KEY → no error, generic block AST (control-flow friendly) ---
{
  // Unknown keys are accepted silently: parseBlocks produces a permissive AST
  // and lets consumers (extractInlineDefinitions, lint passes) classify keys.
  // This is what makes WHEN/IF/ELSE/STEP work without special-casing.
  const src = `WIDGET frobnicator:
  DO weird thing
`;
  const r = parseBlocks(src);
  assert.equal(r.blocks.length, 1, '14: unknown-key block still parses');
  assert.equal(r.blocks[0].key, 'WIDGET');
  assert.equal(r.blocks[0].name, 'frobnicator');
  assert.equal(r.errors.length, 0, '14: no diagnostic for unknown key');
  console.log('14. unknown KEY accepted ok');
}

// --- 15. EXPORT modifier: unwraps to inner KIND + name, flags exported ---
{
  const src = `EXPORT POLICY ctx-eng:
  ABOUT context-engineering rules for multi-agent work
  TAGS  #multi-agent #orchestration
  APPLIES universal
  ALWAYS engineer the informational environment
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '15: no errors, got: ' + JSON.stringify(r.errors));
  assert.equal(r.blocks.length, 1, '15: one top-level block');
  const b = r.blocks[0];
  assert.equal(b.key, 'POLICY', '15: modifier unwrapped to inner KIND');
  assert.equal(b.name, 'ctx-eng', '15: inner name extracted');
  assert.equal(b.exported, true, '15: block flagged exported');
  // ABOUT/TAGS/APPLIES accepted as children with no error (metadata is out of
  // scope for parsing — they must simply nest cleanly).
  const aboutChild = b.children.find(c => c.type === 'line' && c.keyword === 'ABOUT');
  assert.ok(aboutChild, '15: ABOUT accepted as a child line');
  assert.equal(b.children.length, 4, '15: all four child lines nested');
  console.log('15. EXPORT modifier unwraps + flags exported ok');
}

// --- 16. Unmarked top-level block → exported false ---
{
  const src = `POLICY x:
  ALWAYS do the thing
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '16: no errors');
  assert.equal(r.blocks[0].key, 'POLICY');
  assert.equal(r.blocks[0].name, 'x');
  assert.equal(r.blocks[0].exported, false, '16: unmarked block is private (exported false)');
  console.log('16. unmarked block exported false ok');
}

// --- 17. ERROR: EXPORT with an unknown inner KIND ---
{
  const src = `EXPORT WIDGET frobnicator:
  DO weird thing
`;
  const r = parseBlocks(src);
  assert.ok(
    r.errors.some(e => /EXPORT names an unknown block KIND "WIDGET"/.test(e.message)),
    '17: unknown inner KIND reported, got: ' + JSON.stringify(r.errors),
  );
  console.log('17. EXPORT unknown KIND error ok');
}

// --- 18. ERROR: EXPORT with no KIND (single token = the name) ---
{
  const src = `EXPORT ctx-eng:
  ABOUT something
`;
  const r = parseBlocks(src);
  assert.ok(
    r.errors.some(e => /EXPORT requires a block KIND before the name/.test(e.message)),
    '18: missing KIND reported, got: ' + JSON.stringify(r.errors),
  );
  console.log('18. EXPORT missing KIND error ok');
}

// --- 19. ERROR: EXPORT with a KIND but no name ---
{
  const src = `EXPORT POLICY:
  ABOUT something
`;
  const r = parseBlocks(src);
  assert.ok(
    r.errors.some(e => /EXPORT POLICY requires a name/.test(e.message)),
    '19: missing name reported, got: ' + JSON.stringify(r.errors),
  );
  // Exactly one diagnostic — the generic "requires a name" check must not pile on.
  assert.equal(r.errors.length, 1, '19: single diagnostic, got: ' + JSON.stringify(r.errors));
  console.log('19. EXPORT missing name error ok');
}

// --- 20. ERROR: EXPORT not at top level (indented) ---
{
  const src = `AGENT host:
  EXPORT POLICY nested:
    ABOUT illegal here
`;
  const r = parseBlocks(src);
  assert.ok(
    r.errors.some(e => /EXPORT is only allowed on a top-level block/.test(e.message)),
    '20: non-top-level EXPORT reported, got: ' + JSON.stringify(r.errors),
  );
  // Recovery: the inner block still parses (as a private nested POLICY).
  const agent = r.blocks[0];
  const nested = agent.children.find(c => c.type === 'block' && c.key === 'POLICY');
  assert.ok(nested, '20: inner block still parsed for recovery');
  assert.equal(nested.exported, false, '20: rejected EXPORT leaves block private');
  console.log('20. EXPORT non-top-level error ok');
}

// --- 21. AGENT block: name + `AS <role>` header signature ---
{
  const src = `AGENT simplifier-impl AS simplifier:
  MANDATE keep it lean
  ABOUT the lean implementer
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '21: no errors');
  assert.equal(r.blocks.length, 1, '21: one block');
  assert.equal(r.blocks[0].key, 'AGENT');
  assert.equal(r.blocks[0].name, 'simplifier-impl', '21: name is the first token, not the AS clause');
  assert.equal(r.blocks[0].rest, 'AS simplifier', '21: AS clause survives in rest as the signature source');
  assert.equal(r.blocks[0].children.length, 2, '21: two children');
  console.log('21. AGENT block with AS header ok');
}

// --- 22. EXPORT AGENT block: exported flag + AS signature ---
{
  const src = `EXPORT AGENT lib-impl AS architect:
  MANDATE design the system
`;
  const r = parseBlocks(src);
  assert.equal(r.errors.length, 0, '22: no errors');
  assert.equal(r.blocks[0].key, 'AGENT', '22: EXPORT unwraps to AGENT');
  assert.equal(r.blocks[0].name, 'lib-impl');
  assert.equal(r.blocks[0].rest, 'AS architect');
  assert.equal(r.blocks[0].exported, true, '22: EXPORT AGENT is exported');
  console.log('22. EXPORT AGENT block ok');
}

console.log('parseBlocks tests passed.');
