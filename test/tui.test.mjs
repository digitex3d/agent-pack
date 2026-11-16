// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The chat's full screen — its pure layers driven directly (width, input
 * keys, conversation, frame), and the screen itself through a pseudo-terminal
 * (`script`, util-linux) with a fake ACP boss:
 *
 *   - header, conversation, input box, status line; the terminal restored on quit, Ctrl-C and error
 *   - a resize keeps every line; PgUp/PgDn and the wheel scroll; "jump to latest" when scrolled
 *   - a spinner while a tool runs, ✓ or ✗ once settled; tool-start events for boss and delegations
 *   - a delegation nested under the boss, behind its accent bar, its name on top
 *   - multi-line input, history from the first row only, a paste that never sends
 *   - a permission asked in the box's place, answered with one key, its verdict written
 *   - NO_COLOR: no colour code
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const FAKE = join(HERE, 'fixtures', 'acp', 'fake-server.mjs');
const { graphemeWidth, textWidth, wrap } = await import('../dist/adapters/acp/width.js');
const { emptyInput, keyInput, MouseFilter } = await import('../dist/adapters/acp/input.js');
const { Conversation } = await import('../dist/adapters/acp/conversation.js');
const { frameOf } = await import('../dist/adapters/acp/view.js');
const { accentOf } = await import('../dist/adapters/acp/ansi.js');
const { pseudonymOf } = await import('../dist/adapters/acp/pseudonyms.js');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
/** Whether a text holds a colour code (an SGR sequence). */
const hasSgr = s => s.split('\x1b[').slice(1).some(x => /^[0-9;]*m/.test(x));
const plain = s => stripVTControlCharacters(s);

// --- width: a small heuristic, no dependency ---
assert.equal(graphemeWidth('a'), 1);
assert.equal(graphemeWidth('漢'), 2);
assert.equal(graphemeWidth('😀'), 2);
assert.equal(textWidth('é'), 1, 'a combining mark takes no column');
assert.equal(textWidth('👩‍💻'), 2, 'a joined emoji is one grapheme');
assert.deepEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
assert.deepEqual(wrap('漢漢漢', 4), ['漢漢', '漢']);
console.log('tui: width passed.');

// --- input: multi-line, Enter sends, history from the first row, a paste never sends ---
{
  const keys = (s, ...ks) => ks.reduce((acc, [str, key]) => { const step = keyInput(acc.state, str, key); return { state: step.state, actions: [...acc.actions, step.action].filter(Boolean) }; }, { state: s, actions: [] });
  const type = text => [...text].map(c => [c, { name: c, sequence: c }]);
  const RET = ['\r', { name: 'return' }], ALT_RET = [undefined, { name: 'return', meta: true }], CTRL_J = ['\n', { name: 'enter' }];
  let r = keys(emptyInput(), ...type('ab'), ALT_RET, ...type('cd'), CTRL_J, ...type('ef'));
  assert.deepEqual(r.state.lines, ['ab', 'cd', 'ef']);
  assert.equal(r.actions.length, 0, 'Alt-Enter and Ctrl-J never send');
  r = keys(r.state, RET);
  assert.deepEqual(r.actions, [{ type: 'send', text: 'ab\ncd\nef' }]);
  assert.deepEqual(r.state.lines, [''], 'sent: the box is empty');
  r = keys(r.state, [undefined, { name: 'paste-start' }], ...type('x'), CTRL_J, ['\r', { name: 'return' }], ...type('y'), [undefined, { name: 'paste-end' }]);
  assert.equal(r.actions.length, 0, 'a pasted line break never sends');
  assert.deepEqual(r.state.lines, ['x', '', 'y']);
  r = keys(r.state, RET, ...type('two'), RET);
  assert.deepEqual(r.actions.map(a => a.text), ['x\n\ny', 'two']);
  r = keys(r.state, ...type('dra'), [undefined, { name: 'up' }]);
  assert.deepEqual(r.state.lines, ['two'], 'up on the first row: the history');
  r = keys(r.state, [undefined, { name: 'up' }]);
  assert.deepEqual(r.state.lines, ['x', '', 'y']);
  r = keys(r.state, [undefined, { name: 'down' }], [undefined, { name: 'down' }]);
  assert.deepEqual(r.state.lines, ['dra'], 'down past the newest: the draft back');
  r = keys(emptyInput(['old']), ...type('a'), ALT_RET, ...type('b'), [undefined, { name: 'up' }]);
  assert.deepEqual([r.state.lines, r.state.row], [['a', 'b'], 0], 'up off the first row moves the cursor, not the history');
  r = keys(r.state, [undefined, { name: 'up' }]);
  assert.deepEqual(r.state.lines, ['old'], 'then, on the first row, the history');
  r = keys(emptyInput(), ...type('one two'), ['\x17', { name: 'w', ctrl: true }]);
  assert.deepEqual(r.state.lines, ['one ']);
  r = keys(r.state, ['\x01', { name: 'a', ctrl: true }], ...type('>'), ['\x05', { name: 'e', ctrl: true }], ['\x7f', { name: 'backspace' }], ['\x15', { name: 'u', ctrl: true }]);
  assert.deepEqual(r.state.lines, ['']);
  r = keys(emptyInput(), ['\x03', { name: 'c', ctrl: true }], ['\x04', { name: 'd', ctrl: true }], [undefined, { name: 'pageup' }]);
  assert.deepEqual(r.actions.map(a => a.type), ['interrupt', 'quit', 'scroll']);
  const mouse = new MouseFilter();
  assert.deepEqual(mouse.feed(undefined, { sequence: '\x1b[<' }), { wheel: 0 }, 'a mouse report starts');
  for (const c of '64;10;5') assert.deepEqual(mouse.feed(c, { name: c, sequence: c }), { wheel: 0 }, 'its characters consumed');
  assert.deepEqual(mouse.feed('M', { name: 'm', sequence: 'M' }), { wheel: 1 }, 'the wheel up');
  assert.equal(mouse.feed('x', { name: 'x', sequence: 'x' }), null, 'no report: an ordinary key');
  console.log('tui: input passed.');
}

