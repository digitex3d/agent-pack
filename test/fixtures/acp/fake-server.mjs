// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A tiny ACP agent for the tests: JSON-RPC 2.0 over stdio, one message a line.
 * What it does is its env's `FAKE_ACP`:
 *   ok       — opens the session, asks the client what the tests probe, answers `FAKE_ANSWER`
 *   auth     — refuses session/new: authentication required (and prints its secret on stderr)
 *   crash    — prints its secret on stderr and exits before the turn ends
 *   hang     — never ends the turn
 *   refusal  — ends the turn with stopReason refusal
 *   boss     — a boss for `agent-pack chat`: each line of a prompt an instruction —
 *              `say <text>`, `color <text>` (in red, with escape codes), `tool <title>`,
 *              `ask <path>` (a permission to edit it), `die` (exits at once), `model <id>` (a model change), `run <command>` (a shell command,
 *              its output streamed), `spawn-child <pidfile>` (a child that outlives the
 *              turn), `wait` (until session/cancel); thoughts and a plan in every turn.
 *              `FAKE_OWN_SESSION` set: the commands it runs see it under `FAKE_SESSION_ENV`;
 *              In every mode, `FAKE_PROMPTS` set: each prompt it receives appended there, as one JSON line.
 * Every turn reports 1500 tokens and $0.25 more spent (none under FAKE_NO_USAGE); session/new reports
 * the model fake-big (none under FAKE_NO_MODEL).
 * In `ok`, `FAKE_ECHO` set: the value of the variable it names said before the answer.
 * In `ok`, what the client answered is written, through the client's fs, to `acp-probe.json` in the session's cwd.
 */
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_ACP ?? 'ok';
const secret = process.env.FAKE_SECRET ?? '';
let next = 1000;
const waiting = new Map();
const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const ask = (method, params) => new Promise(done => { const id = ++next; waiting.set(id, done); send({ id, method, params }); });
const say = (sessionId, text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const outcome = r => (r.error ? `error: ${r.error.message}` : r.result?.outcome?.optionId ?? r.result?.outcome?.outcome ?? 'ok');
const OPTIONS = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];
let cwd = '';
let model = null;
let initialized = null;

let cancelled = null;
let spent = 0;
/** A turn's usage, as the real agents report it: tokens on the prompt's answer, the session's spend so far in a usage_update — none under FAKE_NO_USAGE. */
function turnUsage(sessionId) {
  if (process.env.FAKE_NO_USAGE) return {};
  spent += 0.25;
  update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: spent, currency: 'USD' } });
  return { usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 500 } };
}
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

async function bossTurn(id, sessionId, text) {
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden thoughts' } });
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'hidden plan', priority: 'high', status: 'pending' }] });
  let n = 0;
  // One instruction a line — or, typed on one line, separated by ` ;; `.
  for (const line of text.split(/\n| ;; /).filter(Boolean)) {
    const [verb, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    const tool = `tool-${++n}`;
    if (verb === 'say') { say(sessionId, arg.slice(0, 3)); say(sessionId, `${arg.slice(3)}\n`); }
    if (verb === 'color') say(sessionId, `\x1b[31m${arg}\x1b[0m\n`);
    if (verb === 'tool') {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: tool, title: arg, kind: 'read', status: 'pending' });
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool, status: 'completed' });
    }
    if (verb === 'ask') {
      const r = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: tool, title: `Edit ${arg}`, kind: 'edit', locations: [{ path: arg }] },
        options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, ...OPTIONS] });
      say(sessionId, `permission: ${outcome(r)}\n`);
    }
    if (verb === 'run') {
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: tool, title: `Run ${arg}`, kind: 'execute', status: 'in_progress' });
      const env = { ...process.env, ...(process.env.FAKE_OWN_SESSION ? { [process.env.FAKE_SESSION_ENV]: process.env.FAKE_OWN_SESSION } : {}) };
      const r = spawnSync('sh', ['-c', arg], { cwd, env, encoding: 'utf-8' });
      say(sessionId, `${r.stdout}`);
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: tool, status: r.status === 0 ? 'completed' : 'failed' });
    }
    if (verb === 'spawn-child') writeFileSync(arg, String(spawn('sleep', ['60'], { stdio: 'ignore' }).pid));
    if (verb === 'die') process.exit(3);
    if (verb === 'model') update(sessionId, { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', category: 'model', currentValue: arg }] });
    if (verb === 'wait') await new Promise(done => { cancelled = done; });
  }
  const stopReason = cancelled === 'done' ? 'cancelled' : 'end_turn';
  cancelled = null;
  send({ id, result: { stopReason, ...turnUsage(sessionId) } });
}

