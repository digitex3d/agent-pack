// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A block in its own library file compiles like the same block written in the
 * agent's file: a procedure's LENS-IN, a bare ELSE in a role's WHEN, a role's
 * IMPORTs. And a team's flows render the reads of its vars.ap in AGENTS.md.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { lintProcedure, lintRole } = await import('../dist/src/lint.js');
const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { buildOrchestrationContent } = await import('../dist/src/orchestrationSection.js');
const { apxPath } = await import('../dist/src/apx/paths.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-library-units-'));
const write = (path, lines) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [...lines, ''].join('\n'));
};

try {
  // --- A procedure file takes LENS-IN, its input contract ---
  const procedure = ['EXPORT PROCEDURE p:', '    ABOUT    do p', '    LENS-IN  inp', '    DO       answer'].join('\n');
  assert.deepEqual(lintProcedure('procedures/p.ap', procedure).map(e => e.message), [], 'LENS-IN in a procedure file');

  // --- A role file takes a bare ELSE under its WHEN's IF ---
  const role = [
    'EXPORT ROLE r:', '    ABOUT  a role', '    WHEN asked to x:', '        IF  the input is empty',
    '          DO  ask for input', '        ELSE', '          DO  answer',
  ].join('\n');
  assert.deepEqual(lintRole('roles/r.ap', role).map(e => e.message), [], 'bare ELSE in a role file');
  const orphan = ['EXPORT ROLE r:', '    ABOUT  a role', '    WHEN asked to x:', '        DO  answer', '        ELSE', '          DO  ask'].join('\n');
  assert.ok(lintRole('roles/r.ap', orphan).some(e => /ELSE must follow an IF/.test(e.message)), 'an ELSE without its IF still fails');

  // --- A role's IMPORTs bring their blocks in, and leave no line behind ---
  const lib = join(tmp, 'library');
  write(join(lib, 'templates', 'comp.ap'), ['EXPORT TEMPLATE comp:', '    ABOUT  a component', '    SLOTS:', '        name  text  the name', '    BODY:', '        name: {name}']);
  write(join(lib, 'policies', 'pol.ap'), ['EXPORT POLICY pol:', '    ABOUT   a policy', '    ALWAYS  be careful']);
  write(join(lib, 'roles', 'builder.ap'), [
    'IMPORT comp FROM @main.templates', '', 'EXPORT ROLE builder:', '    ABOUT   a builder',
    '    IMPORT pol FROM @main.policies', '    ALWAYS  answer as comp',
  ]);
  const compile = async (name, lines) => {
    const file = join(tmp, `${name}.ap`);
    write(file, lines);
    return bundleAgentObject({ agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], libraries: { '@main': lib }, bundleConfig: { runtime: false } });
  };
  const kinds = compiled => compiled.structure.all().map(b => b.kind);
  const imported = await compile('a', ['IMPORT builder FROM @main.roles', '', 'EXPORT AGENT a AS builder:', '    ABOUT  an agent']);
  assert.ok(!/IMPORT/.test(imported.body), 'no IMPORT line left in the body');
  assert.ok(kinds(imported).includes('template') && kinds(imported).includes('policy'), "the role's imports are in the agent");
  const inline = await compile('b', ['EXPORT AGENT b AS own:', '    ABOUT  an agent', '', 'ROLE own:', '    ABOUT    its own role', '    EXTENDS  builder', '    ALWAYS   be fast']);
  assert.ok(!/IMPORT/.test(inline.body), 'an inline role leaves no IMPORT of its parent');
  assert.ok(kinds(inline).includes('template') && kinds(inline).includes('policy'), "the parent's imports are in the agent");

  // --- A team's flows render its constants and variables in AGENTS.md ---
  const team = join(tmp, 'teams', 't');
  write(join(team, 'vars.ap'), ['VAR source-url = https://example.org/data', 'SESSION VAR notes']);
  write(join(team, 'flows.ap'), [
    'ABOUT  a team', '', 'WHEN asked to fetch:', '    RUN fetch', '',
    'FLOW fetch:', '    STEP fetch the source:', '        BY m', '        DO download {{source-url}} into {{notes}}',
  ]);
  write(join(team, 'm.ap'), ['EXPORT AGENT m AS mr:', '    ABOUT  a member', '', 'ROLE mr:', '    ABOUT   a member', '    ALWAYS  be exact']);
  const { content } = await buildOrchestrationContent({
    cwd: tmp, standaloneAgentsDir: join(tmp, 'standalone'), teamsDir: join(tmp, 'teams'), libraryRoots: [lib], libraries: { '@main': lib },
  });
  assert.ok(content.includes('download https://example.org/data'), "a constant's read is its value");
  assert.ok(content.includes(`\`notes\` (read its value: \`node ${apxPath('m')} get notes\`)`), "a variable's read says how to read it");
  assert.ok(!content.includes('{{'), 'no read left as written');

  console.log('Library unit tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