// --- the frame: header, conversation, box, status; tools, delegations, permissions, scroll, resize, colour ---
{
  const TIME = '2026-11-13T12:16:00.000Z';
  const HHMM = `${String(new Date(TIME).getHours()).padStart(2, '0')}:${String(new Date(TIME).getMinutes()).padStart(2, '0')}`;
  const ev = (source, kind, text, status = null, id = null) => ({ time: TIME, source, kind, text, status, id });
  const conv = new Conversation();
  const view = over => frameOf({ width: 60, height: 20, color: true, boss: 'claude-code', stamp: 'T', entries: conv.entries, scroll: 0, spinner: 0, busy: true, input: emptyInput(), asking: null, waiting: null, members: conv.group.members, ...over });
  const shown = f => f.rows.map(plain);
  const bar = rows => rows.filter(r => r.includes(' │ ')).map(r => textWidth(r.slice(0, r.indexOf(' │ '))));
  for (const e of [ev('boss', 'user', 'hello'), ev('boss', 'text', 'Hi, '), ev('boss', 'text', 'there.'), ev('boss', 'tool-start', 'Read README.md', 'read', 't1')]) conv.apply(e);
  let f = view({});
  let text = shown(f).join('\n');
  has(text, ' agent-pack · boss claude-code · chat T', '┃ ', 'claude-code · working · ctrl-c stop · ctrl-d quit');
  assert.equal(f.rows.length, 20);
  // Every line: the time, the sender right-aligned in the name column, ` │ `, the text — names of mixed lengths, one column.
  has(text, `  ${HHMM}         you │ hello`, `  ${HHMM} claude-code │ Hi, there.`);
  // One sender's run: its first line named, the next ones with the time and the name left blank, the │ in place.
  has(text, `\n                    │ → Read README.md ⠋`);
  assert.ok(f.rows.find(r => plain(r).includes('claude-code │')).includes(`\x1b[1;${accentOf('boss', true)}m`), 'the name in its accent');
  assert.ok(f.rows.find(r => plain(r).includes('claude-code │')).includes('\x1b[2m'), 'the time dim');
  conv.apply(ev('boss', 'tool', 'Read README.md', 'completed', 't1'));
  text = shown(view({})).join('\n');
  has(text, '→ Read README.md ✓');
  assert.equal(text.split('Read README.md').length - 1, 1, 'the settled line replaces the pending one');
  conv.apply(ev('boss', 'tool-start', 'Edit a.ts', 'edit', 't2'));
  conv.apply(ev('boss', 'tool', 'Edit a.ts', 'failed', 't2'));
  f = view({});
  has(f.rows.find(r => r.includes('Edit a.ts')), '\x1b[38;5;203m', '← Edit a.ts ✗');
  // A delegation: its lines carry the harness's name, in its accent, no indent; a notice is a dim `--` line.
  for (const e of [ev('helper', 'text', 'helping'), ev('helper', 'tool-start', 'Grep x', 'search', 'h1'), ev('helper', 'verdict', 'Edit /etc/passwd: outside the copy', 'refused'),
    ev('boss', 'notice', 'the boss was told it may consult: helper'), ev('boss', 'text', 'Done.')]) conv.apply(e);
  f = view({ height: 40 });
  const rows = shown(f);
  has(rows.join('\n'), `  ${HHMM}      helper │ helping`, `\n                    │ ✱ Grep x ⠋`, `\n                    │ ✗ refused: Edit /etc/passwd:`, `  ${HHMM}          -- │ the boss was told`, `  ${HHMM} claude-code │ Done.`);
  // Runs: claude-code → helper → claude-code is three, each named once; the helper's three lines name it once.
  assert.equal(rows.filter(r => r.includes('claude-code │')).length, 2, 'the boss named again after the helper');
  assert.equal(rows.filter(r => r.includes('helper │')).length, 1, 'a run of three lines: one name');
  // A notice breaks a run: the same sender after it is named again.
  conv.apply(ev('boss', 'notice', 'turn cancelled'));
  conv.apply(ev('boss', 'text', 'Again.'));
  has(shown(view({ height: 40 })).join('\n'), `  ${HHMM} claude-code │ Again.`);
  assert.ok(f.rows.find(r => plain(r).includes('helper │ helping')).includes(accentOf('helper', false)), 'the harness\'s accent');
  assert.ok(f.rows.find(r => r.includes('refused:')).includes('\x1b[38;5;203m'), 'a refusal in red');
  assert.equal(new Set(bar(rows)).size, 1, `one │ column:\n${rows.join('\n')}`);
  // Scrolled into the middle of a run: as WeeChat, the name is not shown again on the top row.
  for (let k = 0; k < 30; k++) conv.apply(ev('boss', 'tool-start', `Step ${k}`, 'read', `s${k}`));
  const middle = view({ height: 20 });
  const mid = shown(view({ height: 20, scroll: Math.floor(middle.scrollMax / 2) }));
  assert.match(mid[2], /^ +│ → Step \d+/, `the top row, mid-run, unnamed:\n${mid.join('\n')}`);
  // A long text wraps under the text column, not under the time.
  conv.apply(ev('boss', 'user', 'word '.repeat(30).trim()));
  const long = shown(view({ height: 60 })).filter(r => r.includes('│ word'));
  assert.ok(long.length > 1, 'wrapped');
  assert.ok(long[0].includes(`${HHMM}         you │ word`) && long.slice(1).every(r => /^ +│ word/.test(r)), `hanging under the text:\n${long.join('\n')}`);
  assert.equal(new Set(bar(long)).size, 1);
  // Narrow: under 50 columns no time; under 30 the name column shrinks; every row fits.
  const narrow = shown(view({ width: 40, height: 60 }));
  assert.ok(!narrow.join('\n').includes(HHMM), 'no time at 40 columns');
  has(narrow.join('\n'), ' claude-code │ Done.');
  const tiny = shown(view({ width: 26, height: 80 }));
  has(tiny.join('\n'), 'claude-… │ Done.');
  for (const width of [60, 40, 26]) assert.ok(view({ width, height: 60 }).rows.every(r => textWidthOf(r) <= width), `width ${width}: every row fits`);
  // A permission: in the box's place, the tool it is for in the warning colour.
  conv.apply(ev('boss', 'tool-start', 'Write b.ts', 'edit', 't3'));
  f = view({ asking: 'Write b.ts', waiting: 't3' });
  text = f.rows.map(plain).join('\n');
  has(text, '┃ claude-code asks to Write b.ts', '┃ [o] allow once  [r] reject');
  has(f.rows.find(r => r.includes('Write b.ts ⠋')), '\x1b[38;5;214m');
  assert.equal(f.cursor, null, 'no input cursor while asked');
  // NO_COLOR: the same layout, no code.
  f = view({ color: false, asking: 'Write b.ts', waiting: 't3', height: 120 });
  assert.ok(f.rows.every(r => !hasSgr(r)), 'no colour code');
  has(f.rows.join('\n'), '      helper │ helping', ' claude-code │ Done.', '┃ claude-code asks to Write b.ts');
  // Scroll: many lines; PgUp's page, the strip; a resize keeps every line.
  for (let k = 0; k < 40; k++) conv.apply(ev('boss', 'user', `message ${k}`));
  f = view({});
  assert.ok(f.scrollMax > 0 && !f.rows.map(plain).join('\n').includes('jump to latest'));
  has(f.rows.map(plain).join('\n'), 'message 39');
  const up = view({ scroll: f.page });
  has(up.rows.map(plain).join('\n'), '↓ jump to latest');
  assert.ok(!up.rows.map(plain).join('\n').includes('message 39'), 'a page up: the latest out of sight');
  for (const width of [80, 30]) {
    const all = new Set();
    const first = view({ width });
    for (let scroll = 0; scroll <= first.scrollMax; scroll++) for (const r of view({ width, scroll }).rows) all.add(plain(r).trim());
    for (let k = 0; k < 40; k++) assert.ok([...all].some(r => r.includes(`message ${k}`)), `width ${width}: message ${k} kept`);
    assert.ok(view({ width }).rows.every(r => textWidthOf(r) <= width), `width ${width}: every row fits`);
  }
  console.log('tui: frame passed.');
}
function textWidthOf(row) { return textWidth(plain(row)); }