async function turn(id, sessionId) {
  say(sessionId, 'Let me look around first.');
  // `FAKE_ECHO` names a variable of its environment: its value said, as an agent that echoes it would.
  if (process.env.FAKE_ECHO) say(sessionId, ` (${process.env[process.env.FAKE_ECHO]})`);
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' } } });
  const probe = {
    cwd, model, capabilities: initialized.clientCapabilities,
    permissionInside: outcome(await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't2', title: 'Edit inside', kind: 'edit', locations: [{ path: `${cwd}/src/a.ts` }] }, options: OPTIONS })),
    permissionOutside: outcome(await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't3', title: 'Edit outside', kind: 'edit', locations: [{ path: '/etc/passwd' }] }, options: OPTIONS })),
    permissionEscape: outcome(await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't4', title: 'Edit via ..', kind: 'edit', rawInput: { file_path: `${cwd}/../../escape.txt` } }, options: OPTIONS })),
    readOutside: outcome(await ask('fs/read_text_file', { sessionId, path: '/etc/hostname' })),
    readInside: (await ask('fs/read_text_file', { sessionId, path: `${cwd}/README.md` })).result?.content ?? null,
    terminal: outcome(await ask('terminal/create', { sessionId, command: 'echo', args: ['hi'] })),
  };
  await ask('fs/write_text_file', { sessionId, path: `${cwd}/acp-probe.json`, content: JSON.stringify(probe) });
  say(sessionId, process.env.FAKE_ANSWER ?? 'done');
  send({ id, result: { stopReason: 'end_turn', ...turnUsage(sessionId) } });
}

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  switch (m.method) {
    case 'initialize':
      initialized = m.params;
      send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: mode === 'auth' ? [{ id: 'jetbrains-account', name: 'JetBrains account' }] : [] } });
      break;
    case 'session/new':
      cwd = m.params.cwd;
      if (mode === 'auth') { process.stderr.write(`token=${secret}\n`); send({ id: m.id, error: { code: -32000, message: 'Authentication required' } }); break; }
      if (mode === 'crash') { process.stderr.write(`boom, token=${secret}\n`); process.exit(3); }
      send({ id: m.id, result: { sessionId: 's-1', ...(process.env.FAKE_NO_MODEL ? {} : { models: { availableModels: [{ modelId: 'fake-small', name: 'small' }], currentModelId: 'fake-big' } }) } });
      break;
    case 'session/set_model':
      model = m.params.modelId;
      send({ id: m.id, result: {} });
      break;
    case 'session/cancel':
      if (typeof cancelled === 'function') { const done = cancelled; cancelled = 'done'; done(); }
      break;
    case 'session/prompt':
      if (process.env.FAKE_PROMPTS) appendFileSync(process.env.FAKE_PROMPTS, `${JSON.stringify(m.params.prompt.map(p => p.text).join('\n'))}\n`);
      if (mode === 'boss') { void bossTurn(m.id, m.params.sessionId, m.params.prompt.map(p => p.text).join('\n')); break; }
      if (mode === 'hang') break;
      if (mode === 'refusal') { send({ id: m.id, result: { stopReason: 'refusal' } }); break; }
      void turn(m.id, m.params.sessionId);
      break;
    default:
      send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
