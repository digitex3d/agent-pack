// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { parseTemplate, renderTemplate, resolveShapeRefs } from '../dist/src/shapeCompiler.js';
import { markVerbatim, protectVerbatim } from '../dist/src/services/text.js';
import { lintFile } from '../dist/src/lint.js';

// ---------------------------------------------------------------------------
// Record template: SLOTS + BODY + EXAMPLE
// ---------------------------------------------------------------------------

const PROBLEM_LINE = [
  'TEMPLATE problem-line',
  '  SLOTS:',
  '    name:        TEXT MAX_WORDS 3    "short label for the problem"',
  '    description: TEXT MAX_WORDS 120  "what the problem is and where"',
  '    severity:    NUMBER 0..100       "severity score, higher = worse"',
  '  BODY:',
  '    {name} | {description} | {severity}',
  '  EXAMPLE:',
  '    missing meta description | la pagina prodotto non ha meta description | 70',
  '    slow LCP | Largest Contentful Paint 4.2s su mobile, oltre la soglia | 85',
].join('\n');

{
  const t = parseTemplate(PROBLEM_LINE);
  assert.ok(t, 'parses as a template');
  assert.equal(t.slots.length, 3, 'three slots');
  assert.equal(t.slots[0].name, 'name');
  assert.equal(t.bodyLayout, '{name} | {description} | {severity}', 'BODY layout captured');
  assert.ok(t.example.includes('missing meta description') && t.example.includes('slow LCP'), 'multi-line EXAMPLE captured');

  const out = renderTemplate(PROBLEM_LINE, 'problem-line');
  assert.ok(out.includes('Produce **problem-line** by filling this layout'), 'intro');
  assert.ok(out.includes('{name} | {description} | {severity}'), 'literal layout rendered verbatim (placeholders kept)');
  assert.ok(out.includes('- **name** — text (≤3 words) — short label for the problem'), 'field legend with text constraint');
  assert.ok(out.includes('- **severity** — number (0–100) — severity score, higher = worse'), 'number range');
  assert.ok(out.includes('<example>') && out.includes('</example>'), 'EXAMPLE wrapped in <example> tags');
  assert.ok(out.includes('slow LCP | Largest Contentful Paint 4.2s su mobile, oltre la soglia | 85'), 'multi-line example verbatim');
  assert.ok(!out.includes('SLOTS:') && !out.includes('EXAMPLE:'), 'raw region keywords not leaked');
}

console.log('shapeCompiler record-template render tests passed.');

// ---------------------------------------------------------------------------
// Default BODY (absent) = slots joined by ' | '
// ---------------------------------------------------------------------------

{
  const body = 'TEMPLATE pair\n  SLOTS:\n    a: TEXT "first"\n    b: TEXT "second"';
  const out = renderTemplate(body, 'pair');
  assert.ok(out.includes('{a} | {b}'), 'default layout synthesized from slot order');
}

// ---------------------------------------------------------------------------
// Slot referencing another template: <tpl> / LIST <tpl> → @shape → (id)
// ---------------------------------------------------------------------------

{
  const body = [
    'TEMPLATE finding',
    '  SLOTS:',
    '    title: TEXT MAX_WORDS 6 "title"',
    '    fix:   <fix>            "the single fix"',
    '    more:  LIST <fix> >=1   "extra fixes"',
  ].join('\n');
  const out = renderTemplate(body, 'finding');
  assert.ok(out.includes('- **fix** — @shape(fix)'), 'ref emits @shape marker');
  assert.ok(out.includes('- **more** — list of @shape(fix) (≥1)'), 'list ref with cardinality');

  const resolved = resolveShapeRefs(out, { templates: [{ name: 'fix', refId: 'tpl-1.2' }] });
  assert.ok(resolved.includes('- **fix** — **fix** (tpl-1.2)'), 'ref resolved to block id');
  assert.ok(resolved.includes('list of **fix** (tpl-1.2) (≥1)'), 'list ref resolved');
  assert.ok(!resolved.includes('@shape('), 'no @shape markers left');
}

console.log('shapeCompiler ref-resolution tests passed.');

// ---------------------------------------------------------------------------
// `{slug.EXAMPLE}` composes another template's EXAMPLE verbatim (single
// source of truth for lists-of-rows composing their row template's EXAMPLE).
// ---------------------------------------------------------------------------