// --- the group: names, joins and leaves, the participants list; blank rows between senders; the user's rows raised ---
{
  const { participantOf } = await import('../dist/adapters/acp/events.js');
  assert.equal(participantOf('codex-acp', 'reviewer'), 'codex-acp:reviewer');
  assert.equal(participantOf('codex-acp', null), 'codex-acp', 'no agent named: the harness alone');
  const ev = (source, kind, text = '', status = null, id = null) => ({ time: '2026-11-13T12:16:00.000Z', source, kind, text, status, id });
  const conv = new Conversation();
  const view = over => frameOf({ width: 90, height: 30, color: true, boss: 'claude-code', stamp: 'T', entries: conv.entries, members: conv.group.members, scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null, ...over });
  const shown = over => view(over).rows.map(plain);
  for (const e of [ev('boss', 'user', 'review notes.txt'), ev('boss', 'text', 'Asking the reviewer.'), ev('codex-acp:reviewer', 'text', '2 problems'), ev('codex-acp:reviewer', 'join'), ev('codex-acp:reviewer', 'text', ' found')]) conv.apply(e);
  assert.deepEqual(conv.group.members, ['codex-acp:reviewer']);
  assert.equal(conv.entries.filter(e => e.kind === 'join').length, 1, 'the first time it speaks: one join — its own join event, read later, adds none');
  let rows = shown({});
  has(rows.join('\n'), '--> │ codex-acp:reviewer joined', 'codex-acp:revie… │ 2 problems found');
  // The list: on the right, its count, the boss first with @, the participants in join order, the user last.
  conv.apply(ev('codex-acp', 'text', 'hi'));
  rows = shown({});
  const panel = rows.map(r => r.split('│').pop().trim()).slice(2, 7);
  assert.deepEqual(panel, ['4 participants', '@ claude-code', 'codex-acp:reviewer', 'codex-acp', 'you'], rows.join('\n'));
  assert.ok(rows[1].includes('┬'), 'the rule meets the list\'s bar');
  assert.ok(view({}).rows.find(r => plain(r).includes('codex-acp:reviewer') && plain(r).trim().endsWith('codex-acp:reviewer')).includes(accentOf('codex-acp:reviewer', false)), 'a name in its accent');
  assert.ok(!shown({ width: 69 }).join('\n').includes('participants') && !shown({ width: 69 })[1].includes('┬'), 'no list under 70 columns');
  assert.ok(view({}).rows.every(r => textWidthOf(r) <= 90) && view({ width: 70 }).rows.every(r => textWidthOf(r) <= 70), 'every row fits beside the list');
  // Removed: a `<--` line, off the list; speaking again, it joins again.
  conv.apply(ev('codex-acp', 'leave'));
  rows = shown({});
  has(rows.join('\n'), '<-- │ codex-acp removed');
  assert.ok(!rows.slice(2, 8).some(r => r.trim().endsWith(' codex-acp')), 'off the list');
  conv.apply(ev('codex-acp', 'text', 'still here'));
  assert.equal(conv.entries.filter(e => e.kind === 'join' && e.source === 'codex-acp').length, 2, 'joined again');
  assert.deepEqual(conv.group.members, ['codex-acp:reviewer', 'codex-acp']);
  // Blank rows: one between two senders' runs, none inside a run, none doubled around a notice.
  const blanks = entries => {
    const c2 = new Conversation();
    for (const e of entries) c2.apply(e);
    return frameOf({ width: 60, height: 40, color: false, boss: 'b', stamp: 'T', entries: c2.entries, members: [], scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null }).rows.slice(2).map(plain);
  };
  let b = blanks([ev('boss', 'text', 'one'), ev('h', 'text', 'two')]);
  const at1 = b.findIndex(r => r.includes('│ one')), at2 = b.findIndex(r => r.includes('│ two'));
  assert.deepEqual(b.slice(at1 + 1, at2).map(r => (r === '' ? '' : 'line')), ['line', ''], `the join line, then one blank row before the new sender:\n${b.join('\n')}`);
  b = blanks([ev('boss', 'text', 'one'), ev('boss', 'tool-start', 'Read x', 'read', 't'), ev('boss', 'text', 'three')]);
  assert.equal(b.slice(0, b.findIndex(r => r.includes('three')) + 1).filter(r => r === '').length, 0, 'one run: no blank row');
  b = blanks([ev('boss', 'text', 'one'), ev('boss', 'notice', 'note'), ev('boss', 'text', 'two')]);
  assert.equal(b.slice(0, b.findIndex(r => r.includes('two')) + 1).filter(r => r === '').length, 0, 'a notice, same sender: no blank row');
  // The user's rows: raised across the width, every row of the run; an agent's are not. Without colour: `▌`, no code.
  conv.apply(ev('boss', 'user', 'word '.repeat(30).trim()));
  const raw = view({ width: 60 }).rows;
  const user = raw.filter(r => /│ (▌ )?word/.test(plain(r)));
  assert.ok(user.length > 1 && user.every(r => r.includes('48;5;236')), 'every row of the run raised');
  assert.ok(raw.filter(r => plain(r).includes('│ still here')).every(r => !r.includes('48;5;236')), 'an agent row is not');
  const bare = view({ width: 60, color: false }).rows;
  assert.ok(bare.every(r => !hasSgr(r)), 'no code without colour');
  assert.ok(bare.filter(r => r.includes('word')).every(r => r.includes('│ ▌ word')), 'the user\'s rows behind ▌');
  console.log('tui: group, list, blank rows and raised rows passed.');
}

