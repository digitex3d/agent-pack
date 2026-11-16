// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * `agent-pack chat` — the boss a fake ACP agent (fixtures/acp/fake-server.mjs,
 * mode boss), the delegations through the real ACP client to a fake helper:
 *
 *   - a turn per line: the reply streamed, a line per tool call, a permission asked
 *   - one events file: the boss's and the helper's events, the generic shape, masked
 *   - the helper's lines indented under `[helper]`, in order; its refusals automatic
 *   - Ctrl-C cancels a turn, quits at an empty prompt; Ctrl-D quits; the boss stopped
 *   - the session id the apx reads: the chat's, or the boss's own
 *   - a missing or unknown chat.boss, and a config error, as one clean line
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { teamSource } from './helpers/team.mjs';

const { pseudonymOf } = await import('../dist/adapters/acp/pseudonyms.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'dist', 'index.js');
const CLIENT = join(HERE, '..', 'dist', 'adapters', 'acp', 'client.js');
const FAKE = join(HERE, 'fixtures', 'acp', 'fake-server.mjs');
const SECRET = 's3cr3t-chat-token';
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
const fake = env => `{ command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}], env: ${JSON.stringify({ FAKE_SECRET: SECRET, ...env })} }`;
const proj0 = mkdtempSync(join(tmpdir(), 'ap-chat-prompts-'));
const PROMPTS = join(proj0, 'prompts.jsonl');
const HELPER_PROMPTS = join(proj0, 'helper-prompts.jsonl');
const lastPrompt = file => readFileSync(file, 'utf-8').trimEnd().split('\n').map(l => JSON.parse(l)).pop();
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(done => setTimeout(done, ms));

const proj = mkdtempSync(join(tmpdir(), 'ap-chat-'));
const env = { ...process.env };
// The chat is the session: none inherited from whatever runs the tests.
delete env.CLAUDE_CODE_SESSION_ID;
delete env.AGENT_PACK_SESSION_ID;
delete env.AGENT_PACK_CHAT_EVENTS;
const run = args => { const r = spawnSync(process.execPath, args, { cwd: proj, encoding: 'utf-8', env }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() }; };
const config = chat => write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',",
  `  adapters: [{ name: 'acp', servers: { boss: ${fake({ FAKE_ACP: 'boss', FAKE_PROMPTS: PROMPTS })}, own: ${fake({ FAKE_ACP: 'boss', FAKE_OWN_SESSION: 'own-session-1', FAKE_SESSION_ENV: 'AGENT_PACK_SESSION_ID' })}, helper: ${fake({ FAKE_ACP: 'ok', FAKE_ANSWER: 'ok.', FAKE_PROMPTS: HELPER_PROMPTS })}, broken: ${fake({ FAKE_ACP: 'refusal' })} } }],`,
  ...(chat ? [`  chat: ${chat},`] : []), '};']);

