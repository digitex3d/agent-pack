// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Characterisation of the kind dispatch of `lintFile` (src/lint.ts, lintByKind):
 * the kind-folder a file lives under picks its built-in linter; skill, tool and
 * generic files get no built-in kind linter; a plugin's kind falls back to the
 * single-block lint with the plugin's pluginBlockErrors check; a built-in
 * linter wins over a plugin of the same kind name.
 *
 * Every expected value below is what the intact code answered — recorded, not
 * derived. The plugins this file installs live in this process only, so the
 * file runs on its own: `node test/lintKindSwitch.test.mjs`.
 */
import { strict as assert } from 'node:assert';

const { lintFile } = await import('../dist/src/lint.js');
const { installPlugin } = await import('../dist/src/pluginLoader.js');
const { registerPlugin } = await import('../dist/src/plugins.js');

const lint = (file, body, options) => lintFile(file, body, options).map(e => [e.line, e.message, e.severity ?? null]);
const pin = (file, body, expected, options) =>
  assert.deepEqual(lint(file, body, options), expected, `${file} ${JSON.stringify(body)}`);

// --- each built-in kind-folder gets its own linter ---------------------------
const ABOUT_ONLY = 'ABOUT x\n';
const BUILT_IN = {
  policies:   'policy has no ALWAYS or NEVER assertion',
  procedures: 'procedure has no PROCEDURE header',
  roles:      'role has no rules (ALWAYS/NEVER/WHEN/DO)',
  templates:  'template has no TEMPLATE header',
  flows:      'flow has no FLOW block',
  stores:     'store has no STORE block',
  dimensions: 'dimension has no DIMENSION block',
  domains:    'domain has no DOMAIN block',
};
for (const [dir, message] of Object.entries(BUILT_IN)) pin(`/lib/${dir}/x.ap`, ABOUT_ONLY, [[1, message, null]]);

// A stray line: each linter's own wording for it, after the vocabulary's error.
const FOO = 'FOO bar\n';
const VOCAB_FOO = [1, 'unknown keyword `FOO` — did you mean `FOR`?', null];
pin('/lib/policies/x.ap', FOO, [VOCAB_FOO, [1, 'unexpected line in a policy (expected ALWAYS/NEVER or metadata): "FOO bar"', null], [1, 'policy has no ALWAYS or NEVER assertion', null], [1, 'missing ABOUT', null]]);
pin('/lib/procedures/x.ap', FOO, [VOCAB_FOO, [1, 'unexpected line in a procedure: "FOO bar"', null], [1, 'procedure has no PROCEDURE header', null], [1, 'missing ABOUT', null]]);
pin('/lib/roles/x.ap', FOO, [VOCAB_FOO, [1, 'unexpected line in a role (expected EXPERTISE/ALWAYS/NEVER/WHEN/DO, EXTENDS, or metadata): "FOO bar"', null], [1, 'role has no rules (ALWAYS/NEVER/WHEN/DO)', null], [1, 'missing ABOUT', null]]);
pin('/lib/templates/x.ap', FOO, [VOCAB_FOO, [1, 'unexpected top-level line in a template (expected TEMPLATE header or metadata): "FOO bar"', null], [1, 'template has no TEMPLATE header', null], [1, 'missing ABOUT', null]]);
pin('/lib/flows/x.ap', FOO, [VOCAB_FOO, [1, 'missing ABOUT', null], [1, 'flow has no FLOW block', null]]);
pin('/lib/stores/x.ap', FOO, [VOCAB_FOO, [1, 'store has no STORE block', null]]);
pin('/lib/dimensions/x.ap', FOO, [VOCAB_FOO, [1, 'dimension has no DIMENSION block', null]]);
pin('/lib/domains/x.ap', FOO, [VOCAB_FOO, [1, 'domain has no DOMAIN block', null]]);

// The options reach every built-in linter (maxLineLength).
const LONG = `ABOUT ${'word '.repeat(10)}\n`;
for (const [dir, message] of Object.entries(BUILT_IN)) {
  pin(`/lib/${dir}/x.ap`, LONG, [[1, 'line exceeds max length of 20 (56 chars)', null], [1, message, null]], { maxLineLength: 20 });
}

// Clean files lint clean.
pin('/lib/policies/x.ap', 'ABOUT x\nALWAYS do y\n', []);
pin('/lib/roles/x.ap', 'ABOUT x\nALWAYS do y\n', []);

// The folder decides, not the suffix: a non-.ap file in a kind-folder gets that kind's linter.
pin('/lib/policies/x.md', ABOUT_ONLY, [[1, 'policy has no ALWAYS or NEVER assertion', null]]);
pin('/lib/domains/x.txt', ABOUT_ONLY, [[1, 'domain has no DOMAIN block', null]]);
// The kind-folder closest to the file wins.
pin('/lib/policies/roles/x.ap', ABOUT_ONLY, [[1, 'role has no rules (ALWAYS/NEVER/WHEN/DO)', null]]);
pin('/lib/roles/policies/x.ap', ABOUT_ONLY, [[1, 'policy has no ALWAYS or NEVER assertion', null]]);