// --- what each participant reports: its model, its usage; the times we measure ---
{
  const { tokens, duration, clockOf, cost } = await import('../dist/adapters/acp/figures.js');
  assert.deepEqual([tokens(999), tokens(12_400), tokens(1_000), tokens(2_500_000)], ['999', '12.4k', '1k', '2.5M']);
  assert.deepEqual([duration(3_200), duration(65_000), clockOf(42_000), clockOf(3_725_000), cost(0.5)], ['3s', '1:05', '0:42', '1:02:05', '$0.50']);
  const ev = (source, kind, text = '', status = null, id = null, time = '2026-11-13T12:16:00.000Z') => ({ time, source, kind, text, status, id });
  const conv = new Conversation();
  const view = over => frameOf({ width: 100, height: 30, color: false, boss: 'claude-code', stamp: 'T', entries: conv.entries, members: conv.group.members, models: conv.group.models, usage: conv.group.usage, scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null, ...over });
  const shown = over => view(over).rows.join('\n');
  const usage = JSON.stringify({ input: 8000, output: 4400, total: 12400, cost: 0.12, currency: 'USD' });
  for (const e of [ev('boss', 'model', 'claude-opus-4'), ev('codex-acp:reviewer', 'model', 'gpt-luna'), ev('codex-acp:reviewer', 'text', 'ok'), ev('codex-acp:reviewer', 'usage', usage), ev('plain', 'text', 'hi')]) conv.apply(e);
  const text = shown({});
  has(text, '@ claude-code (claude-opus-4)', '  codex-acp:reviewer (gpt-luna)', '   12.4k tok · $0.12', '--> │ codex-acp:reviewer (gpt-luna)', '--> │ plain joined', '  plain ');
  assert.ok(!text.includes('plain ('), 'no model reported: no parentheses');
  assert.ok(!/plain\s*\n\s*\S+ tok/.test(text), 'no usage reported: no figure');
  assert.ok(text.includes('claude-code · idle · 12.4k tok · $0.12 · ctrl-c stop'), 'the chat\'s total in the status line');
  conv.apply(ev('codex-acp:reviewer', 'model', 'gpt-sol'));
  has(shown({}), '  codex-acp:reviewer (gpt-sol)');
  has(shown({}), '--> │ codex-acp:reviewer (gpt-luna) joined'); // the join line keeps the model it joined with
  conv.apply(ev('codex-acp:reviewer', 'model', 'a-very-long-model-name-indeed'));
  has(shown({}), '  codex-acp:reviewer (a-very-l…'); // past 32 columns: cut with …
  // The times we measure: the turn's and the chat's in the status line; a settled tool's duration after its mark.
  has(shown({ busy: true, elapsed: 42_000, total: 65_000 }), 'claude-code · working 0:42 · 1:05 · 12.4k tok');
  const quiet = new Conversation();
  for (const e of [ev('boss', 'tool-start', 'Read x', 'read', 't1', '2026-11-13T12:16:00.000Z'), ev('boss', 'tool', 'Read x', 'completed', 't1', '2026-11-13T12:16:03.000Z')]) quiet.apply(e);
  const q = frameOf({ width: 60, height: 12, color: false, boss: 'b', stamp: 'T', entries: quiet.entries, members: [], scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null }).rows.join('\n');
  has(q, '→ Read x ✓ 3s', 'b · idle · ctrl-c stop');
  assert.ok(!q.includes('tok'), 'nothing reported: no token figure');
  // The model under the name: on a run's second row, dim, cut to the column; a run of one row gets a row for it; none without a model.
  const modelRows = (events, width = 60) => {
    const c3 = new Conversation();
    for (const e of events) c3.apply(e);
    return frameOf({ width, height: 40, color: false, boss: 'boss-name', stamp: 'T', entries: c3.entries, members: [], scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null }).rows.slice(2).map(plain);
  };
  let m = modelRows([ev('boss', 'model', 'opus-4'), ev('boss', 'text', 'one\ntwo\nthree')]);
  let at = m.findIndex(r => r.includes('boss-name │ one'));
  assert.ok(at >= 0 && /^ +opus-4 │ two$/.test(m[at + 1].trimEnd()) && /^ +│ three$/.test(m[at + 2].trimEnd()), `the model on the second row:\n${m.join('\n')}`);
  m = modelRows([ev('boss', 'model', 'opus-4'), ev('boss', 'text', 'alone')]);
  at = m.findIndex(r => r.includes('boss-name │ alone'));
  assert.ok(/^ +opus-4 │$/.test(m[at + 1].trimEnd()), `a one-row run gets a row for its model:\n${m.join('\n')}`);
  m = modelRows([ev('boss', 'text', 'alone'), ev('boss', 'user', 'hi')]);
  at = m.findIndex(r => r.includes('boss-name │ alone'));
  assert.equal(m[at + 1].trim(), '', 'no model known: no row added');
  assert.ok(!modelRows([ev('boss', 'model', 'opus-4'), ev('boss', 'user', 'mine')]).some(r => r.includes('opus-4')), 'the user\'s run never gets a model row');
  m = modelRows([ev('boss', 'model', 'a-model-name-much-longer-than-the-column'), ev('boss', 'text', 'x')]);
  assert.ok(m.some(r => /^ +a-model-… │$/.test(r.trimEnd())), `cut to the name column, never widening it:\n${m.join('\n')}`);
  // The extra row counts: a view one row short of all rows scrolls by one.
  const counted = new Conversation();
  for (const e of [ev('boss', 'model', 'opus-4'), ev('boss', 'text', 'alone')]) counted.apply(e);
  const f2 = frameOf({ width: 60, height: 2 + 1 + 2 + 2, color: false, boss: 'b', stamp: 'T', entries: counted.entries, members: [], scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null });
  assert.equal(f2.scrollMax, 0, 'two rows fit in two');
  const f3 = frameOf({ width: 60, height: 2 + 1 + 2 + 1, color: false, boss: 'b', stamp: 'T', entries: counted.entries, members: [], scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null });
  assert.equal(f3.scrollMax, 1, 'one row short: one to scroll');
  console.log('tui: models, usage and times passed.');
}

