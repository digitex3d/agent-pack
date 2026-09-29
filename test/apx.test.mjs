// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx engine — the behaviour an agent relies on, driven the way a harness
 * drives it: `node <exe> <verb>`, lines out, an exit code back. Ported from
 * the Go engine's tests (apc/) as the specification of the TypeScript one.
 *
 * The fixture (test/fixtures/apx) is one team member holding every kind: a
 * policy, a role, a template, a procedure, a WHEN workflow, a store, the
 * team with its routing and flow, and a fellow member defined elsewhere.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { bundleAgentObject } from '../dist/src/compiler/index.js';
import { ApDocument } from '../dist/src/apdoc/document.js';
import { ApxEngine } from '../dist/src/apx/engine.js';
import { renderMd } from '../dist/adapters/md/index.js';
import { FORMULAS } from '../dist/src/formulas.js';
import { apxFiles } from '../dist/src/apx/write.js';
import { apxPath, FLOWS_DIR, flowScriptFile } from '../dist/src/apx/paths.js';
import { compileWorkflow } from '../dist/adapters/claude-code/workflow.js';
import { buildOrchestrationContent } from '../dist/src/orchestrationSection.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/apx');
const library = join(FIXTURE, 'library');
const compiled = await bundleAgentObject({
  agentName: 'pm',
  agentFile: join(FIXTURE, 'teams/product/pm.ap'),
  agentDir: join(FIXTURE, 'teams/product'),
  libraryRoot: library,
  libraryRoots: [library],
  libraries: { '@main': library },
});
// The apx carries the document as JSON: every run starts from the round trip.
const doc = ApDocument.fromJson(compiled.structure.asJson());
const BUILD = { builtAt: '2026-09-24T10:00:00Z', agentPackVersion: '0.26.0', hash: 'c0ffee' };

/** Run one invocation of an engine over `document`, called as `exe`; returns { out, code }. */
function drive({ document = doc, exe = EXE, budget } = {}, ...args) {
  const lines = [];
  const code = new ApxEngine(document, BUILD, exe, l => lines.push(l), budget).run(args);
  return { out: lines.join('\n'), code };
}
// budget 0: every block is read on demand — the quiz, scope and get paths under test
const apx = (exe, ...args) => drive({ exe, budget: { whole: 0, block: 0 } }, ...args);
const EXE = 'apx/pm.apx';
const CMD = `node ${EXE}`;
const run = (...args) => apx(EXE, ...args);
const idOf = (kind, name) => doc.all().find(b => b.kind === kind && b.name === name).id;
function has(out, ...needles) {
  for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`);
}

// --- start: the agent's line and the quiz of the kinds it holds, nothing else ---
{
  const { out, code } = run();
  assert.equal(code, 0);
  has(out, '# agent pm — product manager', `# quiz — answer with: ${CMD} start 1=<a|b|c>`);
  const kinds = [...out.matchAll(/^\d+\. \[(\w+)\]/gm)].map(m => m[1]);
  // role, policy and the answer template open with the agent: no question on them
  assert.deepEqual([...new Set(kinds)], ['agent', 'team', 'procedure', 'flow', 'store'],
    'one question group per kind read on demand, in reading order');
  assert.ok(!out.includes('you:'), 'bare start never prints the scope before the quiz');
  assert.equal(run('start').out, out, 'no verb = start');
}

// --- the quiz is graded: all right → the scope; a miss → that kind's introduction, then the scope ---
const quiz = ['agent', 'team', 'procedure', 'flow', 'store']
  .flatMap(kind => FORMULAS.blocks[kind].quiz.map(q => ({ kind, right: q.right })));