// --- skill, tool and generic files: no built-in kind linter -----------------
for (const dir of ['skills', 'tools', 'misc']) {
  pin(`/lib/${dir}/x.ap`, ABOUT_ONLY, []);
  pin(`/lib/${dir}/x.ap`, 'ABOUT x\nALWAYS do y\n', []);
  pin(`/lib/${dir}/x.ap`, 'MANDATE m\n', []);
  pin(`/lib/${dir}/x.ap`, LONG, [], { maxLineLength: 20 });
  pin(`/lib/${dir}/x.ap`, FOO, [VOCAB_FOO]);
  pin(`/lib/${dir}/x.ap`, 'AS\n', [[1, 'AS needs the template it names', null]]);
}
pin('/lib/misc/x.md', ABOUT_ONLY, []);
pin('/lib/misc/x.md', 'AS\n', [[1, 'AS needs the template it names', null]]);
pin('/lib/skills/x.md', 'AS\n', [[1, 'AS needs the template it names', null]]);

// --- a plugin's kind: the single-block lint, checked by pluginBlockErrors ---
installPlugin({
  name: 'gadget', about: 'g', key: 'GADGET', prefix: 'gad', folder: 'gadgets', block: 'gadget', operations: [],
  templates: { gadget: { slots: [{ name: 'part', optional: false, rawType: 'text' }] } }, service: '/nonexistent-gadget.mjs',
});
pin('/lib/gadgets/x.ap', ABOUT_ONLY, [[1, 'gadget has no GADGET block', null]]);
pin('/lib/gadgets/x.ap', 'GADGET x:\n    ABOUT a\n    PART p\n', []);
pin('/lib/gadgets/x.ap', 'GADGET x:\n    ABOUT a\n', [[1, 'GADGET block requires at least one PART', null]]);
pin('/lib/gadgets/x.ap', 'GADGET x:\n    PART p\n', [[1, 'GADGET block requires at least one ABOUT', null]]);
pin('/lib/gadgets/x.ap', 'GADGET x:\n    ABOUT a\n    PART p\n    PART q\n', [[1, 'GADGET block has 2 occurrences of PART (expected at most 1)', null]]);
pin('/lib/gadgets/y.ap', 'GADGET x:\n    ABOUT a\n    PART p\n', [[1, 'GADGET name "x" does not match filename slug "y"', 'warning']]);
// Two blocks: the count error, and only the first block is checked (z lacks PART, unreported).
pin('/lib/gadgets/x.ap', 'GADGET x:\n    ABOUT a\n    PART p\nGADGET z:\n    ABOUT a\n', [[1, 'gadget has 2 GADGET blocks (expected exactly 1)', null]]);
pin('/lib/gadgets/x.ap', LONG, [[1, 'line exceeds max length of 20 (56 chars)', null], [1, 'gadget has no GADGET block', null]], { maxLineLength: 20 });
// A plugin block outside its folder is no kind of its own there.
pin('/lib/misc/x.ap', 'GADGET x:\n    ABOUT a\n', []);
pin('/lib/policies/x.ap', 'GADGET x:\n    ABOUT a\n', [[1, 'unexpected line in a policy (expected ALWAYS/NEVER or metadata): "GADGET x:"', null], [1, 'policy has no ALWAYS or NEVER assertion', null]]);

// The record check of pluginBlockErrors: a slot's type, once the contract holds.
installPlugin({
  name: 'gizmo', about: 'g', key: 'GIZMO', prefix: 'giz', folder: 'gizmos', block: 'gizmo', operations: [],
  templates: { gizmo: { slots: [{ name: 'size', optional: false, rawType: 'number' }] } }, service: '/nonexistent-gizmo.mjs',
});
pin('/lib/gizmos/x.ap', 'GIZMO x:\n    ABOUT a\n    SIZE 3\n', []);
pin('/lib/gizmos/x.ap', 'GIZMO x:\n    ABOUT a\n    SIZE big\n', [[1, 'GIZMO x: SIZE: expected a number, got string "big"', null]]);

// --- a built-in linter before the plugin fallback ---------------------------
// A plugin registered under a built-in kind name does not replace its linter.
registerPlugin({
  name: 'policy', about: 'g', key: 'WIDGET', prefix: 'wid', folder: 'widgets', block: 'w', operations: [],
  templates: { w: { slots: [] } }, service: '/nonexistent-widget.mjs',
});
pin('/lib/policies/x.ap', ABOUT_ONLY, [[1, 'policy has no ALWAYS or NEVER assertion', null]]);
pin('/lib/policies/x.ap', 'ABOUT x\nALWAYS do y\n', []);
// A kind with no built-in linter (skill) does reach a plugin of its name.
registerPlugin({
  name: 'skill', about: 'g', key: 'WIDGET', prefix: 'wid', folder: 'widgets', block: 'w', operations: [],
  templates: { w: { slots: [] } }, service: '/nonexistent-widget.mjs',
});
pin('/lib/skills/x.ap', ABOUT_ONLY, [[1, 'widget has no WIDGET block', null]]);

console.log('lintKindSwitch: ok');