// --- identities: the boss becomes the agent whose apx it read; the main is the boss again ---
{
  const ev = (source, kind, text = '', status = null) => ({ time: '2026-11-13T12:16:00.000Z', source, kind, text, status, id: null });
  const conv = new Conversation('cc');
  for (const e of [ev('boss', 'model', 'opus'), ev('boss', 'text', 'plain boss'), ev('boss', 'identity', 'reviewer'), ev('boss', 'text', 'as reviewer'),
    ev('boss', 'identity', 'pm'), ev('boss', 'text', 'as pm'), ev('boss', 'identity', 'agent-pack', 'main'), ev('boss', 'text', 'boss again'),
    ev('codex-acp:reviewer', 'identity', 'reviewer'), ev('codex-acp:reviewer', 'text', 'same agent'), ev('codex-acp:reviewer', 'identity', 'pm'), ev('codex-acp:reviewer', 'text', 'other agent')]) conv.apply(e);
  const said = conv.entries.filter(e => e.kind === 'text').map(e => [e.source, e.text]);
  assert.deepEqual(said, [['boss', 'plain boss'], ['cc:reviewer', 'as reviewer'], ['cc:pm', 'as pm'], ['boss', 'boss again'], ['codex-acp:reviewer', 'same agent'], ['codex-acp:pm', 'other agent']]);
  assert.deepEqual(conv.group.members, ['cc:reviewer', 'cc:pm', 'codex-acp:reviewer', 'codex-acp:pm']);
  assert.equal(conv.group.models.get('cc:reviewer'), 'opus', 'on the boss\'s model');
  const rows = frameOf({ width: 100, height: 40, color: false, boss: 'cc', stamp: 'T', entries: conv.entries, members: conv.group.members, models: conv.group.models, scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null }).rows.map(plain).join('\n');
  has(rows, '--> │ cc:reviewer (opus) joined', 'cc:reviewer │ as reviewer', '  cc:reviewer (opus)', '          cc │ boss again');
  console.log('tui: identities passed.');
}

// --- pseudonyms: the same id, the same name; the most specific group; collisions; shown in the nick column, the panel, the join line ---
{
  const samples = ['codex-acp:reviewer', 'codex-acp', 'junie:typescript-implementer', 'claude-code:pm', 'opencode'].map(id => [id, pseudonymOf({ id, model: 'gpt-5-mini' })]);
  console.log(`tui: sample pseudonyms — ${samples.map(([id, name]) => `${id} → ${name}`).join('; ')}`);
  for (const [id, name] of samples) {
    assert.equal(pseudonymOf({ id, model: 'gpt-5-mini' }), name, 'the same id, the same pseudonym');
    assert.match(name, /^[a-z]+-the-[a-z]+$/);
  }
  const { adjectivesOf } = await import('../dist/adapters/acp/pseudonyms.js');
  assert.ok(adjectivesOf({ id: 'codex-acp:reviewer', model: 'claude-haiku' }).includes('picky'), 'the role over the model');
  assert.ok(adjectivesOf({ id: 'codex-acp', model: 'claude-haiku' }).includes('swift'), 'the model\'s size over the harness');
  assert.ok(adjectivesOf({ id: 'codex-acp', model: 'gpt-x' }).includes('crafty'), 'the harness, when the model says nothing');
  assert.ok(adjectivesOf({ id: 'mystery' }).includes('curious'), 'the default');
  assert.ok(adjectivesOf({ id: 'mystery', effort: 'high' }).includes('thorough'), 'the effort, when known');
  const first = pseudonymOf({ id: 'codex-acp:reviewer' });
  const second = pseudonymOf({ id: 'codex-acp:reviewer' }, new Set([first]));
  assert.notEqual(second, first, 'a name taken: the next one');
  assert.equal(second.split('-the-')[1], first.split('-the-')[1], 'the same adjective, another first name');
  // Shown: the nick column and the join line name it; the panel shows it, then its id and model, dim.
  const ev = (source, kind, text = '') => ({ time: '2026-11-13T12:16:00.000Z', source, kind, text, status: null, id: null });
  const conv = new Conversation('cc');
  for (const e of [ev('codex-acp:reviewer', 'model', 'gpt-luna'), ev('codex-acp:reviewer', 'text', 'two problems')]) conv.apply(e);
  const nick = conv.group.pseudonyms.get('codex-acp:reviewer');
  assert.equal(nick, pseudonymOf({ id: 'codex-acp:reviewer', model: 'gpt-luna' }), 'given from the model known when it joined');
  const rows = frameOf({ width: 120, height: 20, color: false, boss: 'cc', stamp: 'T', entries: conv.entries, members: conv.group.members, models: conv.group.models, pseudonyms: conv.group.pseudonyms, scroll: 0, spinner: 0, busy: false, input: emptyInput(), asking: null, waiting: null }).rows.join('\n');
  has(rows, `${nick.slice(0, 15)}… │ two problems`, `--> │ ${nick} (codex-acp:reviewer, gpt-luna) joined`, `   ${nick}  codex-acp`); // the nick column cut at 16, the panel's details cut at 32
  conv.apply(ev('codex-acp:reviewer', 'model', 'opus-max'));
  assert.equal(conv.group.pseudonyms.get('codex-acp:reviewer'), nick, 'no renaming mid-chat');
  assert.equal(conv.group.idOf(nick), 'codex-acp:reviewer', 'a pseudonym names its participant');
  // A join event that recorded a pseudonym gives that one — the log is self-contained.
  const replay = new Conversation('cc');
  replay.apply({ ...ev('junie', 'join', 'zoe-the-tidy') });
  assert.equal(replay.group.pseudonyms.get('junie'), 'zoe-the-tidy');
  console.log('tui: pseudonyms passed.');
}

