// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the team-scoped shared block (`team.ap`).
 *
 * Covers the team-scoped shared-block injection mechanism:
 *   - resolveTeamShared: team member gets its team's team.ap (ABOUT stripped),
 *     standalone agent gets nothing, missing/empty team.ap is a no-op
 *   - Bundle integration: a team member's bundle carries its team.ap ahead of
 *     the agent's own content; a team without team.ap injects nothing
 *  */

import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { resolveTeamShared, TEAM_SHARED_FILE } = await import('../dist/src/bundleDefaults.js');
const { TEAM_FLOWS_FILE } = await import('../dist/src/services/teamMetadata.js');

/**
 * Build a flat team member `<root>/teams/<team>/<agent>.ap` and return its path.
 * Writes a `flows.ap` sibling so the directory is a genuine team —
 * `resolveTeamShared` gates on a sibling `flows.ap` to tell a real team apart
 * from a standalone agent.
 */
function makeTeamMember(root, team, agent) {
  const teamDir = teamRootOf(root, team);
  mkdirSync(teamDir, { recursive: true });
  const file = join(teamDir, `${agent}.ap`);
  writeFileSync(file, [`EXPORT AGENT ${agent} AS ${agent}-role:`, '  ABOUT a flat agent', '  MANDATE ship the change', '', `ROLE ${agent}-role:`, '  ABOUT a worker', '  ALWAYS ship the change', ''].join('\n'), 'utf-8');
  writeFileSync(join(teamDir, TEAM_FLOWS_FILE), 'ABOUT a test team\n', 'utf-8');
  return file;
}

function teamRootOf(root, team) {
  return join(root, 'teams', team);
}

// --------------------------------------------------------------------------
// resolveTeamShared
// --------------------------------------------------------------------------

{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-team-shared-'));
  try {
    const agentDir = makeTeamMember(tmp, 'dev', 'coder');
    writeFileSync(
      join(teamRootOf(tmp, 'dev'), TEAM_SHARED_FILE),
      ['ABOUT shared dev context', '', '# House rules', 'Ship small units.', ''].join('\n'),
      'utf-8',
    );

    const shared = resolveTeamShared(agentDir);
    assert.ok(shared.includes('# House rules'), 'team.ap body is injected');
    assert.ok(shared.includes('Ship small units.'), 'team.ap content preserved');
    assert.ok(!shared.includes('ABOUT shared dev context'), 'ABOUT stripped from injected block');
    assert.ok(shared.endsWith('\n\n'), 'injected block ends with a blank-line separator');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

{
  // Team member, no team.ap → no-op (empty string, no error)
  const tmp = mkdtempSync(join(tmpdir(), 'ap-team-noshared-'));
  try {
    const agentDir = makeTeamMember(tmp, 'dev', 'coder');
    assert.equal(resolveTeamShared(agentDir), '', 'missing team.ap is a no-op');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

{
  // Comment-only team.ap → injects nothing (the scaffolded stub is inert)
  const tmp = mkdtempSync(join(tmpdir(), 'ap-team-emptyshared-'));
  try {
    const agentDir = makeTeamMember(tmp, 'dev', 'coder');
    writeFileSync(join(teamRootOf(tmp, 'dev'), TEAM_SHARED_FILE), '# team.ap — comments only\n# nothing to inject\n', 'utf-8');
    assert.equal(resolveTeamShared(agentDir), '', 'comment-only team.ap injects nothing');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

{
  // Standalone agent (flat file with no sibling flows.ap) → never gets a shared block,
  // even when a stray team.ap sits beside it. The flows.ap gate, not a stray team.ap,
  // defines a team.
  const tmp = mkdtempSync(join(tmpdir(), 'ap-team-standalone-'));
  try {
    const dir = join(tmp, 'standalone');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'lonely.ap');
    writeFileSync(file, ['EXPORT AGENT lonely AS lonely-role:', '  ABOUT a lone agent', '  MANDATE go solo', ''].join('\n'), 'utf-8');
    writeFileSync(join(dir, TEAM_SHARED_FILE), '# stray\nshould not leak\n', 'utf-8');
    assert.equal(resolveTeamShared(file), '', 'standalone agent (no sibling flows.ap) receives no shared block');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

console.log('resolveTeamShared tests passed.');

// --------------------------------------------------------------------------
// Bundle integration
// --------------------------------------------------------------------------

{
  const { bundleAgentToString } = await import('../dist/src/compiler/index.js');

  // Team member: bundle carries the team.ap content ahead of the agent's own.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'ap-team-bundle-'));
    try {
      const agentFile = makeTeamMember(tmp, 'dev', 'coder');
      const libraryRoot = join(tmp, 'library');
      mkdirSync(libraryRoot);

      writeFileSync(join(teamRootOf(tmp, 'dev'), TEAM_SHARED_FILE),
        ['ABOUT dev team shared block', '', '# Mission', 'Keep the core lean.', ''].join('\n'), 'utf-8');

      const output = await bundleAgentToString({
        agentName: 'coder',
        agentFile: agentFile,
        agentDir: teamRootOf(tmp, 'dev'),
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      assert.ok(output.includes('Keep the core lean.'), "team.ap content present in member's bundle");
      assert.ok(!output.includes('ABOUT dev team shared block'), 'team.ap ABOUT stripped in bundle');
      const sharedIdx = output.indexOf('Keep the core lean.');
      const mandateIdx = output.indexOf('Your mandate: ship the change');
      assert.ok(sharedIdx !== -1 && mandateIdx !== -1 && sharedIdx < mandateIdx,
        "team.ap is injected ahead of the agent's own identity");
    } finally {
      rmSync(tmp, { recursive: true });
    }
  }

  // Team with no team.ap: bundle is unaffected (no-op).
  {
    const tmp = mkdtempSync(join(tmpdir(), 'ap-team-bundle-noop-'));
    try {
      const agentFile = makeTeamMember(tmp, 'dev', 'coder');
      const libraryRoot = join(tmp, 'library');
      mkdirSync(libraryRoot);

      const output = await bundleAgentToString({
        agentName: 'coder',
        agentFile: agentFile,
        agentDir: teamRootOf(tmp, 'dev'),
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      assert.ok(output.startsWith('Your mandate: ship the change') || output.includes('Your mandate: ship the change'),
        "absent team.ap leaves the bundle's leading content as the agent's own");
    } finally {
      rmSync(tmp, { recursive: true });
    }
  }

  console.log('Team-shared bundle integration tests passed.');
}