{
  const row = [
    'TEMPLATE tech-entry',
    '  SLOTS:',
    '    name:    TEXT MAX_WORDS 4 "name"',
    '    version: TEXT MAX_WORDS 4 "version"',
    '  BODY:',
    '    {name} {version}',
    '  EXAMPLE:',
    '    TypeScript 5.6',
  ].join('\n');
  const list = [
    'TEMPLATE project-stack',
    '  SLOTS:',
    '    entries: LIST <tech-entry> >=1 "rows"',
    '  BODY:',
    '    stack:',
    '    {entries}',
    '  EXAMPLE:',
    '    stack:',
    '    {tech-entry.EXAMPLE}',
  ].join('\n');
  const templates = [{ name: 'tech-entry', body: row }, { name: 'project-stack', body: list }];

  const out = renderTemplate(list, 'project-stack', templates);
  assert.ok(out.includes('TypeScript 5.6'), 'composed EXAMPLE pulled from the referenced template');
  assert.ok(!out.includes('{tech-entry.EXAMPLE}'), 'marker fully resolved, none leaked');

  // no `templates` arg → marker left untouched (isolated render, e.g. a unit test)
  const bare = renderTemplate(list, 'project-stack');
  assert.ok(bare.includes('{tech-entry.EXAMPLE}'), 'without a templates list the marker is left as-is');

  // unknown slug throws
  const ghost = list.replaceAll('tech-entry', 'ghost-entry');
  assert.throws(() => renderTemplate(ghost, 'project-stack', templates), /unknown shape "ghost-entry"/, 'unresolvable ref throws');

  // self-reference is circular
  const selfRef = row.replace('TypeScript 5.6', '{tech-entry.EXAMPLE}');
  assert.throws(
    () => renderTemplate(selfRef, 'tech-entry', [{ name: 'tech-entry', body: selfRef }]),
    /circular/,
    'self-reference throws',
  );
}

console.log('shapeCompiler EXAMPLE-composition tests passed.');

// ---------------------------------------------------------------------------
// Per-slot rules (v3.1): force-level lines attach to the preceding slot
// ---------------------------------------------------------------------------

{
  const body = [
    'TEMPLATE problems-report',
    '  SLOTS:',
    '    problems: LIST <problem-line> >=1  "every SEO issue found"',
    '      MUST!  include every issue found in the changed files',
    '      SHOULD order by severity, highest first',
    '    done_when: checklist >=3 "acceptance criteria"',
    '      NEVER  make a check aspirational',
  ].join('\n');
  const t = parseTemplate(body);
  assert.equal(t.slots.length, 2, 'two slots');
  assert.equal(t.slots[0].rules.length, 2, 'two rules on first slot');
  assert.ok(t.slots[0].rules[0].includes('You must') && t.slots[0].rules[0].includes('include every issue'), 'MUST! calibrated intro');
  assert.ok(t.slots[0].rules[1].startsWith('You should order by severity'), 'SHOULD intro');
  assert.ok(t.slots[1].rules[0].startsWith('You must never make a check aspirational'), 'NEVER alias resolves');

  const out = renderTemplate(body, 'problems-report');
  assert.ok(/- \*\*problems\*\* — list of @shape\(problem-line\) \(≥1\) — every SEO issue found\n  - .*include every issue/.test(out), 'rules render as sub-bullets under the slot');
}

{
  // lexical attachment: indentation is style — a rule at the SAME indent as
  // the slot lines still attaches to the preceding slot
  const body = 'TEMPLATE x\n  SLOTS:\n    a: TEXT "v"\n    MUST stay terse';
  const t = parseTemplate(body);
  assert.equal(t.slots[0].rules.length, 1, 'same-indent rule attaches by order');
}

{
  // dangling rule (no slot above) → loud error
  const body = 'TEMPLATE x\n  SLOTS:\n    MUST do something\n    a: TEXT "v"';
  assert.throws(() => parseTemplate(body), /has no slot above it/, 'orphan rule throws');
}

console.log('shapeCompiler per-slot rules tests passed.');

// ---------------------------------------------------------------------------
// Scalar shorthand
// ---------------------------------------------------------------------------

{
  const body = 'TEMPLATE role-name: TEXT REGEX /^[a-z][a-z0-9-]*$/ "kebab-case identifier"';
  const t = parseTemplate(body);
  assert.ok(t && t.scalar, 'scalar parsed');
  const out = renderTemplate(body, 'role-name');
  assert.equal(out, '**role-name** — text (matching /^[a-z][a-z0-9-]*$/) — kebab-case identifier');
}