// --- the completion menu: what it lists, how it filters, its keys' effects, its rows ---
{
  const { menuOf, moved, accepted, menuRows, filtered, MENU_ROWS } = await import('../dist/adapters/acp/menu.js');
  const { COMMANDS } = await import('../dist/adapters/acp/room.js');
  const sources = {
    commands: COMMANDS,
    mentions: [{ insert: '@all', label: '@all', detail: 'everyone in the room' }, { insert: '@ari-the-sharpeyed', label: '@ari-the-sharpeyed', detail: 'codex-acp:reviewer (gpt-luna)' }],
    invitable: ['codex-acp', 'codex-acp:reviewer', 'junie', 'junie:reviewer'],
    removable: [{ insert: 'ari-the-sharpeyed', label: 'ari-the-sharpeyed', detail: 'codex-acp:reviewer' }],
  };
  const typed = text => ({ ...emptyInput(), lines: [text], col: [...text].length });
  let menu = menuOf(typed('/'), sources, null);
  assert.deepEqual(menu.items.map(i => i.label), COMMANDS.map(c => `${c.word} ${c.args}`), 'the commands, from the one table');
  assert.deepEqual(menu.items.map(i => i.detail), ['invite a harness or an agent', 'remove a participant (visual)']);
  assert.deepEqual(menuOf(typed('/re'), sources, null).items.map(i => i.insert), ['/remove'], 'filtered as typed');
  assert.deepEqual(menuOf(typed('@'), sources, null).items.map(i => [i.label, i.detail]), [['@all', 'everyone in the room'], ['@ari-the-sharpeyed', 'codex-acp:reviewer (gpt-luna)']]);
  assert.deepEqual(menuOf(typed('hi @ar'), sources, null).items.map(i => i.insert), ['@ari-the-sharpeyed'], 'a name after a space');
  assert.deepEqual(menuOf(typed('/invite rev'), sources, null).items.map(i => i.insert), ['codex-acp:reviewer', 'junie:reviewer'], 'the invitable, by substring');
  assert.deepEqual(filtered([{ insert: 'b-junie', label: 'b-junie' }, { insert: 'junie', label: 'junie' }], 'jun').map(i => i.insert), ['junie', 'b-junie'], 'prefix first, then substring');
  assert.deepEqual(menuOf(typed('/remove '), sources, null).items.map(i => i.insert), ['ari-the-sharpeyed']);
  assert.equal(menuOf(typed('hello'), sources, null), null, 'nothing to complete: no menu');
  assert.equal(menuOf(typed('/zzz'), sources, null), null, 'nothing fits: no menu');
  menu = moved(menuOf(typed('/'), sources, null), 1);
  assert.equal(menu.selected, 1);
  assert.equal(moved(menu, 1).selected, 0, 'down past the last wraps round');
  const done = accepted(typed('/'), menu);
  assert.deepEqual([done.lines[0], done.col], ['/remove ', 8], 'accepted: the completion and a space');
  const after = accepted(typed('ask @ar'), menuOf(typed('ask @ar'), sources, null));
  assert.equal(after.lines[0], 'ask @ari-the-sharpeyed ');
  // Rows: at most MENU_ROWS, a window around the selection, each the width given; selected raised — or behind > without colour.
  const many = { items: Array.from({ length: 12 }, (_, k) => ({ insert: `x${k}`, label: `x${k}`, detail: 'a detail' })), selected: 10, start: 0 };
  const rows = menuRows(many, 20, true);
  assert.equal(rows.length, MENU_ROWS);
  assert.ok(rows.some(r => plain(r).includes('x10')) && rows.find(r => plain(r).includes('x10')).includes('48;5;236'), 'the selected row raised');
  assert.ok(rows.every(r => textWidth(plain(r)) === 20), 'each row the width given');
  const bare = menuRows({ ...many, selected: 0 }, 12, false);
  assert.ok(bare.every(r => !hasSgr(r)) && plain(bare[0]).startsWith('> x0') && plain(bare[1]).startsWith('  x1'), 'no colour: the selected behind >');
  assert.ok(menuRows(many, 6, false).every(r => textWidth(r) === 6), 'narrow: still fits');
  // In the frame: over the conversation's last rows, above the box — nothing else moves.
  const conv = new Conversation();
  for (let k = 0; k < 20; k++) conv.apply({ time: '', source: 'boss', kind: 'user', text: `line ${k}`, status: null, id: null });
  const base = { width: 60, height: 20, color: false, boss: 'b', stamp: 'T', entries: conv.entries, members: [], scroll: 0, spinner: 0, busy: false, input: typed('/'), asking: null, waiting: null };
  const without = frameOf(base).rows;
  const withMenu = frameOf({ ...base, menu: menuOf(typed('/'), sources, null) }).rows;
  assert.equal(withMenu.length, without.length);
  const boxAt = without.findIndex(r => r.includes('┃ /'));
  assert.deepEqual(withMenu.slice(boxAt), without.slice(boxAt), 'the box and the status line unmoved');
  // The conversation's last rows, then the blank row above the box.
  assert.ok(withMenu[boxAt - 3].includes('> /invite [name]') && withMenu[boxAt - 2].includes('/remove <name>'), `the menu right above the box:\n${withMenu.join('\n')}`);
  assert.deepEqual(withMenu.slice(0, boxAt - 3), without.slice(0, boxAt - 3), 'the rows above the menu as they were');
  console.log('tui: the completion menu passed.');
}

