/**
 * Several roles on one agent — `AS reviewer, explorer`. A role is a craft many
 * agents share; each role an agent binds adds its identity line, its rules and
 * its imports. One role is a list of one, compiled as it always was.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const { bundleAgentToString } = await import('../dist/src/compiler/index.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');

const root = mkdtempSync(join(tmpdir(), 'ap-roles-'));
const write = (file, lines) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${lines.join('\n')}\n`); return file; };
const has = (out, ...needles) => { for (const n of needles) assert.ok(out.includes(n), `missing ${JSON.stringify(n)} in:\n${out}`); };
const lib = join(root, 'library');
const compile = (name, lines) => {
  const file = write(join(root, 'agents', `${name}.ap`), lines);
  return bundleAgentToString({ agentName: name, agentFile: file, agentDir: dirname(file), libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
};

try {
  write(join(lib, 'policies', 'careful.ap'), ['EXPORT POLICY careful:', '  ABOUT   be careful', '  APPLIES universal', '', '  ALWAYS  double-check what you hand over']);
  write(join(lib, 'roles', 'reviewer.ap'), [
    'IMPORT careful FROM @main.policies', '',
    'EXPORT ROLE reviewer:', '    ABOUT      a reviewer of changes', '    EXPERTISE  review, diffs', '    APPLIES    #craft',
    '    ALWAYS     read the diff before the report', '    ALWAYS     cite the line of every finding',
  ]);
  write(join(lib, 'roles', 'explorer.ap'), [
    'EXPORT ROLE explorer:', '    ABOUT      a mapper of code', '    EXPERTISE  code-reading',
    '    ALWAYS     cite the line of every finding', '    NEVER      edit a file',
  ]);
  write(join(lib, 'roles', 'author.ap'), ['EXPORT ROLE author:', '    ABOUT  a writer of code', '    ALWAYS  edit a file']);
  const agent = (as, extra = []) => [
    `IMPORT ${as.split(', ').join(', ')} FROM @main.roles`, '',
    `EXPORT AGENT hunter${as ? ` AS ${as}` : ''}:`, '    ABOUT    hunts edge cases', '    MANDATE  find every unhandled path', ...extra,
  ];

  // --- one role compiles as it always did: one identity line, its rules, its imports ---
  const one = await compile('hunter', agent('reviewer'));
  has(one, '# Identity', 'You are: **reviewer** — a reviewer of changes — with expertise in', 'read the diff before the report', 'double-check what you hand over');
  assert.equal((one.match(/You are:/g) ?? []).length, 1);

  // --- several roles add up: an identity line each, every rule once, each role's imports ---
  const two = await compile('hunter', agent('reviewer, explorer'));
  has(two, 'You are: **reviewer** — a reviewer of changes', 'You are: **explorer** — a mapper of code', 'read the diff before the report', 'edit a file', 'double-check what you hand over');
  assert.ok(two.indexOf('**reviewer**') < two.indexOf('**explorer**'), 'in the order written');
  assert.equal((two.match(/cite the line of every finding/g) ?? []).length, 1, 'a rule two roles share is kept once');
  assert.ok(!/^## Roles/m.test(two), 'both bound roles are the identity, not a Roles chapter');

  // --- two roles that disagree on a rule fail the build ---
  await assert.rejects(compile('hunter', agent('explorer, author')), /roles `explorer` and `author` disagree: `NEVER edit a file` and `ALWAYS edit a file`/);
  // --- a name no role answers, among several ---
  await assert.rejects(compile('hunter', [...agent('reviewer').slice(0, 2), 'EXPORT AGENT hunter AS reviewer, nobody:', '    ABOUT  x', '    MANDATE  y']), /unknown role `nobody`/);
  // --- no role at all is valid ---
  const none = await compile('hunter', ['EXPORT AGENT hunter:', '    ABOUT    hunts edge cases', '    MANDATE  find every unhandled path']);
  has(none, 'find every unhandled path');
  assert.ok(!none.includes('You are:'));
  // --- a comment on a role file's first line describes it, never renames its EXPORT ROLE block ---
  for (const head of ['# reviewer — a reviewer of changes: careful', '# foo: bar']) {
    write(join(lib, 'roles', 'reviewer.ap'), [head, '', 'EXPORT ROLE reviewer:', '    ABOUT  a reviewer of changes', '    ALWAYS  read the diff before the report']);
    has(await compile('hunter', agent('reviewer')), 'You are: **reviewer**', 'read the diff before the report');
  }
  console.log('roles: several roles on one agent passed.');

  // --- BY <role>: a role many members share cannot pick one; a role one member holds still resolves ---
  const teams = join(root, 'teams');
  const team = (by) => {
    write(join(teams, 'crew', 'crew.ap'), [
      'EXPORT TEAM crew:', '    ABOUT   a crew', '    MEMBER  alice, bob', '',
      '    WHEN asked to review:', '        RUN check', '',
      '    FLOW check:', '        STEP review:', `            DELEGATE review the diff BY ${by}`,
    ]);
    write(join(teams, 'crew', 'alice.ap'), ['IMPORT reviewer FROM @main.roles', '', 'EXPORT AGENT alice AS reviewer:', '    ABOUT  one', '    MANDATE  review']);
    write(join(teams, 'crew', 'bob.ap'), ['IMPORT reviewer, explorer FROM @main.roles', '', 'EXPORT AGENT bob AS reviewer, explorer:', '    ABOUT  two', '    MANDATE  map']);
    return buildOrchestrationContent({ cwd: root, standaloneAgentsDir: join(root, 'standalone'), teamsDir: teams, libraryRoots: [lib], libraries: { '@main': lib } });
  };
  await assert.rejects(team('reviewer'), /BY reviewer: `reviewer` is the role of alice, bob — name the agent/);
  has((await team('explorer')).content, 'bob');
  console.log('roles: BY <role> passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
