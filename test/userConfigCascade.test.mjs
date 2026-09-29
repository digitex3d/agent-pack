// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const { loadConfig, librariesAliasMap } = await import('../dist/src/config.js');

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

function writeUserConfig(userHome, value) {
  writeFileSync(join(userHome, 'config.json'), JSON.stringify(value), 'utf-8');
}

function writeProjectConfig(projectDir, source) {
  writeFileSync(join(projectDir, 'agent-pack.config.mjs'), source, 'utf-8');
}

// --- Inheritance + per-alias override + normalization + reserved @user + scalar inherit ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  writeUserConfig(userHome, {
    agentsDir: 'user-agents',
    sharedLibraries: [
      { alias: '@common', path: join(userHome, 'common-lib') },
      { alias: 'cc', path: join(userHome, 'cc-user') }, // unprefixed → normalizes to @cc
    ],
  });

  writeProjectConfig(projectDir, [
    'export default {',
    `  sharedLibraries: [`,
    `    { alias: '@cc', path: ${JSON.stringify(join(projectDir, 'cc-proj'))} },`, // overrides user @cc
    `    { alias: '@proj', path: ${JSON.stringify(join(projectDir, 'proj-lib'))} },`,
    '  ],',
    '}',
  ].join('\n'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    const map = librariesAliasMap(config);

    assert.equal(map['@main'], resolve(projectDir, 'library'), 'project library stays @main');
    assert.equal(map['@common'], resolve(userHome, 'common-lib'), 'user alias inherited without redeclaration');
    assert.equal(map['@cc'], resolve(projectDir, 'cc-proj'), 'project overrides the inherited alias by key');
    assert.equal(map['@proj'], resolve(projectDir, 'proj-lib'), 'project adds its own alias');
    assert.equal(map['@user'], resolve(userHome), 'reserved @user points at the user home');
    assert.equal(config.agentsDir, resolve(projectDir, 'user-agents'), 'scalar inherited from user when project omits it');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- Project scalar wins over user scalar (local over global) ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  writeUserConfig(userHome, { agentsDir: 'user-agents' });
  writeProjectConfig(projectDir, `export default { agentsDir: 'project-agents' }\n`);

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    assert.equal(config.agentsDir, resolve(projectDir, 'project-agents'), 'project scalar overrides user scalar');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- Backward compat: no user config.json → project-only behaviour, missing alias absent ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-')); // no config.json written
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));

  writeProjectConfig(projectDir, [
    'export default {',
    `  sharedLibraries: [{ alias: '@proj', path: ${JSON.stringify(join(projectDir, 'proj-lib'))} }],`,
    '}',
  ].join('\n'));

  await withUserHomeAndProject(userHome, projectDir, async () => {
    const config = await loadConfig([]);
    const map = librariesAliasMap(config);

    assert.equal(map['@proj'], resolve(projectDir, 'proj-lib'), 'project alias present');
    assert.equal(map['@common'], undefined, 'no user layer → no inherited alias');
    assert.equal(map['@nope'], undefined, 'a missing alias resolves to undefined');
    assert.equal(map['@user'], resolve(userHome), '@user stays reserved even without a user config');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// --- Malformed user config raises an explicit error (no silent handling) ---

{
  const userHome = mkdtempSync(join(tmpdir(), 'ap-userhome-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'ap-project-'));
  writeFileSync(join(userHome, 'config.json'), '{ not valid json', 'utf-8');

  await withUserHomeAndProject(userHome, projectDir, async () => {
    await assert.rejects(() => loadConfig([]), /Invalid JSON in user config/, 'malformed JSON throws explicitly');
  });

  rmSync(userHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log('User config cascade tests passed.');