/** A chat, as a user drives it: what it printed so far, a line typed, a signal, waiting for a text. */
function chat() {
  const child = spawn(process.execPath, [CLI, 'chat'], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const c = { child, out: '', code: null };
  child.stdout.on('data', d => { c.out += d; });
  child.stderr.on('data', d => { c.out += d; });
  c.exited = new Promise(done => child.on('exit', code => { c.code = code; done(code); }));
  c.type = line => child.stdin.write(`${line}\n`);
  c.until = async (text, from = 0, ms = 10_000) => {
    const at = Date.now();
    while (c.out.indexOf(text, from) < 0) {
      if (Date.now() - at > ms || c.code !== null) assert.fail(`no ${JSON.stringify(text)} in:\n${c.out}`);
      await sleep(20);
    }
    return c.out.indexOf(text, from) + text.length;
  };
  return c;
}

try {
  const team = join(proj, 'agents', 'teams', 'site');
  for (const name of ['lead', 'writer']) {
    write(join(team, `${name}.ap`), [`EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work']);
  }
  write(join(team, 'site.ap'), teamSource('site', ['lead', 'writer'], ['IMPORT notes FROM @main.vars', 'ABOUT  builds the site', 'WHEN asked to build:', '    RUN build',
    'FLOW build:', '    STEP write:', '        DELEGATE write {{notes}} BY writer']));
  write(join(proj, 'library', 'vars', 'site.ap'), ['EXPORT SESSION VAR notes']);
  write(join(proj, 'README.md'), ['# site']);
  write(join(proj, '.gitignore'), ['.agent-pack/']);
  for (const args of [['init', '-q'], ['config', 'user.email', 'dev@example.com'], ['config', 'user.name', 'dev'], ['add', '-A'], ['commit', '-qm', 'start']]) spawnSync('git', args, { cwd: proj });

  // --- chat.boss: missing, unknown — one clean line naming the key, no default ---
  config(null);
  let r = run([CLI, 'chat']);
  assert.notEqual(r.code, 0);
  assert.equal(r.out, "agent-pack: chat.boss is not set — name the harness the chat talks to in agent-pack.config.mjs: chat: { boss: '<harness>' }");
  config("{ boss: 'nobody' }");
  r = run([CLI, 'chat']);
  assert.notEqual(r.code, 0);
  has(r.out, 'agent-pack: chat.boss names `nobody`, and no ACP server is configured under that name');
  config("{ boss: '' }");
  has(run([CLI, 'chat']).out, 'agent-pack: chat.boss must name the harness');
  // A config error, from any command: one line, a non-zero exit, no stack.
  config("{ boss: 'boss' }");
  write(join(proj, 'agent-pack.config.mjs'), [readFileSync(join(proj, 'agent-pack.config.mjs'), 'utf-8').replace("helper:", `codex: ${fake({})}, helper:`)]);
  r = run([CLI, 'harness', 'list']);
  assert.notEqual(r.code, 0);
  assert.equal(r.out, "agent-pack: adapters: acp's `codex` takes the name of the installed harness `codex` — give acp's one another name");
  assert.ok(!r.out.includes('    at '), 'no stack trace');
  config("{ boss: 'boss' }");
  assert.equal(run([CLI, 'bundle', 'all']).code, 0, 'bundle all');

  // An apx serving who it is inside a chat: one identity event on start or scope; none on other verbs, none repeated, none outside a chat.
  {
    const file = join(proj, 'identity.jsonl');
    writeFileSync(file, '');
    const apxRun = (args, extra) => spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'site.apx'), ...args], { cwd: proj, encoding: 'utf-8', env: { ...env, ...extra } });
    const inChat = { AGENT_PACK_CHAT_EVENTS: file, AGENT_PACK_CHAT_SOURCE: 'boss' };
    apxRun(['lead', 'start'], inChat);
    apxRun(['lead', 'start'], inChat);
    apxRun(['lead', 'get', 'notes'], inChat);
    apxRun(['lead', 'scope'], { ...inChat, AGENT_PACK_CHAT_SOURCE: 'helper' });
    apxRun(['start'], inChat);
    apxRun(['writer', 'start'], { AGENT_PACK_SESSION_ID: 'x' });
    const ids = readFileSync(file, 'utf-8').trimEnd().split('\n').map(l => JSON.parse(l)).map(e => [e.kind, e.source, e.text, e.status]);
    assert.deepEqual(ids, [['identity', 'boss', 'lead', null], ['identity', 'helper', 'lead', null], ['identity', 'boss', 'site', null]],
      'once per new identity and source; never on get; nothing outside a chat');
    // The listing a unit gives as JSON: the unit, and every block of every document it holds — its own and each agent's.
    const listing = JSON.parse(apxRun(['ls', '--json'], {}).stdout);
    assert.deepEqual(listing.unit, { kind: 'team', name: 'site' });
    const flowEntry = listing.entries.find(e => e.kind === 'flow' && e.name === 'build');
    assert.ok(flowEntry && flowEntry.holder === '' && flowEntry.uses.includes('writer'), JSON.stringify(flowEntry));
    assert.ok(listing.entries.some(e => e.kind === 'agent' && e.name === 'lead' && e.holder === 'lead'), 'an agent, from its own document');
    assert.equal(new Set(listing.entries.map(e => e.id)).size, listing.entries.length, 'each block once');
    const agentList = JSON.parse(apxRun(['lead', 'ls', '--json'], {}).stdout);
    assert.ok(agentList.unit === null && agentList.entries.every(e => e.holder === 'lead'), 'an agent\'s own listing');
  }
  console.log('chat: the config passed.');

  // A delegation's copy, as the apx would open it, and the command that runs the helper on it.
  const copy = join(proj, '.agent-pack', 'work', 'manual');
  write(join(copy, 'README.md'), ['# copy']);
  write(join(proj, '.agent-pack', 'work', 'manual.prompt.md'), ['help']);
  const delegate = `node ${CLIENT} --server helper --project ${copy} --prompt ${copy}.prompt.md --answer ${copy}.answer.txt`;
  const pidFile = join(proj, 'child.pid');
  const apx = `node ${join(proj, '.agent-pack', 'apx', 'site.apx')}`;

  // --- a chat: the boss streams, a tool call, a permission, a delegation, a flow's session ---
  const c = chat();
  let at = await c.until('> ');
  const events = c.out.match(/events: (\S+\.jsonl)/)[1];
  assert.ok(events.startsWith(join(proj, '.agent-pack', 'chats')), events);
  // An empty room: @all has no one to reach.
  c.type('@all anyone?');
  at = await c.until('@all: no one is in the room but the boss — bring someone in with /invite', at);
  c.type(`say hello there ${SECRET}`);
  at = await c.until(`hello there ***`, at);
  c.type('tool Read README.md');
  at = await c.until('• Read README.md — completed\n', at);
  c.type(`ask ${join(proj, 'src', 'a.ts')}`);
  at = await c.until(`? boss asks to Edit ${join(proj, 'src', 'a.ts')} — allow [o]nce or [r]eject: `, at);
  c.type('o');
  at = await c.until(`• allowed: Edit ${join(proj, 'src', 'a.ts')}: you allowed it once\n`, at);
  at = await c.until('permission: yes', at);
  c.type('ask /etc/passwd');
  at = await c.until('allow [o]nce or [r]eject: ', at);
  c.type('r');
  at = await c.until('• refused: Edit /etc/passwd: you rejected it\n', at);
  at = await c.until('permission: no', at);
  // The boss's first prompt opened with the preamble: every other ACP harness, and agent-pack ask — the second did not.
  const prompts = readFileSync(PROMPTS, 'utf-8').trimEnd().split('\n').map(l => JSON.parse(l));
  const agentPack = `node ${realpathSync(CLI)}`;
  has(prompts[0], 'own, helper', `${agentPack} ask <harness> "<task>"`, "Never run a harness's own CLI", `say hello there ${SECRET}`);
  assert.ok(!prompts[0].split('\n')[0].includes('boss,') && !/harness: .*\bboss\b/.test(prompts[0]), 'the boss is not listed among those it may consult');
  assert.ok(!prompts[1].includes('[agent-pack]'), 'only the first prompt opens with it');
  assert.ok(prompts[0].endsWith(`say hello there ${SECRET}`));

  // A delegation through agent-pack ask: the boss's tool line, the helper's events under its name, its answer back to the boss.
  c.type(`run ${agentPack} ask helper "help" ;; say asked`);
  at = await c.until('asked', at);
  const asked = c.out.slice(c.out.lastIndexOf('• allowed: Edit inside'));
  has(asked, '    [helper] • refused: Edit outside: it touches /etc/passwd, outside the copy', `• Run ${agentPack} ask helper "help" — completed`, 'ok.');
  assert.ok(asked.indexOf('[helper]') < asked.indexOf('• Run '), 'the helper\'s lines come before the tool line that ran it settles');
  at = await c.until('> ', at);

  // A delegation, in a turn: the helper's lines between the boss's, in order, indented under [helper].
  c.type(`say before the delegation ;; run ${delegate} ;; say after the delegation`);
  at = await c.until('after the delegation', at);
  const turn = c.out.slice(c.out.lastIndexOf('before the delegation'));
  const helperLines = turn.split('\n').filter(l => l.includes('[helper]'));
  assert.ok(helperLines.length >= 3, turn);
  assert.ok(helperLines.every(l => l.startsWith('    [helper] ')), `indented, prefixed:\n${turn}`);
  has(turn, '    [helper] • refused: Edit outside: it touches /etc/passwd, outside the copy', '    [helper] ok.');
  assert.ok(turn.indexOf('[helper]') > turn.indexOf('before the delegation') && turn.lastIndexOf('[helper]') < turn.indexOf('after the delegation'), `in order:\n${turn}`);
  assert.ok(!turn.includes('? helper asks'), 'a delegated permission is never asked');
  assert.equal(readFileSync(`${copy}.answer.txt`, 'utf-8'), 'ok.\n', 'the delegation ran as ever');
  assert.ok(!c.out.includes('hidden thoughts') && !c.out.includes('hidden plan'), 'thoughts and plans hidden');

  // The group: the helper joined once, however often it ran; /remove is local, takes it off, and never blocks it — it joins again when it speaks.
  assert.equal(c.out.split('--> helper (fake-big) joined').length - 1, 1, 'one join for the helper so far');
  c.type('/remove boss');
  at = await c.until('/remove: `boss` is a member from the start', at);
  c.type('/remove nobody');
  at = await c.until('/remove: `nobody` is no participant of this chat — the participants: helper', at);
  c.type('/remove helper');
  at = await c.until('<-- helper removed', at);
  c.type(`run ${delegate} --agent reviewer ;; run ${agentPack} ask helper "again" ;; say back`);
  at = await c.until('back', at);
  has(c.out.slice(c.out.lastIndexOf('<-- helper removed')), '--> helper:reviewer (fake-big) joined', '    [helper:reviewer] ok.', '--> helper (fake-big) joined');
  at = await c.until('> ', at);

  // A flow's session: the apx reads the chat's id, under the acp servers' declared name.
  c.type(`run printenv AGENT_PACK_SESSION_ID ;; run printf 'from the chat' | ${apx} set notes - ;; run ${apx} get notes`);
  at = await c.until('from the chat', at);
  const chatId = c.out.slice(at - 200, at).match(/(chat-[0-9TZ-]+-[0-9a-f]{6})/)?.[1];
  assert.ok(chatId, `the chat's session id:\n${c.out.slice(at - 300, at)}`);
  assert.ok(!c.out.slice(at - 300, at).includes('is not set'), 'the apx found its session id');
  at = await c.until('> ', at);

  // The room: /invite lists, validates and brings in; @name sends to one, as that agent; @all to the room, then one recap by the boss.
  c.type('/invite');
  at = await c.until('/invite <harness> or <harness>:<agent> — the harnesses: own, helper, broken; the agents: lead, quick, writer', at);
  c.type('/invite nobody');
  at = await c.until('/invite: `nobody` is no harness or agent of this project', at);
  c.type('/invite helper:nobody');
  at = await c.until('/invite: `helper:nobody` is no harness or agent of this project', at);
  c.type('/invite helper:lead');
  at = await c.until('--> helper:lead joined', at);
  c.type('/invite helper:lead');
  at = await c.until('/invite: `helper:lead` is in the room already', at);
  c.type('/invite broken');
  at = await c.until('--> broken joined', at);
  c.type('@ghost hi');
  at = await c.until('@ghost: no one of that name is in the room', at);
  c.type('@helper:lead hello lead');
  at = await c.until('[helper:lead] ok.', at);
  const asLead = lastPrompt(HELPER_PROMPTS);
  assert.ok(asLead.startsWith('# Who you are — the definition of the agent `lead`') && asLead.endsWith('hello lead'), asLead);
  at = await c.until('> ', at);
  c.type('/remove helper:reviewer');
  at = await c.until('<-- helper:reviewer removed', at);
  const sentBefore = readFileSync(HELPER_PROMPTS, 'utf-8').trimEnd().split('\n').length;
  c.type('@all compare notes');
  at = await c.until('all answered — the boss is asked for a recap', at);
  at = await c.until('> ', at);
  const fanned = readFileSync(HELPER_PROMPTS, 'utf-8').trimEnd().split('\n').slice(sentBefore).map(l => JSON.parse(l));
  assert.equal(fanned.length, 2, `helper and helper:lead, not the removed helper:reviewer: ${JSON.stringify(fanned)}`);
  has(c.out, 'broken failed — the turn ended without an answer: stopReason refusal');
  const recap = lastPrompt(PROMPTS);
  has(recap, 'The user asked everyone in the room: compare notes', '— helper:\nok.', '— helper:lead:\nok.', '— broken (failed): the turn ended without an answer: stopReason refusal', 'where they agree, where they differ');
  assert.ok(!recap.includes('helper:reviewer') && !recap.includes('boss:'), 'only the room, not the removed, not the boss');
  const prompts2 = readFileSync(PROMPTS, 'utf-8').trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(prompts2.filter(p => p.includes('The user asked everyone in the room')).length, 1, 'exactly one recap prompt');
  // A participant is named by its pseudonym too.
  const helperName = pseudonymOf({ id: 'helper', model: 'fake-big' });
  c.type(`@${helperName} by your pseudonym`);
  at = await c.until('> ', await c.until('[helper] ok.', at));
  assert.ok(lastPrompt(HELPER_PROMPTS).endsWith('by your pseudonym'));
  // agent-pack ask <harness>:<agent>, from the command line: the same prompt head.
  r = run([CLI, 'ask', 'helper:writer', 'from the cli']);
  assert.equal(r.code, 0, r.out);
  assert.ok(lastPrompt(HELPER_PROMPTS).startsWith('# Who you are — the definition of the agent `writer`'), lastPrompt(HELPER_PROMPTS));

  // The boss becomes an agent by reading its apx: its next lines are `<boss>:<agent>`'s, a participant that joins.
  const before = c.out.length;
  c.type(`run ${apx} lead start > /dev/null ;; say speaking as lead`);
  at = await c.until('speaking as lead', at);
  has(c.out.slice(before), '--> boss:lead (fake-big) joined', '[boss:lead] speaking as lead');
  at = await c.until('> ', at);

  // Ctrl-C in a turn: session/cancel, the turn ends cancelled, the prompt comes back.
  c.type(`spawn-child ${pidFile} ;; wait`);
  await sleep(300);
  c.child.kill('SIGINT');
  at = await c.until('(turn cancelled)\n', at);
  at = await c.until('> ', at);
  c.type('say still here');
  at = await c.until('still here', at);
  const pid = Number(readFileSync(pidFile, 'utf-8'));
  assert.ok(alive(pid), 'the boss\'s child runs until the chat ends');

  // Ctrl-D: the chat ends, the boss and its children stopped, the events complete.
  await c.until('> ', at);
  c.child.stdin.end();
  assert.equal(await c.exited, 0);
  await sleep(200);
  assert.ok(!alive(pid), 'the boss\'s child is stopped with it');
  console.log('chat: a chat passed.');

  assert.ok(!c.out.includes('invite a harness or an agent'), 'the inline front shows no menu');
  // --- the events file: the generic shape, no escape codes, env values masked ---
  const text = readFileSync(events, 'utf-8');
  assert.ok(text.endsWith('\n'), 'every line complete');
  const all = text.trimEnd().split('\n').map(l => JSON.parse(l));
  for (const e of all) {
    assert.deepEqual(Object.keys(e).sort(), ['id', 'kind', 'source', 'status', 'text', 'time'], JSON.stringify(e));
    assert.ok(['text', 'tool-start', 'tool', 'verdict', 'user', 'turn', 'notice', 'join', 'leave', 'model', 'usage', 'identity'].includes(e.kind), e.kind);
  }
  assert.ok(!text.includes(SECRET), 'env values masked');
  assert.ok(!text.includes('\u001b'), 'no escape codes');
  const count = (kind, source) => all.filter(e => e.kind === kind && e.source === source).length;
  assert.deepEqual([count('join', 'helper'), count('leave', 'helper'), count('join', 'helper:reviewer')], [2, 1, 1], 'the group, as the log replays it');
  assert.ok(all.filter(e => e.kind === 'join' && e.source === 'helper').every(e => e.text === pseudonymOf({ id: 'helper', model: 'fake-big' })), 'each join records the pseudonym');
  // What the agents report, as the log keeps it: each one's model, each turn's usage.
  assert.ok(all.some(e => e.kind === 'model' && e.source === 'boss' && e.text === 'fake-big'), 'the boss\'s model, at the start');
  assert.ok(all.some(e => e.kind === 'model' && e.source === 'helper' && e.text === 'fake-big'), 'a delegation\'s model');
  const used = all.filter(e => e.kind === 'usage' && e.source === 'helper').map(e => JSON.parse(e.text));
  assert.ok(used.length > 0 && used.every(u => u.total === 1500 && u.input === 1000 && u.output === 500 && u.cost === 0.25), JSON.stringify(used));
  assert.ok(!all.some(e => e.kind === 'user' && e.text.startsWith('/remove')), '/remove is never sent to the boss');
  const users = all.filter(e => e.kind === 'user');
  assert.equal(users[0].text, `say hello there ***`, 'the log holds the line typed, not the preamble');
  assert.ok(!users.some(e => e.text.includes('[agent-pack]')));
  assert.equal(all.filter(e => e.kind === 'notice' && e.text.startsWith('the boss was told it may consult: own, helper')).length, 1, 'the preamble, one notice');
  assert.ok(all.some(e => e.source === 'helper' && e.kind === 'text' && e.text === 'ok.'), 'the helper\'s session/update events, tagged');
  assert.ok(all.some(e => e.source === 'helper' && e.kind === 'verdict' && e.status === 'refused'), 'the helper\'s verdicts, tagged');
  assert.ok(all.some(e => e.source === 'boss' && e.kind === 'turn' && e.status === 'cancelled'));
  // The fake streams each `say` in two chunks: its first three letters, then the rest.
  const said = (e, text) => e.source === 'boss' && e.kind === 'text' && e.text.includes(text);
  const beforeAt = all.findIndex(e => said(e, 'ore the delegation'));
  const helperAt = all.findIndex((e, k) => k > beforeAt && e.source === 'helper');
  const order = all.map(e => `${e.source}:${e.kind}:${e.text}`).join('\n');
  assert.ok(beforeAt >= 0 && helperAt > beforeAt && helperAt < all.findIndex(e => said(e, 'er the delegation')), `in the order they arrived:\n${order}`);

  // Escape codes the boss sends are stripped from the events, not from the terminal's own rendering only.
  const d = chat();
  at = await d.until('> ');
  d.type('color in red');
  at = await d.until('in red', at);
  await d.until('> ', at);
  // Ctrl-C at an empty prompt: the chat ends.
  d.child.kill('SIGINT');
  assert.equal(await d.exited, 0);
  const second = readFileSync(d.out.match(/events: (\S+\.jsonl)/)[1], 'utf-8');
  assert.ok(second.includes('in red') && !second.includes('\u001b'), second);
  console.log('chat: Ctrl-C at an empty prompt passed.');

  // The boss's own session id, when it has one: its commands see it, not the chat's.
  config("{ boss: 'own' }");
  const o = chat();
  at = await o.until('> ');
  o.type(`run printenv AGENT_PACK_SESSION_ID ;; run printf 'from its own' | ${apx} set notes - ;; run ${apx} get notes`);
  at = await o.until('from its own', at);
  o.child.stdin.end();
  assert.equal(await o.exited, 0);
  // Its id is a plain env value of its server, so readable — and the session it stored under is the one it says.
  has(o.out, 'own-session-1');
  const getIn = id => spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'site.apx'), 'get', 'notes'], { cwd: proj, env: { ...env, AGENT_PACK_SESSION_ID: id }, encoding: 'utf-8' }).stdout;
  has(getIn('own-session-1'), 'from its own');
  has(getIn(chatId), 'from the chat');
  assert.ok(!getIn(chatId).includes('from its own'), 'each chat its own session');
  console.log('chat: the session id passed.');

  // --- the client without a chat: nothing written, the same output ---
  const plain = spawnSync(process.execPath, [CLIENT, '--server', 'helper', '--project', copy, '--prompt', `${copy}.prompt.md`, '--answer', `${copy}.answer.txt`], { cwd: proj, env, encoding: 'utf-8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, '');
  assert.equal(plain.stderr, 'acp helper: refused permission for Edit outside: it touches /etc/passwd, outside the copy\n'
    + 'acp helper: refused permission for Edit via ..: it touches ' + `${copy}/../../escape.txt, outside the copy\n`
    + 'acp helper: refused fs/read_text_file /etc/hostname: it is outside the copy\n'
    + 'acp helper: refused terminal/create: terminals are not enabled for helper — its server entry enables them with terminal: true\n');
  console.log('chat: the client without a chat passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
  rmSync(proj0, { recursive: true, force: true });
}