const answers = quiz.map((q, i) => `${i + 1}=${q.right}`);
{
  const { out, code } = run('start', ...answers);
  assert.equal(code, 0);
  has(out, `# all ${quiz.length} correct — your scope:`, 'you:  agent pm');
  assert.ok(!/^## (agent|team|procedure|flow|store)$/m.test(out), 'no introduction on a perfect quiz');
}
{
  const flow = quiz.findIndex(q => q.kind === 'flow');
  const store = quiz.findIndex(q => q.kind === 'store');
  const wrong = answers.map((a, i) => (i === flow ? `${i + 1}=?` : a)).filter((_, i) => i !== store);
  const { out } = run('start', ...wrong);
  has(out, '# missed: flow, store', '## flow', '## store', 'You must not touch a store\'s files directly', 'you:  agent pm');
  assert.ok(!/^## procedure$/m.test(out), 'only the missed kinds are introduced');
}
{
  const { out, code } = run('start', '99=a');
  assert.equal(code, 2);
  has(out, '# error: bad answer', `n in 1..${quiz.length}`, `${CMD} start`);
}

// --- scope: everything needed to start, every reference with the command that prints it ---
{
  const { out } = run('scope');
  has(out,
    `you:  agent pm  [${CMD} get ${idOf('agent', 'pm')}]`,
    'mandate: decompose requests into a plan',
    `when:  — the steps: ${CMD} get ${idOf('agent', 'pm')}`,
    `role: role planner  [${CMD} get ${idOf('role', 'planner')}]`,
    `team: team product  [${CMD} get ${idOf('team', 'product')}]  — the product team`,
    `  WHEN asked to evaluate an idea  -> flow shape-idea  [${CMD} flow ${idOf('flow', 'shape-idea')}]`,
    `  policy board-rules  [${CMD} get ${idOf('policy', 'board-rules')}]  — how the board is kept`,
    `  WHEN a new feature is requested  -> procedure open-card  [${CMD} get ${idOf('procedure', 'open-card')}]`,
    `  store notes  [${CMD} get ${idOf('store', 'notes')}]  — use: ${CMD} notes <verb> …`,
    `answer as: template plan  [${CMD} get ${idOf('template', 'plan')}]`,
    `— list them: ${CMD} ls`);
}

// --- a store write outside its schema is refused before it reaches the table ---
{
  const refused = (args, why) => { const r = run('notes', ...args); assert.equal(r.code, 2, r.out); has(r.out, why, 'nothing was written'); };
  refused(['a', 'note=no topic'], 'topic: required field missing');
  refused(['a', 'topic=two words', 'note=x'], 'topic: expected ≤1 words, got 2');
  refused(['a', 'topic=iban', 'note=x', 'iban=IT60X0542811101000000123456'], 'iban: unknown field');
  refused(['s', '1', 'colour=red'], 'colour: unknown field');
}

// --- the reading budget: small definitions print whole, larger ones open what is always needed ---
{
  const budgeted = (budget, ...args) => drive({ budget }, ...args);
  const whole = budgeted(undefined, 'start');
  has(whole.out, '# your whole definition — small enough to read at once', '# Identity');
  assert.ok(!whole.out.includes('# quiz'), 'a small definition needs no quiz');
  // above the whole budget: the role, the policies and the answer template open with the agent
  const open = budgeted({ whole: 0, block: 0 }, 'start');
  assert.ok(!/\[policy\]|\[role\]/.test(open.out), 'no quiz on what opens with the agent');
  const graded = budgeted({ whole: 0, block: 0 }, 'start', ...open.out.split('\n').filter(l => /^\d+\. /.test(l)).map((_, i) => `${i + 1}=?`));
  has(graded.out, '# opened for you', '# Identity', '`board-rules`', '`plan`');
  assert.ok(!graded.out.includes('Create the card in the Backlog'), 'a large, conditional block stays a get');
}

// --- every command the engine prints runs as printed ---
{
  const printed = ['scope', 'ls'].map(v => run(v).out).join('\n');
  const ids = [...printed.matchAll(new RegExp(`\\[${CMD} get (\\S+)\\]`, 'g'))].map(m => m[1]);
  assert.ok(ids.length >= 7, 'scope and ls print get commands');
  for (const id of ids) assert.equal(run('get', id).code, 0, `get ${id} runs`);
}

// --- ls: grouped by kind, filtered, counted ---
{
  const { out } = run('ls', 'kind=policy', 'count');
  assert.equal(out, 'policy (1)\n# 1 block');
  has(run('ls', 'tag=board').out, 'policy (1)', 'template (1)', `${idOf('template', 'plan')}  plan  #board  — the routing plan`);
  assert.equal(run('ls', 'tag=#board').out, run('ls', 'tag=board').out, 'a tag filters the same written as in the source');
  has(run('ls', 'name~zzz').out, '# 0 blocks match');
  const bad = run('ls', 'color=red');
  assert.equal(bad.code, 2);
  has(bad.out, '# error: bad filter', `${CMD} ls kind=`);
}

// --- get: the block's text, then its footer and links ---
{
  const tpl = idOf('template', 'plan');
  const { out } = run('get', tpl);
  has(out, '# `plan` — the routing plan', 'Produce **plan** by filling this layout',
    `# template plan  ${tpl}`, '#board', 'uses:', 'used by:',
    `  agent pm  [${CMD} get ${idOf('agent', 'pm')}]`,
    `  procedure open-card  [${CMD} get ${idOf('procedure', 'open-card')}]`);
  has(run('get', idOf('procedure', 'open-card')).out, `Shape your response as \`plan\` [${CMD} get ${tpl}]`);
  assert.equal(JSON.parse(run('get', tpl, 'json').out).id, tpl, 'get <id> json is the raw block');
}
{
  // the agent's own definition is never trimmed: team, identity, own rules — not the chapters
  const { out } = run('get', idOf('agent', 'pm'));
  has(out, '# Your team', '· scout — evaluates ideas', '# Identity', 'Your mandate: decompose requests into a plan',
    `Run the procedure \`open-card\` [${CMD} get ${idOf('procedure', 'open-card')}]`);
  assert.ok(!out.includes('# Templates'), 'get <agent> is the definition, not the whole prompt');
}
{
  // a fellow member lives in its own executable, beside this one
  has(run('get', idOf('team', 'product')).out, 'members:', 'agent scout  [node apx/scout.apx scope]', 'routing:');
  has(run('refs', idOf('flow', 'shape-idea')).out, 'uses:', 'agent scout  [node apx/scout.apx scope]', 'used by:');
  // the policies it imports bind the agent: refs says so, both ways
  has(run('refs', idOf('agent', 'pm')).out, `policy board-rules  [${CMD} get ${idOf('policy', 'board-rules')}]`);
  has(run('refs', idOf('policy', 'board-rules')).out, 'used by:', `agent pm  [${CMD} get ${idOf('agent', 'pm')}]`);
  const scout = doc.byKind('team')[0].members.find(m => m.target.endsWith('/scout'));
  const { out, code } = run('get', scout.id);
  assert.equal(code, 1);
  has(out, 'defined in its own executable', 'node apx/scout.apx scope');
}

// --- find: the matching blocks, each with the lines that matched ---
{
  const { out } = run('find', 'backlog');
  has(out, `${idOf('procedure', 'open-card')}  open-card`, '  > Do create the card in the Backlog list', '# 1 block');
}

// --- md: the whole prompt, the same text the harness .md carries ---
assert.equal(run('md').out + '\n', renderMd(doc), 'md is the md projection');
assert.equal(renderMd(doc), compiled.body, 'the round-tripped document renders the md the compiler wrote');

// --- version and help ---
has(run('version').out, `# pm  ${idOf('agent', 'pm')}`, 'built 2026-09-24T10:00:00Z by agent-pack 0.26.0  hash c0ffee');
has(run('help').out, `${CMD} start`, `${CMD} get <id> [json]`, `${CMD} <store> <verb> …`);

// --- errors: one line, the command that fixes it, exit 1 (missing) or 2 (usage) ---
{
  let r = run('get', 'nope');
  assert.equal(r.code, 1);
  assert.equal(r.out, `# error: no block with id 'nope' — list them: ${CMD} ls`);
  r = run('get');
  assert.equal(r.code, 2);
  has(r.out, `# error: get needs a block id — example: ${CMD} get ${idOf('agent', 'pm')}`);
  r = run('bogus');
  assert.equal(r.code, 2);
  assert.equal(r.out, `# error: unknown verb 'bogus' — the verbs: ${CMD} help`);
  assert.equal(run('find').code, 2);
}

// --- stores: served through the engine, backed by tabeli beside the file ---
const ensure = spawnSync(join(homedir(), '.claude/skills/tabeli/scripts/ensure-engine.sh'), { encoding: 'utf-8' });
if (ensure.status !== 0 && !process.env.APX_TABELI) {
  console.log('apx store tests skipped (tabeli engine not available).');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'apx-store-'));
  try {
    const exe = join(tmp, '.agent-pack', 'apx', 'pm.apx');   // where bundle all puts it: the project root is two levels up
    const cmd = `node ${exe}`;
    has(apx(exe, 'get', idOf('store', 'notes')).out, `${cmd} notes a topic='…' note='…'`);
    has(apx(exe, 'notes', 'a', 'topic=tabeli', 'note=engine lives in the skill dir').out, 'id=1 topic=tabeli');
    has(apx(exe, 'notes', 'a', 'topic=tabeli', 'note=a C binary').out,
      '# topic=tabeli exists as id=1 — updated, not duplicated', "note='a C binary'");
    assert.equal(apx(exe, 'notes', 'q', 'count').out.trim(), '# 1 record');
    const bad = apx(exe, 'notes', 'nope');
    assert.equal(bad.code, 2);
    has(bad.out, "unknown command 'nope'");
    assert.ok(!bad.out.includes('notes.tbl'), 'the table file is never named — the engine speaks for it');
    console.log('apx store tests passed.');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// --- the .apx file: engine + data in one file, run by Node alone, from the project root ---
for (const compress of [false, true]) {
  const project = mkdtempSync(join(tmpdir(), 'apx-file-'));
  try {
    // a project whose own package.json is ESM — the apx must still run
    writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n');
    for (const f of apxFiles('pm', compiled.structure.asJson(), project, compress)) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    const text = readFileSync(join(project, apxPath('pm')), 'utf-8');
    assert.ok(text.trimEnd().split('\n').pop().startsWith(compress ? '//apx:gzip:' : '//apx:json:'), 'the data line closes the file');
    const node = (...args) => spawnSync('node', [apxPath('pm'), ...args], { cwd: project, encoding: 'utf-8' });
    const scope = node('scope');
    assert.equal(scope.status, 0, scope.stderr);
    has(scope.stdout, `you:  agent pm  [node ${apxPath('pm')} get ${idOf('agent', 'pm')}]`);
    has(node('version').stdout, `# pm  ${idOf('agent', 'pm')}`, 'by agent-pack');
    assert.equal(node('get', 'nope').status, 1);
    assert.equal(node('md').stdout, renderMd(doc), 'the file renders the same md');
    const early = spawnSync('sh', ['-c', `node ${apxPath('pm')} md | head -1`], { cwd: project, encoding: 'utf-8' });
    assert.ok(!early.stderr.includes('EPIPE'), 'a reader that stops early is not an error');
  } finally {
    rmSync(project, { recursive: true });
  }
}
console.log('apx file tests passed.');

// --- flow: the harness's compiled script for this version of the flow, or the steps to carry out ---
{
  const flowId = idOf('flow', 'shape-idea');
  const steps = run('flow', flowId);
  assert.equal(steps.code, 0);
  has(steps.out, '# flow shape-idea — carry out its steps in order:', 'score the idea');
  assert.equal(run('flow', idOf('template', 'plan')).code, 2, 'only a flow runs as a flow');
  assert.equal(run('flow', 'nope').code, 1);

  // An adapter that runs flows as scripts: its rendering in the document, the script beside the apx.
  const data = JSON.parse(doc.asJson());
  data.meta.flowRun = 'script {script} | steps {steps}';
  const scripted = ApDocument.fromJson(JSON.stringify(data));
  const project = mkdtempSync(join(tmpdir(), 'apx-flow-'));
  try {
    const exe = join(project, apxPath('pm'));
    const flow = scripted.all().find(b => b.id === flowId);
    const flows = join(project, FLOWS_DIR);
    mkdirSync(flows, { recursive: true });
    const flowOf = () => drive({ document: scripted, exe }, 'flow', flowId);
    writeFileSync(join(flows, flowScriptFile(flowId, 'sha256:00000000', 'js')), '// an older version of the flow\n');
    has(flowOf().out, '# flow shape-idea — carry out its steps in order:');
    const script = join(flows, flowScriptFile(flowId, flow.contentHash, 'js'));
    writeFileSync(script, '// this version\n');
    assert.equal(flowOf().out, `script ${script} | steps node ${exe} get ${flowId}`);
  } finally {
    rmSync(project, { recursive: true });
  }
}

// --- the claude-code Workflow script of a flow: steps as agents, the next step's input shape as schema ---
{
  const plan = doc.byKind('template')[0];
  const scout = doc.byKind('flow')[0].body[0].by;
  const step = (title, context, shape) => ({ type: 'step', title, by: scout, context, shape, chars: 0,
    body: [{ type: 'directive', keyword: 'DO', force: null, text: `do ${title}`, chars: 0, indent: 8 }] });
  const planShape = { force: 2, ref: { id: plan.id, target: plan.address, kind: 'template' } };
  const flow = { name: 'plan-it', id: 'flw-00000000', about: null, body: [
    step('draft', null, null),
    { type: 'parallel', chars: 0, steps: [step('check a', 'isolated', null), step('check b', 'summary', null)] },
    step('frame', 'full', null),
    step('plan', 'full', planShape),
  ] };
  const script = compileWorkflow(flow, doc);
  has(script,
    'export const meta = {"name":"plan-it"',
    'agentType: "scout"',
    'await parallel([',
    'upstream("isolated")', 'upstream("summary")',
    'Step \\"draft\\" of flow `plan-it`.\\nDo do draft',
    `Shape your response to match exactly: \`plan\` (${plan.id})`,
    `schema: ${JSON.stringify({ type: 'object', properties: { request: { type: 'string', description: '≤25 words' } }, required: ['request'], additionalProperties: false })}`,
    'return results');
  assert.equal(script.match(/schema:/g).length, 1, 'only the step that hands over a shaped input is bound');
  // Run it as the Workflow tool does — the body in an async function, the hooks stubbed.
  const AsyncFunction = (async () => {}).constructor;
  const calls = [];
  const agent = async (prompt, opts) => { calls.push({ prompt, opts }); return opts.schema ? { request: 'a plan' } : `${opts.phase} done`; };
  const results = await new AsyncFunction('args', 'agent', 'parallel', 'phase', script.replace(/^export /, ''))(
    { request: 'the ask' }, agent, thunks => Promise.all(thunks.map(t => t())), () => {});
  assert.deepEqual(results.map(r => [r.step, r.result]), [
    ['draft', 'draft done'], ['check a', 'check a done'], ['check b', 'check b done'], ['frame', { request: 'a plan' }], ['plan', 'plan done']]);
  assert.ok(calls.every(c => c.prompt.startsWith('Request: the ask')), 'every step carries the request');
  assert.ok(!calls.find(c => c.opts.phase === 'check a').prompt.includes('Upstream context'), 'isolated: no upstream');
  has(calls.find(c => c.opts.phase === 'check b').prompt, 'digest', '"draft done"');
  has(calls.find(c => c.opts.phase === 'plan').prompt, 'this step passes the full upstream context', '"a plan"');
  assert.ok(script.indexOf('schema:') < script.indexOf('phase("plan")'), 'the schema binds the producing step');
  assert.equal(compileWorkflow({ ...flow, body: [{ ...step('x', null, null), by: { ...scout, kind: 'team' } }] }, doc), null,
    'a step run by a team is carried out as written');
  assert.equal(compileWorkflow({ ...flow, body: [step('x', 'inherited', null)] }, doc), null,
    'a fork of the caller has no counterpart in a script');
  assert.equal(compileWorkflow({ ...flow, body: [{ type: 'text', raw: 'x', chars: 1 }] }, doc), null,
    'anything but steps is carried out as written');
}
// --- AGENTS.md routes a flow through a member's apx, which says how this harness runs it ---
{
  const { content } = await buildOrchestrationContent({
    cwd: FIXTURE, standaloneAgentsDir: join(FIXTURE, 'standalone'), teamsDir: join(FIXTURE, 'teams'),
    libraryRoots: [library], libraries: { '@main': library },
  });
  const id = idOf('flow', 'shape-idea');
  has(content, `Run the flow \`shape-idea\` (${id}) — start with \`node ${apxPath('pm')} flow ${id}\`: it says how`);
}
console.log('apx flow tests passed.');

console.log('apx engine tests passed.');
