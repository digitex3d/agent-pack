// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The contracts strategy — the apx side (D44): a real project, the real
 * `bundle all`, the agents' real apx run as processes in one session.
 *
 *   - start / new / dispatch / deliver / block / merge / get / list, each by the
 *     agent whose it is; ids, rotation over a BY, the freeze while work runs
 *   - dispatch: a zone in one file, two marks in order; one assignee per file;
 *     the file's domain is the contract's (kept across the lead's edits)
 *   - deliver: the marks gone, nothing written outside the zone (a changed or a
 *     new file of the perimeter); a transition is a compare-and-swap (exit 4)
 *   - merge: after every instance it depends on
 */

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { STATE_DIR } = await import('../dist/src/apx/paths.js');
const { queryTable, runTable } = await import('../dist/src/apx/tabeli.js');

const proj = mkdtempSync(join(tmpdir(), 'ap-contracts-apx-'));
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, (Array.isArray(lines) ? lines.join('\n') : lines) + '\n'); return file; };

// A judge that never hesitates, in the config file: a file mentioning a table is of persistence, any other of api.
write(join(proj, 'agent-pack.config.mjs'), [
  'export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],",
  "  judge: { adapter: { type: 'judge', name: 'fake', async ask(state, checks) {",
  "    const q = checks[0]; const persistence = /table/.test(state);",
  "    return { model: 'fake-1', answers: { [q.id]: q.options ? { api: persistence ? 0.05 : 0.95, persistence: persistence ? 0.95 : 0.05 } : 1 } };",
  '  } } },', '};',
]);
write(join(proj, 'library', 'templates', 'spec.ap'), ['EXPORT TEMPLATE spec:', '    ABOUT  a spec', '    SLOTS:', '        goal: TEXT  "what the zone does"', '    BODY:', '        {goal}']);
write(join(proj, 'library', 'templates', 'request.ap'), ['EXPORT TEMPLATE request:', '    ABOUT  a request', '    SLOTS:', '        request: TEXT  "the request"', '    BODY:', '        {request}']);
write(join(proj, 'library', 'templates', 'file-domain.ap'), ['EXPORT TEMPLATE file-domain:', '    ABOUT  the domain of a file', '    SLOTS:', '        domain: ENUM[api persistence]  "the one domain of the file"', '    BODY:', '        {domain}']);
write(join(proj, 'library', 'dimensions', 'domains.ap'), ['IMPORT file-domain FROM @main.templates', '', 'EXPORT DIMENSION domains:', '    ABOUT   the domain of each source file', '    FOR     src/**', '    EACH    file', '    AS      file-domain']);
const team = join(proj, 'agents', 'teams', 'backend');
const agent = (name, lines, imports = []) => write(join(team, `${name}.ap`), [...imports, ...(imports.length ? [''] : []),
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', ...lines, '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work']);
agent('architect', ['    WHEN handed change:', '        DO  write the skeletons, hand the zones out'], ['IMPORT domains FROM @main.dimensions']);
agent('api-dev', ['    WHEN handed endpoint:', '        DO  implement the zone']);
agent('api-dev-2', ['    WHEN handed endpoint:', '        DO  implement the zone']);
agent('db-dev', ['    WHEN handed repository:', '        DO  implement the zone']);
write(join(team, 'backend.ap'), ['IMPORT spec FROM @main.templates', '', 'EXPORT TEAM backend:', '    ABOUT     builds a backend change by contracts',
  '    STRATEGY  contracts', '    LEAD      architect', '    DOMAINS   domains',
  '    CONTRACT endpoint:', '        ABOUT   one HTTP endpoint', '        DOMAIN  api', '        AS      spec', '        BY      api-dev, api-dev-2',
  '    CONTRACT repository:', '        ABOUT   one table and its repository', '        DOMAIN  persistence', '        AS      spec', '        BY      db-dev']);
write(join(proj, 'PROJECT.ap'), ['ABOUT  the project', '', 'IMPORT request FROM @main.templates', '', 'CONTRACT change:', '    ABOUT   any change', '    AS      request', '    BY      backend']);
const api = write(join(proj, 'src', 'api', 'users.ts'), ['export function getUser(id: string) {', '  return null;', '}']);
const apiOrders = write(join(proj, 'src', 'api', 'orders.ts'), ['export function getOrder(id: string) {', '  return null;', '}']);
const db = write(join(proj, 'src', 'db', 'users.ts'), ['// the users table', 'export const users = [];']);

const SESSION = 'contracts-session';
const bundle = () => {
  const r = spawnSync(process.execPath, [CLI, 'bundle', 'all'], { cwd: proj, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(r.status, 0, `bundle all failed:\n${r.stdout}${r.stderr}`);
};
/** One run of an agent's apx, in the session — `input` on stdin. */
const apx = (who, args, input) => {
  const r = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', `${who}.apx`), 'contract', ...args], { cwd: proj, encoding: 'utf-8', input, env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION } });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trimEnd() };
};
const ok = (r, what) => { assert.equal(r.code, 0, `${what}:\n${r.out}`); return r.out; };
const has = (r, text) => { const out = typeof r === 'string' ? r : r.out; assert.ok(out.includes(text), `expected "${text}" in:\n${out}`); };
const ctrOf = out => out.match(/^(ctr-[0-9a-f]{8})/m)[1];
const lines = file => readFileSync(file, 'utf-8').split('\n');
const conId = (name) => {
  const r = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'architect.apx'), 'ls', 'kind=contract'], { cwd: proj, encoding: 'utf-8' });
  return r.stdout.match(new RegExp(`(con-[0-9a-f]{8})\\s+${name}\\b`))[1];
};

try {
  bundle();
  // --- the real build: AGENTS.md shows the strategy, the harness has the flow's script, the lead's apx says how to run it ---
  {
    const md = readFileSync(join(proj, 'AGENTS.md'), 'utf-8');
    assert.ok(md.includes('`strategy`: contracts — the lead `architect`'), md);
    assert.ok(md.includes('- `endpoint` — one HTTP endpoint — domain `api` — carried out by `api-dev`, `api-dev-2`'), md);
    const flowId = md.match(/Run the flow `backend-contracts` \((flw-[0-9a-f]{8})\)/)?.[1];
    assert.ok(flowId, md);
    const { readdirSync } = await import('fs');
    assert.ok(readdirSync(join(proj, '.agent-pack', 'flows')).some(f => f.startsWith(`${flowId}.`) && f.endsWith('.js')), 'the Workflow script of the strategy\'s flow');
    const how = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'architect.apx'), 'flow', flowId], { cwd: proj, encoding: 'utf-8' });
    assert.equal(how.status, 0, how.stdout + how.stderr);
    const script = readFileSync(join(proj, '.agent-pack', 'flows', readdirSync(join(proj, '.agent-pack', 'flows')).find(f => f.startsWith(`${flowId}.`))), 'utf-8');
    assert.ok(script.includes('parallel(') && /agentType: ['"]api-dev-2['"]/.test(script) && /agentType: ['"]db-dev['"]/.test(script), script);
  }
  const CHANGE = conId('change');
  const ENDPOINT = conId('endpoint');
  const REPOSITORY = conId('repository');

  // --- roles: a member writes nothing, only the lead starts ---
  assert.equal(apx('api-dev', ['start', CHANGE, '-'], '{"request":"x"}').code, 2);
  has(apx('api-dev', ['start', CHANGE, '-'], '{"request":"x"}'), 'only the lead (architect) starts the team');
  assert.equal(apx('architect', ['new', ENDPOINT, '-'], '{"goal":"g"}').code, 2, 'no instance to be part of yet');

  // --- start: the request the lead was handed; the spec against its form ---
  const broken = apx('architect', ['start', CHANGE, '-'], '{"nope":1}');
  assert.equal(broken.code, 6, 'a spec that breaks the form');
  has(broken, 'a spec is JSON shaped like {"request":');
  const root = ctrOf(ok(apx('architect', ['start', CHANGE, '-'], '{"request":"add GET /users/:id and GET /orders/:id"}'), 'start'));
  assert.match(root, /^ctr-[0-9a-f]{8}$/);
  assert.equal(apx('architect', ['start', CHANGE, '-'], '{"request":"again"}').code, 2, 'one request at a time');

  // --- new: the team's contracts, rotation over BY, depends ---
  assert.equal(apx('architect', ['new', CHANGE, '-'], '{"request":"x"}').code, 2, 'the project contract is no contract of the team');
  const repo = ctrOf(ok(apx('architect', ['new', 'repository', '-'], '{"goal":"read a user"}'), 'new repository, by its name'));
  const e1 = apx('architect', ['new', ENDPOINT, `depends=${repo}`, '-'], '{"goal":"GET /users/:id"}');
  has(e1, '→ api-dev');
  const users = ctrOf(e1.out);
  const e2 = apx('architect', ['new', ENDPOINT, '-'], '{"goal":"GET /orders/:id"}');
  has(e2, '→ api-dev-2');
  const orders = ctrOf(e2.out);
  assert.equal(apx('architect', ['new', ENDPOINT, 'depends=ctr-00000000', '-'], '{"goal":"x"}').code, 1, 'depends on nothing that exists');

  // --- dispatch: every zone checked, nothing handed out on a refusal ---
  let d = apx('architect', ['dispatch']);
  assert.equal(d.code, 3);
  has(d, `${users}: no zone`);
  // marks: users in the api file, orders in the same file (two assignees), repo in an api file (wrong domain)
  write(api, ['export function getUser(id: string) {', `  // agent-pack ${users}`, '  return null;', `  // agent-pack end ${users}`, '}',
    'export function listUsers() {', `  // agent-pack ${orders}`, `  // agent-pack end ${orders}`, '}']);
  write(apiOrders, ['export function getOrder(id: string) {', `  // agent-pack ${repo}`, `  // agent-pack end ${repo}`, '}']);
  d = apx('architect', ['dispatch']);
  assert.equal(d.code, 3);
  has(d, 'src/api/users.ts holds the zones of api-dev and api-dev-2');
  has(d, `${repo}: src/api/orders.ts is of the domain \`api\`, and repository is of \`persistence\``);
  assert.ok(!/handed out/.test(d.out.split('\n').filter(l => !l.startsWith('# error')).join('\n')) || d.code === 3);
  // a closing mark before the opening one
  write(db, ['// the users table', `// agent-pack end ${repo}`, `// agent-pack ${repo}`, 'export const users = [];']);
  write(apiOrders, ['export function getOrder(id: string) {', `  // agent-pack ${orders}`, `  // agent-pack end ${orders}`, '}']);
  write(api, ['export function getUser(id: string) {', `  // agent-pack ${users}`, '  return null;', `  // agent-pack end ${users}`, '}']);
  d = apx('architect', ['dispatch']);
  has(d, `${repo}: src/db/users.ts: the closing mark (line 2) comes before the opening one (line 3)`);
  write(db, ['// the users table', `// agent-pack ${repo}`, `// agent-pack end ${repo}`, 'export const users = [];']);
  d = ok(apx('architect', ['dispatch']), 'dispatch');
  has(d, `${users}  endpoint  src/api/users.ts:2-4  → api-dev`);
  has(d, `${repo}  repository  src/db/users.ts:2-3  → db-dev`);
  has(d, '3 instances handed out');
  assert.equal(apx('architect', ['new', ENDPOINT, '-'], '{"goal":"more"}').code, 2, 'frozen while the work runs');
  has(apx('architect', ['new', ENDPOINT, '-'], '{"goal":"more"}'), 'meanwhile only list and get');
  assert.equal(apx('architect', ['merge', users]).code, 2, 'no merge while the work runs');

  // --- get / list ---
  const g = ok(apx('api-dev', ['get', users]), 'get');
  has({ out: g }, `contract ${users} — endpoint — assigned — assigned to api-dev`);
  has({ out: g }, 'zone: src/api/users.ts:2-4');
  has({ out: g }, `depends on: ${repo} (assigned)`);
  has({ out: g }, '"goal": "GET /users/:id"');
  has({ out: g }, `contract deliver ${users}`);
  const l = ok(apx('db-dev', ['list']), 'list');
  assert.equal(l.split('\n').filter(x => x.startsWith('ctr-')).length, 4, l);

  // --- deliver: not another's, not with marks, not outside the zone ---
  assert.equal(apx('db-dev', ['deliver', users]).code, 2, "not db-dev's");
  let r = apx('api-dev', ['deliver', users]);
  assert.equal(r.code, 3);
  has(r, `the marks of ${users} are still in src/api/users.ts`);
  write(api, ['export function getUser(id: string) {', '  return db.find(id);', '}']);
  write(db, ['// the users table', `// agent-pack ${repo}`, '// touched by api-dev', `// agent-pack end ${repo}`, 'export const users = [];']);
  write(join(proj, 'src', 'api', 'helpers.ts'), 'export const x = 1;');
  r = apx('api-dev', ['deliver', users]);
  assert.equal(r.code, 3);
  has(r, 'src/api/helpers.ts is new — your zone is src/api/users.ts alone');
  assert.ok(!r.out.includes('src/db/users.ts changed'), 'db-dev\'s zone, still at work, is not counted');
  write(db, ['// the users table', `// agent-pack ${repo}`, `// agent-pack end ${repo}`, 'export const users = [];']);
  rmSync(join(proj, 'src', 'api', 'helpers.ts'));
  // the others are at work meanwhile: db-dev writes in its own zone, api-dev-2 in its own — neither counts against api-dev
  write(db, ['// the users table', `// agent-pack ${repo}`, '// db-dev is writing here', `// agent-pack end ${repo}`, 'export const users = [];']);
  write(apiOrders, ['export function getOrder(id: string) {', `  // agent-pack ${orders}`, '  // api-dev-2 is writing here', `  // agent-pack end ${orders}`, '}']);
  ok(apx('api-dev', ['deliver', users]), 'deliver users while the others are still at work');
  write(db, ['// the users table', `// agent-pack ${repo}`, `// agent-pack end ${repo}`, 'export const users = [];']);
  write(apiOrders, ['export function getOrder(id: string) {', `  // agent-pack ${orders}`, `  // agent-pack end ${orders}`, '}']);
  assert.equal(apx('api-dev', ['deliver', users]).code, 2, 'delivered once');

  // --- the transition is a compare-and-swap: a state changed meanwhile is exit 4 ---
  const table = join(proj, STATE_DIR, SESSION, 'contracts.tbl');
  const [rec] = queryTable(table, [`ctr=${orders}`]);
  // another agent blocks it between our read and our write: emulate by changing the state the CAS expects
  write(apiOrders, ['export function getOrder(id: string) {', '  return null;', '}']);
  runTable(table, ['s', String(rec.id), 'state=delivered']);
  assert.equal(apx('api-dev-2', ['deliver', orders]).code, 2, 'no longer assigned');
  runTable(table, ['s', String(rec.id), 'state=assigned']);

  // --- the table itself: a transition from a state the record no longer has is refused (tabeli's CAS, exit 4 at the apx) ---
  {
    const { ContractTable } = await import('../dist/src/apx/contracts.js');
    const { TABELI_ENGINE } = await import('../dist/src/config.js');
    const t = ContractTable.open(proj, SESSION, TABELI_ENGINE);
    assert.equal(t.transition(users, 'assigned', 'blocked'), false, 'users is delivered: the swap from assigned fails');
    assert.equal(t.get(users).state, 'delivered', 'and nothing changed');
  }

  // --- block: a reason, the assignee only ---
  assert.equal(apx('db-dev', ['block', repo]).code, 2, 'a reason is needed');
  ok(apx('db-dev', ['block', repo, 'the users table has no email column']), 'block');
  has(apx('db-dev', ['get', repo]), 'blocked: the users table has no email column');
  ok(apx('api-dev-2', ['deliver', orders]), 'deliver orders');

  // --- merge: delivered only, after what it depends on ---
  r = apx('architect', ['merge', users]);
  assert.equal(r.code, 3);
  has(r, `${users} depends on ${repo} (blocked)`);
  ok(apx('architect', ['merge', orders]), 'merge orders');
  has(apx('architect', ['list']), `${orders}  endpoint  merged`);
  assert.equal(apx('api-dev', ['merge', orders]).code, 2, 'only the lead merges');

  // --- the instance the lead was handed closes once its parts are merged; a blocked part, carried out by the lead, is merged by it ---
  r = apx('architect', ['deliver', root]);
  assert.equal(r.code, 3);
  has(r, `${root} still has parts to finish: ${users} (delivered)`);
  ok(apx('architect', ['merge', repo]), 'the lead carried the blocked one out');
  ok(apx('architect', ['merge', users]), 'its dependency is merged now');
  ok(apx('architect', ['deliver', root]), 'the request is done');
  has(apx('architect', ['list']), `${root}  change  delivered`);

  // --- a team without contracts has none; no session, nothing read ---
  const noSession = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'architect.apx'), 'contract', 'list'], { cwd: proj, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } });
  assert.equal(noSession.status, 2);

  console.log('contracts (apx) tests passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
