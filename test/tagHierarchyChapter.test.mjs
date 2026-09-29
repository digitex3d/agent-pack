// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for tag-hierarchy chapter rendering inside emitChapter.
 *
 * Chapter grouping is centralized on the single FCA tag hierarchy
 * (`buildHierarchy`, src/services/tags.ts) — never duplicated here. Given the
 * chapter's own tagged entries, `emitChapter` asks `buildHierarchy` for the
 * tag forest and assigns each entry to the single deepest node it belongs to
 * (tie-broken like `pickPrimaryParent`: smallest member set, then alpha) so an
 * entry whose tags satisfy several sibling nodes still renders exactly once.
 * Untagged entries render flat, directly under the chapter H1.
 */
import { strict as assert } from 'assert';
import { emitChapter } from '../dist/src/bundlers/sections.js';

function makeCtx() {
  return {
    policies: [], roles: [], templates: [], procedures: [], flows: [],
    libraryRoots: ['/lib'],
  };
}

function makePolicy(name, tags = []) {
  return {
    kind: 'policy', name,
    about: `about ${name}`,
    body: `body of ${name}`,
    path: `/lib/${name}.policy.ap`,
    tags,
    breadcrumb: [],
    breadcrumbSegments: [],
  };
}

const renderEntry = e => ({ heading: `Policy "${e.name}"`, prelude: e.about, body: e.body });

// ---------------------------------------------------------------------------
// Case 1: branching hierarchy — #coding is a strict superset of both
// #architecture and #code-quality, which are not comparable to each other.
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const out = emitChapter(ctx, {
    title: 'Policies',
    intro: null,
    entries: [
      makePolicy('contracts', ['#coding', '#architecture']),
      makePolicy('dry-kiss',  ['#coding', '#code-quality']),
    ],
    renderEntry,
  });

  assert.ok(/^# Policies$/m.test(out), 'Policies H1 present');
  assert.ok(/^##\s+Coding$/m.test(out), 'Coding heading emitted once, no direct entries');
  assert.ok(/^###\s+Architecture$/m.test(out), 'architecture at depth 3');
  assert.ok(/^###\s+Code Quality$/m.test(out), 'code-quality at depth 3');
  assert.ok(/^####\s+Policy "contracts" — about contracts$/m.test(out), 'contracts entry under architecture, ABOUT folded into heading');
  assert.ok(/^####\s+Policy "dry-kiss" — about dry-kiss$/m.test(out), 'dry-kiss entry under code-quality, ABOUT folded into heading');

  console.log('case 1 (branching tag hierarchy) passed.');
}

// ---------------------------------------------------------------------------
// Case 2: entries WITHOUT tags → flat layout, no synthetic grouping.
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const out = emitChapter(ctx, {
    title: 'Policies',
    intro: null,
    entries: [
      makePolicy('flat-one', []),
      makePolicy('flat-two', []),
    ],
    renderEntry,
  });

  assert.ok(/^##\s+Policy "flat-one" — about flat-one$/m.test(out), 'flat-one at depth 2, ABOUT folded into heading');
  assert.ok(/^##\s+Policy "flat-two" — about flat-two$/m.test(out), 'flat-two at depth 2, ABOUT folded into heading');
  console.log('case 2 (flat layout without tags) passed.');
}

// ---------------------------------------------------------------------------
// Case 3: identical tag-sets merge into ONE node (canonical + alias); a
// member whose tags exactly match the node (no extra) gets no inline Tags
// line, and the alias tag is treated as heading-implied too.
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const out = emitChapter(ctx, {
    title: 'Policies',
    intro: null,
    entries: [
      // #coding and #code-quality cover the exact same two modules here, so
      // buildHierarchy merges them into one concept — canonical = shorter
      // name, '#coding'.
      makePolicy('dry-kiss', ['#coding', '#code-quality', '#design']),
      makePolicy('naming',   ['#coding', '#code-quality']),
    ],
    renderEntry,
  });

  assert.ok(/^##\s+Coding$/m.test(out), 'merged concept heads as canonical tag Coding');
  // naming's tags are fully covered by the merged heading (canonical + alias) → no Tags line.
  const namingIdx = out.indexOf('Policy "naming"');
  const designIdx = out.indexOf('Design');
  const namingBlock = out.slice(namingIdx, designIdx === -1 ? undefined : designIdx);
  assert.ok(!namingBlock.includes('Tags:'), 'naming has no Tags line (coding + code-quality alias both implied)');
  // design nests under the merged Coding heading as its own child (subset: only dry-kiss).
  // naming (a direct member of Coding) renders first, then the Design sub-group.
  assert.ok(/^###\s+Design$/m.test(out), 'design nests under Coding, after naming');
  const dryKissIdx = out.indexOf('Policy "dry-kiss"');
  const dryKissBlock = out.slice(dryKissIdx);
  assert.ok(!dryKissBlock.includes('Tags:'), 'dry-kiss has no Tags line either (all three tags on the heading path)');

  console.log('case 3 (identical tag-sets merge, alias tags excluded from inline Tags) passed.');
}

// ---------------------------------------------------------------------------
// Case 4: dedup — an entry whose tags satisfy two incomparable sibling nodes
// renders exactly once, at the tie-broken node (smallest member set, then
// alpha — '#forms' before '#stores' here since both have 2 members).
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  const out = emitChapter(ctx, {
    title: 'Policies',
    intro: null,
    entries: [
      makePolicy('e1',     ['#frontend']),
      makePolicy('e2',     ['#frontend']),
      makePolicy('f1',     ['#frontend', '#forms']),
      makePolicy('s1',     ['#frontend', '#stores']),
      makePolicy('shared', ['#frontend', '#forms', '#stores']),
    ],
    renderEntry,
  });

  const formsIdx = out.indexOf('Forms');
  const storesIdx = out.indexOf('Stores');
  assert.ok(formsIdx !== -1 && storesIdx !== -1, 'both Forms and Stores headings present');
  const formsBlock = out.slice(formsIdx, storesIdx > formsIdx ? storesIdx : undefined);
  const storesBlock = out.slice(storesIdx, storesIdx > formsIdx ? undefined : formsIdx);

  assert.ok(formsBlock.includes('Policy "shared"'), 'shared renders under Forms (tie-break winner)');
  assert.ok(!storesBlock.includes('Policy "shared"'), 'shared does NOT also render under Stores');
  assert.ok(formsBlock.includes('Policy "f1"'), 'f1 renders under Forms');
  assert.ok(storesBlock.includes('Policy "s1"'), 's1 renders under Stores');
  // e1/e2 belong to #frontend only — directly under the Frontend heading, not a child.
  assert.ok(/^##\s+Frontend$/m.test(out), 'Frontend is the root heading');
  assert.ok(/^###\s+Policy "e1" — about e1$/m.test(out), 'e1 rendered directly under Frontend, ABOUT folded into heading');

  console.log('case 4 (dedup to single deepest node, tie-break) passed.');
}

console.log('tagHierarchyChapter tests passed.');