{
  const body = 'TEMPLATE severity: NUMBER 0..100 "0 best, 100 worst"';
  assert.equal(renderTemplate(body, 'severity'), '**severity** — number (0–100) — 0 best, 100 worst');
}

{
  // block-form scalar: TYPE on the line under `TEMPLATE name:`, plus EXAMPLE
  const body = [
    'TEMPLATE role-name:',
    '    TEXT REGEX /^[a-z-]+$/ "kebab id"',
    '    EXAMPLE:',
    '        security-auditor',
  ].join('\n');
  const t = parseTemplate(body);
  assert.ok(t && t.scalar, 'block-form scalar parsed');
  const out = renderTemplate(body, 'role-name');
  assert.ok(out.startsWith('**role-name** — text (matching /^[a-z-]+$/) — kebab id'), 'block scalar render');
  assert.ok(out.includes('<example>') && out.includes('security-auditor'), 'scalar EXAMPLE rendered');
}

// ---------------------------------------------------------------------------
// Central verbatim protection: BODY/EXAMPLE content is never compiled
// ---------------------------------------------------------------------------

{
  // markVerbatim regions survive the transform untouched; markers never leak.
  const masked = 'before ' + markVerbatim('MUST stay verbatim\n$term @shape(x) {{var}}') + ' after';
  const out = protectVerbatim(masked, t => t.toUpperCase());
  assert.ok(out.includes('MUST stay verbatim'), 'verbatim content untouched by transform');
  assert.ok(out.includes('$term @shape(x) {{var}}'), 'verbatim tokens untouched');
  assert.ok(out.includes('BEFORE') && out.includes('AFTER'), 'surrounding text transformed');
  assert.ok(!out.includes('<<<VERBATIM>>>') && !out.includes('<<<VB'), 'no markers leak');

  // renderTemplate wraps BODY + EXAMPLE in verbatim markers (resolved later).
  const tpl = 'TEMPLATE r\n  SLOTS:\n    a: TEXT "x"\n  BODY:\n    MUST {a}\n  EXAMPLE:\n    ALWAYS verbatim';
  const r = renderTemplate(tpl, 'r');
  assert.ok(r.includes('<<<VERBATIM>>>MUST {a}<<</VERBATIM>>>'), 'BODY wrapped verbatim');
  // a full post-process strips markers and shields the content
  const final = protectVerbatim(r, t => t.replace(/MUST/g, 'XXX').replace(/ALWAYS/g, 'YYY'));
  assert.ok(final.includes('MUST {a}') && final.includes('ALWAYS verbatim'), 'BODY/EXAMPLE shielded from passes');
  assert.ok(!final.includes('<<<VERBATIM>>>'), 'markers stripped from final output');
}

console.log('shapeCompiler verbatim-protection tests passed.');

console.log('shapeCompiler scalar tests passed.');

// ---------------------------------------------------------------------------
// Back-compat: prose templates fall back (renderTemplate → null), and the
// resolver never touches prose angle-bracket placeholders.
// ---------------------------------------------------------------------------

{
  const prose = 'TEMPLATE rule-classification\n  kind: POLICY | PLAYBOOK\n  rationale: <short reason>';
  assert.equal(renderTemplate(prose, 'rule-classification'), null, 'prose template → verbatim fallback');

  // prose templates use <task-id>/<slug> as placeholders — resolveShapeRefs must NOT touch them
  const ctx = { templates: [{ name: 'x', refId: 'tpl-1.1' }] };
  assert.equal(resolveShapeRefs('depends: <task-id> and <agent-or-team>', ctx), 'depends: <task-id> and <agent-or-team>', 'prose <...> untouched');
  assert.throws(() => resolveShapeRefs('@shape(ghost)', ctx), /unknown shape "ghost"/, 'unknown @shape throws');
}

console.log('shapeCompiler back-compat tests passed.');

// ---------------------------------------------------------------------------
// Lint: a v3 template file (SLOTS/BODY/EXAMPLE indented) produces no errors
// ---------------------------------------------------------------------------

{
  const file = '# problem-line\n\nABOUT   one SEO problem\nTAGS    #seo\n\n' + PROBLEM_LINE;
  const errors = lintFile('problem-line.template.ap', file).filter(e => e.severity !== 'warning');
  assert.deepEqual(errors, [], 'v3 template lints clean (regions are indented, skipped by topLevelOnly)');
}

console.log('shapeCompiler lint tests passed.');
console.log('All shapeCompiler tests passed.');
