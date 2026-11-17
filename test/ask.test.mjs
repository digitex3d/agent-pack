// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `agent-pack ask <harness> "<task>"` — one task on an ACP harness of the
 * config, through the ACP client, a fake ACP agent as the harness:
 *
 *   - the answer on stdout, exit 0; standalone, no events written
 *   - inside a chat (AGENT_PACK_CHAT_EVENTS), its events tagged with the harness
 *   - `<harness>:<agent>`: the prompt opens with the adapter's intro naming the
 *     agent's native file, no compiled definition read; on a bare acp server,
 *     whose agent files no adapter writes, refused naming why
 *   - an unknown harness or a failing one: non-zero, the cause on stderr, every event line whole
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const FAKE = join(HERE, 'fixtures', 'acp', 'fake-server.mjs');
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const fake = env => `{ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}], env: ${JSON.stringify(env)} }`;

const proj = mkdtempSync(join(tmpdir(), 'ap-ask-'));
const prompts = join(proj, 'prompts.jsonl');
const base = { ...process.env };
delete base.AGENT_PACK_CHAT_EVENTS;
const ask = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, 'ask', ...args], { cwd: proj, encoding: 'utf-8', env: { ...base, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const lines = file => readFileSync(file, 'utf-8');

try {
  writeFileSync(join(proj, 'README.md'), '# here\n');
  writeFileSync(join(proj, 'agent-pack.config.mjs'), ['export default {', '  adapters: [',
    `    { name: 'acp', servers: { helper: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'the answer' })}, broken: ${fake({ FAKE_ACP: 'refusal' })}, echo: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'echoed', FAKE_ECHO: 'PARENT_API_KEY' })} } },`,
    `    { name: 'codex', acp: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'from codex', FAKE_PROMPTS: prompts })} },`,
    `    { name: 'claude-code', acp: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'from claude', FAKE_PROMPTS: prompts })} },`, '  ],', '};', ''].join('\n'));

  // Standalone: the answer on stdout, exit 0, no events anywhere.
  let r = ask(['helper', 'help me']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'the answer\n');
  has(r.stderr, 'acp helper: refused permission for Edit outside: it touches /etc/passwd, outside the copy');
  assert.ok(!existsSync(join(proj, '.agent-pack', 'chats')), 'no events file without a chat');
  assert.equal(JSON.parse(lines(join(proj, 'acp-probe.json'))).cwd, proj, 'the folder it runs in is its cwd');
  r = ask(['codex', 'help me']);
  assert.equal(r.stdout, 'from codex\n', 'a built-in harness with its acp option');
  console.log('ask: standalone passed.');

  // A named agent: the adapter's intro names it and its native file; no compiled definition is read.
  writeFileSync(prompts, '');
  r = ask(['codex:dry-review', 'review it']);
  assert.equal(r.code, 0, r.stderr);
  r = ask(['claude-code:dry-review', 'review it']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(lines(prompts).trimEnd().split('\n').map(l => JSON.parse(l)), [
    'Have the custom agent `dry-review` carry out the task below, and answer with its result.\n\nreview it',
    'Act as the agent `dry-review` defined in `.claude/agents/dry-review.md`: read that file first and follow it, then carry out the task below, and answer with its result.\n\nreview it',
  ]);
  assert.ok(!existsSync(join(proj, '.agent-pack', 'compiled')), 'no compiled definition looked for or written');
  // A bare acp server: no adapter writes its agent files — refused, nothing run.
  r = ask(['helper:dry-review', 'review it']);
  assert.notEqual(r.code, 0);
  has(r.stderr, "agent-pack: helper cannot act as `dry-review`: no adapter writes helper's agent files");
  assert.equal(r.stdout, '');
  console.log('ask: named agents passed.');

  // Inside a chat: the harness's text, tool and verdict events, tagged with its name.
  const events = join(proj, 'events.jsonl');
  writeFileSync(events, '');
  r = ask(['helper', 'help me'], { AGENT_PACK_CHAT_EVENTS: events });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'the answer\n');
  const all = lines(events).trimEnd().split('\n').map(l => JSON.parse(l));
  assert.ok(all.every(e => e.source === 'helper'), 'tagged with the harness');
  for (const kind of ['text', 'tool', 'verdict']) assert.ok(all.some(e => e.kind === kind), `a ${kind} event`);
  assert.ok(all.some(e => e.kind === 'verdict' && e.status === 'refused' && e.text.includes('/etc/passwd')));
  // A secret-named variable the server only inherits, echoed by the agent: masked in the events too.
  writeFileSync(events, '');
  r = ask(['echo', 'help me'], { AGENT_PACK_CHAT_EVENTS: events, PARENT_API_KEY: 'parent-secret-value' });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!lines(events).includes('parent-secret-value'), 'the inherited secret is not in the events');
  assert.ok(lines(events).includes('"text":" (***)"'), 'it is masked where the agent said it');
  console.log('ask: inside a chat passed.');

  // An unknown harness: the ones there are, listed.
  r = ask(['nobody', 'x']);
  assert.notEqual(r.code, 0);
  assert.equal(r.stderr.trim(), 'agent-pack: no ACP harness is called `nobody` — the ACP harnesses configured: helper, broken, echo, codex, claude-code');
  assert.equal(r.stdout, '');

  // A failing harness: non-zero, the cause on stderr, the events whole lines — the failure among them.
  writeFileSync(events, '');
  r = ask(['broken', 'x'], { AGENT_PACK_CHAT_EVENTS: events });
  assert.notEqual(r.code, 0);
  has(r.stderr, 'agent-pack: the turn ended without an answer: stopReason refusal');
  assert.equal(r.stdout, '');
  const text = lines(events);
  assert.ok(text.endsWith('\n'));
  const failed = text.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.ok(failed.some(e => e.source === 'broken' && e.kind === 'notice' && e.text.includes('stopReason refusal')));
  console.log('ask: failures passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
