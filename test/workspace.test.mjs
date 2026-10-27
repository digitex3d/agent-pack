// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The git workspace engine (adapters/git) on real repositories: a copy per
 * instance from a base that keeps the developer's uncommitted changes, reads
 * as a sparse checkout, ignored paths linked, a delivery that keeps only what
 * it is allowed — files, or the lines of a zone — and names what it left out,
 * merges with and without a conflict, rounds whose base keeps what landed, and
 * a land that writes the result into the working folder — never the index,
 * never a branch — or writes nothing when it conflicts.
 */
import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { resolveWorkspace } = await import('../dist/src/workspace/registry.js');
const engine = resolveWorkspace('git');

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
const read = (root, path) => readFileSync(join(root, path), 'utf-8');

/** A project: two committed domains and some data, ignored node_modules and dist, the runtime folder, an uncommitted README. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'ap-workspace-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'dev');
  put(root, '.gitignore', 'node_modules\ndist/\n.agent-pack/\n');
  put(root, 'src/api/users.ts', 'export const users = [];\n');
  put(root, 'src/db/schema.ts', 'export const schema = {};\n');
  put(root, 'data/imp.ts', 'export const imp = {};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'start');
  put(root, 'node_modules/lib/index.js', 'module.exports = 1;\n');
  put(root, 'dist/out.js', 'built\n');
  put(root, '.agent-pack/apx/api-dev.apx', '// apx\n');
  put(root, 'README.md', '# doom\nmy note\n');
  return root;
}

// --- the git engine is registered by name; an unknown one is refused with the list ---
assert.equal(engine.name, 'git');
assert.throws(() => resolveWorkspace('svn'), /Unknown workspace "svn" — built-in workspaces: git/);

{
  const root = project();
  const head = git(root, 'rev-parse', 'HEAD');
  const ws = engine.session(root, 's1');

  // --- open: a sparse copy of the reads and writes, ignored paths linked only when the reads cover them ---
  ws.open('ctr-aaaaaaaa', { reads: ['src/db/**', 'node_modules/**'], writes: ['src/api/**'] });
  ws.open('ctr-bbbbbbbb', { reads: null, writes: ['src/db/**'] });
  const a = join(root, ws.path('ctr-aaaaaaaa'));
  const b = join(root, ws.path('ctr-bbbbbbbb'));
  assert.equal(ws.path('ctr-aaaaaaaa'), '.agent-pack/work/ctr-aaaaaaaa');
  assert.ok(existsSync(join(a, 'src/api/users.ts')) && existsSync(join(a, 'src/db/schema.ts')), 'reads and writes are in the copy');
  assert.ok(!existsSync(join(a, 'data/imp.ts')), 'what it does not read is not in the copy');
  assert.ok(!existsSync(join(a, 'README.md')), 'README is outside the reads');
  assert.ok(lstatSync(join(a, 'node_modules')).isSymbolicLink(), 'an ignored folder the reads cover is linked');
  assert.equal(read(a, 'node_modules/lib/index.js'), 'module.exports = 1;\n');
  assert.ok(!existsSync(join(a, 'dist')), 'an ignored folder the reads do not cover is not there');
  assert.ok(lstatSync(join(a, '.agent-pack/apx')).isSymbolicLink(), 'the apx is reachable from every copy');
  assert.ok(!existsSync(join(a, '.agent-pack/work')), 'a copy never holds the copies');
  assert.ok(existsSync(join(b, 'data/imp.ts')), 'no reads: every tracked file');
  assert.equal(read(b, 'README.md'), '# doom\nmy note\n', 'the base keeps the uncommitted changes');
  assert.ok(!existsSync(join(b, 'node_modules')), 'no reads: nothing git ignores');
  assert.throws(() => ws.open('ctr-aaaaaaaa', { reads: null, writes: [] }), /has a copy already/);
  assert.throws(() => ws.open('../escape', { reads: null, writes: [] }), /no instance id/);

  // --- the developer's repository is untouched ---
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'no commit on the branch');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'the index is untouched');
  assert.equal(git(root, 'status', '--porcelain'), '?? README.md', 'the copies stay out of git status');

  // --- deliver: only the writes, and what was left out is said ---
  put(a, 'src/api/users.ts', 'export const users = [];\nexport const list = () => users;\n');
  put(a, 'src/api/helpers.ts', 'export const helper = 1;\n');
  put(a, 'src/db/schema.ts', 'export const schema = { touched: true };\n');
  put(a, 'data/rogue.ts', 'outside\n');
  let d = ws.deliver('ctr-aaaaaaaa', { globs: ['src/api/**'] });
  assert.deepEqual(d.committed.sort(), ['src/api/helpers.ts', 'src/api/users.ts']);
  assert.deepEqual(d.leftOut.sort(), ['data/rogue.ts', 'src/db/schema.ts'], 'a read-only file and a file outside the reads are left out, never the links');

  put(b, 'src/db/schema.ts', 'export const schema = { users: "users" };\n');
  d = ws.deliver('ctr-bbbbbbbb', { globs: ['src/db/**'] });
  assert.deepEqual(d, { committed: ['src/db/schema.ts'], leftOut: [], strayed: [], lostZones: [] });

  // --- merge: each delivery as it comes ---
  assert.deepEqual(ws.merge('ctr-aaaaaaaa'), { merged: true });
  assert.deepEqual(ws.merge('ctr-bbbbbbbb'), { merged: true });
  assert.throws(() => ws.merge('ctr-cccccccc'), /ctr-cccccccc was not delivered/);

  // --- a conflict: named by file; the lead says who wins ---
  ws.open('ctr-cccccccc', { reads: null, writes: ['src/api/**'] });
  const c = join(root, ws.path('ctr-cccccccc'));
  put(c, 'src/api/users.ts', 'export const users = ["root"];\n');
  ws.deliver('ctr-cccccccc', { globs: ['src/api/**'] });
  assert.deepEqual(ws.merge('ctr-cccccccc'), { merged: false, conflicts: ['src/api/users.ts'] });
  assert.deepEqual(ws.merge('ctr-cccccccc', 'theirs'), { merged: true });

  // --- land: into the working folder, beside what the developer changed meanwhile ---
  put(root, 'README.md', '# doom\nmy note\nmy later note\n');
  const landed = ws.land({ close: true });
  assert.deepEqual(landed.landed.sort(), ['src/api/helpers.ts', 'src/api/users.ts', 'src/db/schema.ts']);
  assert.equal(read(root, 'src/api/users.ts'), 'export const users = ["root"];\n', 'the winner of the conflict');
  assert.equal(read(root, 'src/db/schema.ts'), 'export const schema = { users: "users" };\n');
  assert.ok(!existsSync(join(root, 'data/rogue.ts')), 'what was left out never lands');
  assert.equal(read(root, 'README.md'), '# doom\nmy note\nmy later note\n', 'the developer\'s change is kept');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'still no commit');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'still the index untouched');
  assert.deepEqual(git(root, 'status', '--porcelain').split('\n').map(l => l.trim()).sort(), ['?? README.md', '?? src/api/helpers.ts', 'M src/api/users.ts', 'M src/db/schema.ts'], 'uncommitted changes, the developer commits');
  assert.equal(git(root, 'diff', '--name-only').split('\n').sort().join(' '), 'src/api/users.ts src/db/schema.ts', 'changed in the working folder, not staged');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1, 'every copy closed');
  assert.equal(git(root, 'for-each-ref', 'refs/agent-pack/'), '', 'no hidden ref left');
  rmSync(root, { recursive: true, force: true });
}

{
  // --- land refuses, writing nothing, when the developer changed the same lines meanwhile ---
  const root = project();
  const ws = engine.session(root, 's2');
  ws.open('ctr-dddddddd', { reads: null, writes: ['src/api/**'] });
  put(join(root, ws.path('ctr-dddddddd')), 'src/api/users.ts', 'export const users = ["agent"];\n');
  ws.deliver('ctr-dddddddd', { globs: ['src/api/**'] });
  ws.merge('ctr-dddddddd');
  put(root, 'src/api/users.ts', 'export const users = ["developer"];\n');
  assert.deepEqual(ws.land(), { conflicts: ['src/api/users.ts'] });
  assert.equal(read(root, 'src/api/users.ts'), 'export const users = ["developer"];\n', 'nothing written');
  assert.ok(existsSync(join(root, ws.path('ctr-dddddddd'))), 'the copies stay, to land again');
  rmSync(root, { recursive: true, force: true });
}

{
  // --- a delivery whose writes the copy never touched keeps nothing ---
  const root = project();
  const ws = engine.session(root, 's3');
  ws.open('ctr-eeeeeeee', { reads: [], writes: ['src/none/**'] });
  assert.deepEqual(ws.deliver('ctr-eeeeeeee', { globs: ['src/none/**'] }), { committed: [], leftOut: [], strayed: [], lostZones: [] });

  // --- writes are agent-pack globs, braces included ---
  ws.open('ctr-ffffffff', { reads: ['data/**'], writes: ['src/{api,db}/**'] });
  const f = join(root, ws.path('ctr-ffffffff'));
  assert.ok(existsSync(join(f, 'src/db/schema.ts')) && !existsSync(join(f, 'README.md')), 'braces in the sparse patterns too');
  put(f, 'src/api/users.ts', 'export const users = [1];\n');
  put(f, 'src/db/schema.ts', 'export const schema = { a: 1 };\n');
  put(f, 'data/imp.ts', 'export const imp = { hp: 60 };\n');
  assert.deepEqual(ws.deliver('ctr-ffffffff', { globs: ['src/{api,db}/**'] }), { committed: ['src/api/users.ts', 'src/db/schema.ts'], leftOut: ['data/imp.ts'], strayed: [], lostZones: [] });
  rmSync(root, { recursive: true, force: true });
}

{
  // --- a zone: only the hunks inside its lines are kept; the others are left out, with their lines ---
  const root = project();
  put(root, 'src/api/users.ts', ['import { db } from "../db";', 'export const users = [];', '// agent-pack ctr-11111111', 'export function list() {', '  return users;', '}', '// agent-pack end ctr-11111111', 'export const count = 0;', ''].join('\n'));
  const ws = engine.session(root, 's4');
  ws.open('ctr-11111111', { reads: null, writes: ['src/api/**'] });
  const z = join(root, ws.path('ctr-11111111'));
  // The member works between the marks and leaves them; it also adds an import and changes a line outside them.
  put(z, 'src/api/users.ts', ['import { db } from "../db";', 'import { sort } from "../sort";', 'export const users = [];', '// agent-pack ctr-11111111', 'export function list() {', '  return sort(users);', '}', '// agent-pack end ctr-11111111', 'export const count = 1;', ''].join('\n'));
  put(z, 'src/api/helper.ts', 'export const h = 1;\n');
  const marks = { open: 'agent-pack ctr-11111111', close: 'agent-pack end ctr-11111111', files: ['src/api/users.ts'] };
  const allowed = { globs: ['src/api/users.ts'], marks: { ...marks, only: true } };
  const dry = ws.deliver('ctr-11111111', allowed, { dryRun: true });
  assert.deepEqual(dry, { committed: ['src/api/users.ts'], leftOut: ['src/api/helper.ts', 'src/api/users.ts (outside its zones)'], strayed: [], lostZones: [] });
  assert.throws(() => ws.merge('ctr-11111111'), /was not delivered/, 'a dry run commits nothing');
  const d = ws.deliver('ctr-11111111', allowed);
  assert.deepEqual(d.leftOut, dry.leftOut);
  assert.deepEqual(ws.merge('ctr-11111111'), { merged: true });
  ws.land({ close: true });
  assert.equal(read(root, 'src/api/users.ts'), ['import { db } from "../db";', 'export const users = [];', 'export function list() {', '  return sort(users);', '}', 'export const count = 0;', ''].join('\n'),
    'the zone landed, its marks dropped; the import and the count outside it did not');
  {
    // A zone whose marks the member deleted cannot be read: the file stays out, with the way back.
    const ws3 = engine.session(root, 's7');
    put(root, 'src/api/orders.ts', ['// agent-pack ctr-66666666', 'export const orders = [];', '// agent-pack end ctr-66666666', ''].join('\n'));
    ws3.open('ctr-66666666', { reads: null, writes: ['src/api/**'] });
    put(join(root, ws3.path('ctr-66666666')), 'src/api/orders.ts', 'export const orders = [1];\n');
    const zm = { open: 'agent-pack ctr-66666666', close: 'agent-pack end ctr-66666666', files: ['src/api/orders.ts'] };
    assert.deepEqual(ws3.deliver('ctr-66666666', { globs: ['src/api/orders.ts'], marks: { ...zm, only: true } }, { dryRun: true }).lostZones,
      ['src/api/orders.ts (0 of its 1 zone left)']);
    // WITHIN file: the whole file, its marks dropped all the same.
    assert.deepEqual(ws3.deliver('ctr-66666666', { globs: ['src/api/orders.ts'], marks: { ...zm, only: false } }).committed, ['src/api/orders.ts']);
    ws3.merge('ctr-66666666');
    ws3.land({ close: true });
    assert.equal(read(root, 'src/api/orders.ts'), 'export const orders = [1];\n');
  }

  // --- work done in the working folder instead of the copy is named ---
  const ws2 = engine.session(root, 's5');
  put(root, 'src/db/notes.md', 'untracked before the base: no change\n');
  ws2.open('ctr-22222222', { reads: null, writes: ['src/db/**'] });
  assert.deepEqual(ws2.deliver('ctr-22222222', { globs: ['src/db/**'] }, { dryRun: true }).strayed, [], 'what the base took untracked is no change');
  put(root, 'src/db/schema.ts', 'export const schema = { wrong: "place" };\n');
  assert.deepEqual(ws2.deliver('ctr-22222222', { globs: ['src/db/**'] }), { committed: [], leftOut: [], strayed: ['src/db/schema.ts'], lostZones: [] });
  ws2.land({ close: true });
  rmSync(root, { recursive: true, force: true });
}

{
  // --- rounds: a land brings what was merged home, the next base holds it; a copy of round 1 still merges in round 2 ---
  const root = project();
  const ws = engine.session(root, 's6');
  ws.open('ctr-33333333', { reads: null, writes: ['src/api/**'] });
  ws.open('ctr-44444444', { reads: null, writes: ['src/db/**'] });
  put(join(root, ws.path('ctr-33333333')), 'src/api/users.ts', 'export const users = ["round 1"];\n');
  ws.deliver('ctr-33333333', { globs: ['src/api/**'] });
  ws.merge('ctr-33333333');
  put(root, 'data/imp.ts', 'export const imp = { round: 2 };\n');   // the lead prepares round 2, then dispatches: land, then open
  assert.deepEqual(ws.land(), { landed: ['src/api/users.ts'] }, 'the merged work lands, the copies stay');
  assert.equal(read(root, 'src/api/users.ts'), 'export const users = ["round 1"];\n');
  ws.open('ctr-55555555', { reads: null, writes: ['data/**'] });
  const r2 = join(root, ws.path('ctr-55555555'));
  assert.equal(read(r2, 'src/api/users.ts'), 'export const users = ["round 1"];\n', 'round 2 starts from what round 1 landed');
  assert.equal(read(r2, 'data/imp.ts'), 'export const imp = { round: 2 };\n', 'and from what the lead wrote since');
  put(join(root, ws.path('ctr-44444444')), 'src/db/schema.ts', 'export const schema = { late: true };\n');
  ws.deliver('ctr-44444444', { globs: ['src/db/**'] });
  assert.deepEqual(ws.merge('ctr-44444444'), { merged: true }, 'a copy of round 1 merges into round 2');
  ws.land({ close: true });
  assert.equal(read(root, 'src/db/schema.ts'), 'export const schema = { late: true };\n');
  assert.equal(read(root, 'src/api/users.ts'), 'export const users = ["round 1"];\n');
  assert.equal(git(root, 'worktree', 'list').split('\n').length, 1);
  rmSync(root, { recursive: true, force: true });
}

// --- a folder outside git is refused with the way out ---
{
  const root = mkdtempSync(join(tmpdir(), 'ap-workspace-'));
  assert.throws(() => engine.session(root, 's1'), /is not a git repository — the copies of the contracts need one: git init/);
  assert.throws(() => engine.session(root, '../x'), /no session id/);
  rmSync(root, { recursive: true, force: true });
}

console.log('workspace tests passed.');
