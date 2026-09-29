// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const { loadConfig } = await import('../dist/src/config.js');
const { resolveAgentFile, bundleAgentFromConfig } = await import('../dist/src/compiler/index.js');
const { discoverAgentsByWalk } = await import('../dist/src/agentDiscovery.js');

/** Run `fn` with AGENT_PACK_HOME and cwd set, restoring both afterwards. */
async function withUserHomeAndProject(userHome, projectDir, fn) {
  const prevHome = process.env.AGENT_PACK_HOME;
  const prevCwd = process.cwd();
  process.env.AGENT_PACK_HOME = userHome;
  process.chdir(projectDir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.AGENT_PACK_HOME;
    else process.env.AGENT_PACK_HOME = prevHome;
  }
}

function agentSource(name, about) {
  return [
    `# ${name}`,
    '',
    `EXPORT AGENT ${name} AS worker:`,
    `    ABOUT    ${about}`,
    `    MANDATE  do the assigned work`,
    '',
    'ROLE worker:',
    '    ABOUT      a generic worker',
    '    ALWAYS  do the work',
    '',
  ].join('\n');
}

// --- Global (user home) agents resolve by name and appear in the discovery walk ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  // Global layout: agents flat under <home>/agents, team members under <home>/teams/<team>/.
  mkdirSync(join(userHome, 'agents'), { recursive: true });
  writeFileSync(join(userHome, 'agents', 'global-pm.ap'), agentSource('global-pm', 'Global product manager'));
  mkdirSync(join(userHome, 'teams', 'forge'), { recursive: true });
  writeFileSync(join(userHome, 'teams', 'forge', 'flows.ap'), '# forge\n\nABOUT a global team\n');
  writeFileSync(join(userHome, 'teams', 'forge', 'scout.ap'), agentSource('scout', 'Global team member'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);

    const standalone = resolveAgentFile('global-pm', config);
    assert.equal(standalone, resolve(userHome, 'agents', 'global-pm.ap'), 'global standalone agent resolves to the user home file');

    const member = resolveAgentFile('scout', config);
    assert.equal(member, resolve(userHome, 'teams', 'forge', 'scout.ap'), 'global team member resolves to its team dir');

    const names = discoverAgentsByWalk(config).map(a => a.name);
    assert.ok(names.includes('global-pm'), 'discovery walk includes global standalone agents');
    assert.ok(names.includes('scout'), 'discovery walk includes global team members');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- Precedence: a project agent shadows a global namesake ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  mkdirSync(join(userHome, 'agents'), { recursive: true });
  writeFileSync(join(userHome, 'agents', 'pm.ap'), agentSource('pm', 'Global variant'));
  mkdirSync(join(projectDir, 'agents', 'standalone'), { recursive: true });
  writeFileSync(join(projectDir, 'agents', 'standalone', 'pm.ap'), agentSource('pm', 'Project variant'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    const src = resolveAgentFile('pm', config);
    assert.equal(src, resolve(projectDir, 'agents', 'standalone', 'pm.ap'), 'project agent shadows the global namesake');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- Absent user home stays harmless: unknown agent falls back to the project path ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-')); // no agents/ inside
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    const src = resolveAgentFile('nope', config);
    assert.equal(src, resolve(projectDir, 'agents', 'standalone', 'nope.ap'), 'fallback still reports the conventional project path');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- EXTENDS across roots: a project role extends a role living in the user home ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  mkdirSync(join(userHome, 'roles'), { recursive: true });
  writeFileSync(join(userHome, 'roles', 'product-manager.ap'), [
    '# product-manager',
    '',
    'EXPORT ROLE product-manager:',
    '    ABOUT      a product manager who tracks all work through the project tracker',
    '    ALWAYS  record every unit of work in the tracker before it starts',
    '',
  ].join('\n'));

  mkdirSync(join(projectDir, 'library', 'roles'), { recursive: true });
  writeFileSync(join(projectDir, 'library', 'roles', 'linear-pm.ap'), [
    '# linear-pm',
    '',
    'EXPORT ROLE linear-pm:',
    '    ABOUT    a product manager whose tracker is Linear',
    '    EXTENDS  product-manager',
    '    MUST  use the Linear MCP tools as the tracker',
    '',
  ].join('\n'));

  mkdirSync(join(projectDir, 'agents', 'standalone'), { recursive: true });
  writeFileSync(join(projectDir, 'agents', 'standalone', 'pm.ap'), [
    '# pm',
    '',
    'IMPORT  linear-pm  FROM @main.roles',
    '',
    'EXPORT AGENT pm AS linear-pm:',
    '    ABOUT    Product manager tracking all work in Linear',
    '    MANDATE  plan and track every unit of work through the tracker',
    '',
  ].join('\n'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    const bundle = await bundleAgentFromConfig('pm', config);

    assert.ok(!bundle.includes('MISSING EXTENDS'), 'parent role in the user home resolves (no MISSING EXTENDS marker)');
    assert.ok(bundle.includes('record every unit of work in the tracker'), 'parent (global) rules are inherited');
    assert.ok(bundle.includes('use the Linear MCP tools as the tracker'), 'child (project) rules are kept');
    assert.ok(
      bundle.indexOf('record every unit of work') < bundle.indexOf('use the Linear MCP tools'),
      'parent rules render before the child\'s (additive concatenation)',
    );
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log('User home agent resolution tests passed.');