// --- the launcher: categories and counts, a search across them, the panes, the actions, the rows ---
{
  const { shownOf, launcherKey, launcherRows, openLauncher } = await import('../dist/adapters/acp/launcher.js');
  const entry = (kind, name, extra = {}) => ({ kind, id: `${kind.slice(0, 3)}-${name}`, name, about: `about ${name}`, tags: [], scope: null, uses: [], holder: '', apx: '.agent-pack/apx/x.apx', unit: 'feature-delivery', ...extra });
  const flow = entry('flow', 'develop-feature', { uses: ['pm', 'typescript-implementer'] });
  const data = {
    flow: [{ name: flow.name, about: flow.about, entry: flow }],
    agent: ['pm', 'code-reviewer'].map(n => ({ name: n, about: `about ${n}`, entry: entry('agent', n) })),
    policy: [{ name: 'coding', about: 'about coding', entry: entry('policy', 'coding') }],
    room: [{ name: 'ari-the-sharpeyed', about: 'codex-acp:reviewer', insert: '@ari-the-sharpeyed ' }],
    command: [{ name: '/invite [name]', about: 'invite', insert: '/invite ' }],
  };
  const key = (name, str) => ({ str, key: { name, sequence: str ?? '' } });
  const press = (state, ...keys) => keys.reduce((acc, k) => { const step = launcherKey(acc.state, data, k.str, k.key); return { state: step.state, actions: [...acc.actions, step.action].filter(Boolean) }; }, { state, actions: [] });
  assert.deepEqual(shownOf(data, '').map(c => [c.key, c.items.length]), [['flow', 1], ['agent', 2], ['policy', 1], ['room', 1], ['command', 1]], 'in order, with counts; the empty ones hidden');
  assert.deepEqual(shownOf(data, 'review').map(c => [c.key, c.items.map(i => i.name)]), [['agent', ['code-reviewer']], ['room', ['ari-the-sharpeyed']]], 'a search across every category, grouped');
  let r = press(openLauncher(), key('return'));
  assert.deepEqual(r.actions, [{ type: 'run', entry: flow }], 'a flow: Enter runs it');
  r = press(openLauncher(), key('down'), key('right'), key('down'), key('return'));
  assert.deepEqual([r.state.pane, r.actions[0].type, r.actions[0].entry.name], ['items', 'show', 'code-reviewer'], 'any other block: Enter shows it — the arrows between and within the panes');
  r = press(openLauncher(), key(undefined, 's'));
  assert.deepEqual(r.actions, [{ type: 'show', entry: flow }], 's shows, while the search is empty');
  r = press(openLauncher(), key(undefined, '#'));
  assert.deepEqual(r.actions, [{ type: 'insert', text: '#develop-feature ' }], '# cites');
  r = press(openLauncher(), key('r', 'r'), key('e', 'e'), key('v', 'v'), key('s', 's'), key('backspace'));
  assert.equal(r.state.search, 'rev', 'typing goes to the search — s and # too, once it has text; Backspace edits it');
  assert.deepEqual(shownOf(data, r.state.search).map(c => c.key), ['agent', 'room']);
  r = press(openLauncher(), key('down'), key('down'), key('down'), key('return'));
  assert.deepEqual(r.actions, [{ type: 'insert', text: '@ari-the-sharpeyed ' }], 'the room: Enter puts the mention in the box');
  assert.deepEqual(press(openLauncher(), key('escape')).actions, [{ type: 'close' }]);
  // Rows: the box, at 80×24 (the conversation's room); one pane under 60 columns; no colour code without colour.
  const rows = launcherRows(openLauncher(), data, { width: 76, height: 15 }, true);
  assert.equal(rows.length, 15);
  assert.ok(rows.every(row => textWidth(plain(row)) === 76), rows.map(plain).join('\n'));
  const text = rows.map(plain).join('\n');
  has(text, '╭─ agent-pack ─', '🔍 search…', '│  ▶ Flows       1 │', '● Agents      2',  '▶ develop-feature', 'feature-delivery', 'develop-feature — flow of feature-delivery · uses pm, typescript-implemen', '[Enter] run   [s] show   [#] cite');
  assert.ok(rows[2].includes('┬') && !text.includes('Skills'), 'two panes; no empty category');
  const narrow = launcherRows(openLauncher(), data, { width: 40, height: 12 }, false);
  assert.ok(narrow.every(row => textWidth(row) === 40) && !narrow[2].includes('┬'), 'one pane under 60 columns');
  assert.ok(narrow.every(row => !hasSgr(row)), 'no colour code');
  console.log('tui: the launcher passed.');
}

