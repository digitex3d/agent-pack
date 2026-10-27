// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The contracts strategy — the apx side (D44): a real project, the real
 * `bundle all`, the agents' real apx run as processes in one session.
 *
 *   - start / new / dispatch / deliver / block / take / merge / get /
 *     list, each by the agent whose it is; ids, rotation over a BY
 *   - dispatch: zones in what the lead writes, marks in order, a zone in a file
 *     its assignee writes, WITHIN zone needs one; a copy per instance
 *   - deliver: from the copy, what WITHIN admits; anything else only with a
 *     reason; a transition is a compare-and-swap (exit 4)
 *   - take: the lead finishes a blocked instance in its copy
 *   - merge: after every instance it depends on, as soon as it is delivered;
 *     delivering the request lands the work in the working folder
 */

import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const { STATE_DIR } = await import('../dist/src/apx/paths.js');
const { queryTable, runTable } = await import('../dist/src/apx/tabeli.js');

const proj = mkdtempSync(join(tmpdir(), 'ap-contracts-apx-'));
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, (Array.isArray(lines) ? lines.join('\n') : lines) + '\n'); return file; };

write(join(proj, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", "  adapters: ['claude-code'],", '};']);
write(join(proj, 'library', 'templates', 'spec.ap'), ['EXPORT TEMPLATE spec:', '    ABOUT  a spec', '    SLOTS:', '        goal: TEXT  "what the zone does"', '    BODY:', '        {goal}']);
write(join(proj, 'library', 'templates', 'request.ap'), ['EXPORT TEMPLATE request:', '    ABOUT  a request', '    SLOTS:', '        request: TEXT  "the request"', '    BODY:', '        {request}']);
// The domains: the lead writes all the sources, each member its own region.
const domain = (name, globs) => write(join(proj, 'library', 'domains', `${name}.ap`), [`EXPORT DOMAIN ${name}:`, `    ABOUT  ${name}`, `    FOR    ${globs}`]);
domain('code', 'src/**'); domain('api', 'src/api/**'); domain('persistence', 'src/db/**');
const team = join(proj, 'agents', 'teams', 'backend');
const agent = (name, lines, imports = []) => write(join(team, `${name}.ap`), [...imports, ...(imports.length ? [''] : []),
  `EXPORT AGENT ${name} AS ${name}-role:`, `    ABOUT    ${name}`, '    MANDATE  do the work', ...lines, '', `ROLE ${name}-role:`, '    ABOUT   a worker', '    ALWAYS  work']);
agent('architect', ['    WRITES   code', '    WHEN handed change:', '        DO  write the skeletons, hand the zones out'], ['IMPORT code FROM @main.domains']);
agent('api-dev', ['    WRITES   api', '    WHEN handed endpoint:', '        DO  implement the zone'], ['IMPORT api FROM @main.domains']);
agent('api-dev-2', ['    WRITES   api', '    WHEN handed endpoint:', '        DO  implement the zone'], ['IMPORT api FROM @main.domains']);
agent('db-dev', ['    WRITES   persistence', '    WHEN handed repository:', '        DO  implement the zone'], ['IMPORT persistence FROM @main.domains']);
write(join(team, 'backend.ap'), ['IMPORT spec FROM @main.templates', '', 'EXPORT TEAM backend:', '    ABOUT     builds a backend change by contracts',
  '    STRATEGY  contracts', '    LEAD      architect',
  '    CONTRACT endpoint:', '        ABOUT   one HTTP endpoint', '        DOMAIN  api', '        WITHIN  zone', '        AS      spec', '        BY      api-dev, api-dev-2',
  '    CONTRACT repository:', '        ABOUT   one table and its repository', '        DOMAIN  persistence', '        AS      spec', '        BY      db-dev']);
write(join(proj, 'PROJECT.ap'), ['ABOUT  the project', '', 'IMPORT request FROM @main.templates', '', 'CONTRACT change:', '    ABOUT   any change', '    AS      request', '    BY      backend']);
const api = write(join(proj, 'src', 'api', 'users.ts'), ['export function getUser(id: string) {', '  return null;', '}']);
const apiOrders = write(join(proj, 'src', 'api', 'orders.ts'), ['export function getOrder(id: string) {', '  return null;', '}']);
const db = write(join(proj, 'src', 'db', 'users.ts'), ['// the users table', 'export const users = [];']);
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf-8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
write(join(proj, '.gitignore'), ['.agent-pack/', '.claude/']);
git(proj, 'init', '-q'); git(proj, 'config', 'user.email', 'dev@example.com'); git(proj, 'config', 'user.name', 'dev');
git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'start');

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

  // --- dispatch: WITHIN zone needs a zone; marks in order; a zone in a file its assignee writes; nothing handed out on a refusal ---
  let d = apx('architect', ['dispatch']);
  assert.equal(d.code, 3);
  has(d, `${users}: WITHIN zone needs a zone`);
  assert.ok(!d.out.includes(`${repo}:`), 'a repository is WITHIN domain: no zone needed');
  write(api, ['export function getUser(id: string) {', `  // agent-pack end ${users}`, '  return null;', `  // agent-pack ${users}`, '}']);
  write(db, ['// the users table', `// agent-pack ${orders}`, 'export const users = [];', `// agent-pack end ${orders}`]);
  d = apx('architect', ['dispatch']);
  has(d, `${users}: src/api/users.ts: the closing mark (line 2) comes with no opening one before it`);
  has(d, `${orders}: src/db/users.ts holds a zone of it, and api-dev-2 does not write that file`);
  // users: one zone; orders: two zones, in two files — one of them in users' file too.
  write(api, ['export function getUser(id: string) {', `  // agent-pack ${users}`, '  return null;', `  // agent-pack end ${users}`, '}', '', `// agent-pack ${orders}`, 'export const ORDERS_BY_USER = false;', `// agent-pack end ${orders}`]);
  write(apiOrders, ['export function getOrder(id: string) {', `  // agent-pack ${orders}`, '  return null;', `  // agent-pack end ${orders}`, '}']);
  write(db, ['// the users table', 'export const users = [];']);
  d = ok(apx('architect', ['dispatch']), 'dispatch');
  has(d, `${users}  endpoint  → api-dev  within zone  src/api/users.ts:2-4  copy: .agent-pack/work/${users}`);
  has(d, `${orders}  endpoint  → api-dev-2  within zone  src/api/orders.ts:2-4;src/api/users.ts:7-9`);
  has(d, `${repo}  repository  → db-dev  within domain`);
  has(d, '3 instances handed out');
  assert.equal(git(proj, 'rev-parse', '--abbrev-ref', 'HEAD') !== '', true);
  assert.equal(git(proj, 'diff', '--cached', '--name-only'), '', 'the developer\'s index is untouched');
  const copy = ctr => join(proj, '.agent-pack', 'work', ctr);
  assert.ok(existsSync(join(copy(users), 'src', 'api', 'users.ts')), 'a copy per instance');
  assert.ok(readFileSync(join(copy(users), 'src', 'api', 'users.ts'), 'utf-8').includes(`agent-pack ${users}`), 'the copy starts from the working folder: the lead\'s marks are there');

  // --- get: the limit, the zones, the copy ---
  const g = ok(apx('api-dev', ['get', users]), 'get');
  has({ out: g }, `contract ${users} — endpoint — assigned — assigned to api-dev`);
  has({ out: g }, 'within: zone — write only between the marks of its zones');
  has({ out: g }, `copy: .agent-pack/work/${users}`);
  has({ out: g }, `# work in your copy: cd .agent-pack/work/${users}`);
  has({ out: g }, `depends on: ${repo} (assigned)`);
  has({ out: g }, '"goal": "GET /users/:id"');
  const l = ok(apx('db-dev', ['list']), 'list');
  assert.equal(l.split('\n').filter(x => x.startsWith('ctr-')).length, 4, l);

  // --- the member works in its copy: inside its zone, and once outside it — asked why at deliver ---
  write(join(copy(users), 'src', 'api', 'users.ts'), ['import { db } from "../db/users";', 'export function getUser(id: string) {', `  // agent-pack ${users}`, '  return db.find(id);', `  // agent-pack end ${users}`, '}', '', `// agent-pack ${orders}`, 'export const ORDERS_BY_USER = false;', `// agent-pack end ${orders}`]);
  // The Claude Code hook in the member's frontmatter: Claude Code calls it after each write, with the path written.
  assert.ok(readFileSync(join(proj, '.claude', 'agents', 'api-dev.md'), 'utf-8').includes('command: node "$CLAUDE_PROJECT_DIR"/.agent-pack/hooks/claude-code-within.mjs api-dev'), 'a member carries the hook');
  const hook = (agent, file) => spawnSync(process.execPath, [join(proj, '.agent-pack', 'hooks', 'claude-code-within.mjs'), agent], {
    cwd: proj, encoding: 'utf-8', input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: '' },
  }).stdout;
  const warned = JSON.parse(hook('api-dev', join(copy(users), 'src', 'api', 'users.ts')));
  assert.equal(warned.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(warned.hookSpecificOutput.additionalContext.startsWith(`src/api/users.ts (outside its zones) is outside ${users} (WITHIN zone): it will be left out of the delivery`), warned.hookSpecificOutput.additionalContext);
  assert.equal(hook('api-dev', join(proj, 'src', 'api', 'users.ts')), '', 'a write outside the copies: silent');
  assert.equal(readFileSync(join(copy(users), 'src', 'api', 'users.ts'), 'utf-8').includes('import { db }'), true, 'the hook never touches the write');
  assert.equal(apx('db-dev', ['deliver', users]).code, 2, "not db-dev's");
  let r = apx('api-dev', ['deliver', users]);
  assert.equal(r.code, 3);
  has(r, 'left out: src/api/users.ts (outside its zones)');
  has(r, `${users} was not delivered — what is left out stays out only with a good reason`);
  r = ok(apx('api-dev', ['deliver', users, '--why', 'the import is outside the zone']), 'deliver with a reason');
  has({ out: r }, `${users}  delivered — src/api/users.ts`);
  has({ out: r }, 'left out: src/api/users.ts (outside its zones) — why: the import is outside the zone');
  assert.equal(apx('api-dev', ['deliver', users]).code, 2, 'delivered once');

  // --- a transition from a state the record no longer has is refused (tabeli's CAS, exit 4 at the apx) ---
  {
    const { ContractTable } = await import('../dist/src/apx/contracts.js');
    const { TABELI_ENGINE } = await import('../dist/src/config.js');
    const t = ContractTable.open(proj, SESSION, TABELI_ENGINE);
    assert.equal(t.transition(users, 'assigned', 'blocked'), false, 'users is delivered: the swap from assigned fails');
    assert.equal(t.get(users).state, 'delivered', 'and nothing changed');
  }

  // --- orders: two zones in two files, all of it inside them ---
  write(join(copy(orders), 'src', 'api', 'orders.ts'), ['export function getOrder(id: string) {', `  // agent-pack ${orders}`, '  return { id };', `  // agent-pack end ${orders}`, '}']);
  write(join(copy(orders), 'src', 'api', 'users.ts'), ['export function getUser(id: string) {', `  // agent-pack ${users}`, '  return null;', `  // agent-pack end ${users}`, '}', '', `// agent-pack ${orders}`, 'export const ORDERS_BY_USER = true;', `// agent-pack end ${orders}`]);
  assert.equal(hook('api-dev-2', join(copy(orders), 'src', 'api', 'orders.ts')), '', 'a write within the zones: silent');
  r = ok(apx('api-dev-2', ['deliver', orders]), 'deliver orders');
  has({ out: r }, `${orders}  delivered — src/api/orders.ts, src/api/users.ts`);

  // --- block, then take: the lead finishes it in its copy ---
  assert.equal(apx('db-dev', ['block', repo]).code, 2, 'a reason is needed');
  write(join(copy(repo), 'src', 'db', 'users.ts'), ['// the users table', 'export const users = [];', 'export const find = (id: string) =>']);
  ok(apx('db-dev', ['block', repo, 'the users table has no email column']), 'block');
  assert.equal(apx('architect', ['merge', repo]).code, 2, 'a blocked instance is taken over, never merged as it is');
  assert.equal(apx('api-dev', ['take', repo]).code, 2, 'only the lead takes over');
  r = ok(apx('architect', ['take', repo]), 'take');
  has({ out: r }, `${repo}  taken by architect — work in .agent-pack/work/${repo}`);
  has({ out: r }, 'why it was blocked: the users table has no email column');
  assert.ok(readFileSync(join(copy(repo), 'src', 'db', 'users.ts'), 'utf-8').includes('export const find'), 'the work done so far is there');
  write(join(copy(repo), 'src', 'db', 'users.ts'), ['// the users table', 'export const users = [];', 'export const find = (id: string) => users[0];']);
  ok(apx('architect', ['deliver', repo]), 'the lead delivers it');

  // --- merge: after what it depends on, as soon as it is delivered; what was left out is shown, the lead may let it be ---
  r = apx('architect', ['merge', users]);
  assert.equal(r.code, 3);
  has(r, `${users} depends on ${repo} (delivered)`);
  ok(apx('architect', ['merge', repo]), 'merge repo');
  r = ok(apx('architect', ['merge', users]), 'merge users');
  has({ out: r }, 'left out: src/api/users.ts (outside its zones) — why: the import is outside the zone');
  assert.equal(apx('architect', ['merge', orders, '--prefer', 'mine']).code, 2, 'ours or theirs');
  ok(apx('architect', ['merge', orders]), 'merge orders');
  assert.equal(apx('api-dev', ['merge', orders]).code, 2, 'only the lead merges');

  // --- the request: done once its parts are merged; delivering it lands the work, uncommitted, and closes the copies ---
  r = ok(apx('architect', ['deliver', root]), 'the request is done');
  has({ out: r }, '# landed in the working folder: src/api/orders.ts, src/api/users.ts, src/db/users.ts');
  assert.equal(readFileSync(api, 'utf-8'), ['export function getUser(id: string) {', '  return db.find(id);', '}', '', 'export const ORDERS_BY_USER = true;', ''].join('\n'), 'both zones landed, marks dropped, the left-out import did not');
  assert.equal(readFileSync(apiOrders, 'utf-8'), ['export function getOrder(id: string) {', '  return { id };', '}', ''].join('\n'));
  assert.equal(readFileSync(db, 'utf-8'), ['// the users table', 'export const users = [];', 'export const find = (id: string) => users[0];', ''].join('\n'));
  assert.equal(git(proj, 'diff', '--cached', '--name-only'), '', 'nothing staged: the developer commits');
  assert.equal(git(proj, 'worktree', 'list').split('\n').length, 1, 'every copy closed');
  has(apx('architect', ['list']), `${root}  change  delivered`);

  // --- a team without contracts has none; no session, nothing read ---
  const noSession = spawnSync(process.execPath, [join(proj, '.agent-pack', 'apx', 'architect.apx'), 'contract', 'list'], { cwd: proj, encoding: 'utf-8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } });
  assert.equal(noSession.status, 2);

  console.log('contracts (apx) tests passed.');
} finally {
  rmSync(proj, { recursive: true, force: true });
}