// --- the screen, on a pseudo-terminal: a fake boss, keys typed ---
const proj = mkdtempSync(join(tmpdir(), 'ap-tui-'));
const fake = env => `{ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}], env: ${JSON.stringify(env)} }`;
writeFileSync(join(proj, 'agent-pack.config.mjs'), `export default { adapters: [{ name: 'acp', servers: { boss: ${fake({ FAKE_ACP: 'boss', FAKE_PROMPTS: join(proj, 'boss-prompts.jsonl') })}, helper: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'ok.' })} } }], chat: { boss: 'boss' } };\n`);
writeFileSync(join(proj, 'README.md'), '# here\n');
const BOSS_PROMPTS = join(proj, 'boss-prompts.jsonl');
const env = { ...process.env };
for (const k of ['NO_COLOR', 'AGENT_PACK_CHAT_EVENTS', 'CLAUDE_CODE_SESSION_ID', 'AGENT_PACK_SESSION_ID']) delete env[k];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mkdirp = dir => { mkdirSync(dir, { recursive: true }); return dir; };
/** A chat on a pseudo-terminal of 80×20: the keys typed one by one, then what the terminal received, and the exit code. */
async function onTty(keys, extraEnv = {}) {
  const p = spawn('script', ['-qfec', `stty cols 80 rows 20; exec ${process.execPath} ${CLI} chat`, '/dev/null'], { cwd: proj, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => p.on('exit', code => r(code)));
  const ready = async () => { for (let t = 0; t < 100 && !out.includes('ctrl-d quit'); t++) await sleep(50); };
  await ready();
  for (const k of keys) { p.stdin.write(k); await sleep(400); }
  const code = await Promise.race([exited, sleep(8000).then(() => { p.kill(); return 'killed'; })]);
  return { out, code };
}
const restored = out => {
  const end = out.lastIndexOf('\x1b[?1049l');
  assert.ok(out.includes('\x1b[?1049h') && end > 0, 'the alternate screen, left at the end');
  has(out.slice(out.lastIndexOf('\x1b[?2004l') - 20), '\x1b[?1000l', '\x1b[?2004l', '\x1b[?25h');
};
const eventsOf = () => readdirSync(join(proj, '.agent-pack', 'chats')).sort().map(f => readFileSync(join(proj, '.agent-pack', 'chats', f), 'utf-8'));

if (spawnSync('script', ['--version']).status !== 0) {
  console.log('tui: no `script` on this machine — the pseudo-terminal tests skipped.');
} else {
  try {
    // A turn: the reply, a tool, a delegation nested; Ctrl-D quits, the terminal restored.
    const helper = `run ${process.execPath} ${CLI} ask helper hi`;
    let r = await onTty([`say hello world ;; tool Read README.md ;; ${helper}\r`, '\x04']);
    assert.equal(r.code, 0, r.out);
    has(plain(r.out), ' agent-pack · boss boss · chat ', 'you │ say hello world', 'boss │ hello world', ' │ → Read README.md ✓', `${pseudonymOf({ id: 'helper', model: 'fake-big' })}  helper`, ' │ ✗ refused: Edit outside', 'boss · idle · ', 'ctrl-c stop · ctrl-d quit');
    restored(r.out);
    let events = eventsOf().pop();
    assert.ok(/"source":"boss","kind":"tool-start","text":"Read README.md","status":"read","id":"tool-\d+"/.test(events), events);
    assert.ok(/"source":"helper","kind":"tool-start","text":"Read","status":"read","id":"t1"/.test(events), 'a delegation writes its tool starts too');
    console.log('tui: a turn on a terminal passed.');

    // A permission, answered with one key; Ctrl-C at the empty prompt quits.
    r = await onTty([`ask ${join(proj, 'x.ts')}\r`, 'r', '\x03']);
    assert.equal(r.code, 0, r.out);
    has(plain(r.out), `boss asks to Edit ${join(proj, 'x.ts')}`, '[o] allow once  [r] reject', '✗ refused: Edit');
    restored(r.out);
    events = eventsOf().pop();
    assert.ok(events.includes('you rejected it"'), 'the verdict is written');
    // A paste with a newline does not send; Enter does.
    r = await onTty(['\x1b[200~say pasted\nsay twice\x1b[201~', '\r', '\x04']);
    events = eventsOf().pop();
    assert.equal(events.split('\n').filter(l => l.includes('"kind":"user"')).length, 1, 'one turn: the paste, then Enter');
    has(events, '"text":"say pasted\\nsay twice"');
    // The menu: `/` lists the commands; ↓ then Tab puts /remove in the box; Esc closes it.
    r = await onTty(['/', '\x1b[B', '\t', '\x1b', '\x15', '\x04']);
    has(plain(r.out), '/invite [name]', 'invite a harness or an agent', '/remove <name>', '┃ /remove ');
    restored(r.out);
    // The launcher: Ctrl-P, run the team's flow (one boss prompt with its apx command); show a block (no prompt); cite one.
    const team = join(proj, 'agents', 'teams', 'site');
    for (const name of ['lead', 'writer']) writeFileSync(join(mkdirp(team), `${name}.ap`), [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work', ''].join('\n'));
    writeFileSync(join(team, 'site.ap'), ['EXPORT TEAM site:', '    MEMBER  lead, writer', '    ABOUT  builds the site', '    WHEN asked to build:', '        RUN build', '    FLOW build:', '        STEP write:', '            DELEGATE write the notes BY writer', ''].join('\n'));
    const bundled = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, env, encoding: 'utf-8' });
    assert.equal(bundled.status, 0, bundled.stdout + bundled.stderr);
    const promptsBefore = existsSync(BOSS_PROMPTS) ? readFileSync(BOSS_PROMPTS, 'utf-8').trimEnd().split('\n').length : 0;
    r = await onTty(['\x10', '\r', '\x10', 's', '\x10', '#', 'please\r', '\x04']);
    restored(r.out);
    has(plain(r.out), '╭─ agent-pack ─', '▶ Flows', 'build — flow of site');
    const bossSaw = readFileSync(BOSS_PROMPTS, 'utf-8').trimEnd().split('\n').slice(promptsBefore).map(l => JSON.parse(l));
    assert.equal(bossSaw.length, 2, `the run and the cited message — not the show: ${JSON.stringify(bossSaw)}`);
    assert.ok(/Run the flow `build` of site: `node \.agent-pack\/apx\/site\.apx flow flw-[0-9a-f]{8}`/.test(bossSaw[0]), bossSaw[0]);
    assert.ok(bossSaw[1].startsWith('#build please') && /\[agent-pack\] #build is the flow `build` \(flw-[0-9a-f]{8}\) — read it with: node \.agent-pack\/apx\/site\.apx get flw-/.test(bossSaw[1]), bossSaw[1]);
    const log = eventsOf().pop();
    has(log, '"kind":"user","text":"▶ run flow build"', '"kind":"notice","text":"# `build`', '# flow build  flw-');
    console.log('tui: the launcher on a terminal passed.');

    // An error — the boss dies: the terminal restored, a non-zero exit.
    r = await onTty(['die\r']);
    assert.notEqual(r.code, 0);
    restored(r.out);
    // NO_COLOR: the screen drawn, no colour code.
    r = await onTty(['say plain\r', '\x04'], { NO_COLOR: '1' });
    has(plain(r.out), 'plain', 'ctrl-d quit');
    assert.ok(!hasSgr(r.out), 'no colour code under NO_COLOR');
    console.log('tui: keys, permission, paste, error and NO_COLOR on a terminal passed.');
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}
