// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the per-member team-membership section (`# Your team`).
 *
 * The upward counterpart to the orchestration section: each team member's
 * bundle gets an awareness of the team it belongs to (name, purpose, its own
 * responsibility, and the fellow members), placed first as foundational
 * context. Standalone agents get nothing.
 *
 *   - resolveTeamMembership: team member gets the section (name, purpose, own
 *     ABOUT, fellows excluding itself); standalone agent gets ''; a single
 *     member team renders no `Fellow members:` block
 *   - Bundle integration: a team member's bundle carries the `# Your team`
 *     section ahead of the agent's own content
 */

import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { resolveTeamMembership } = await import('../dist/src/services/teamMembership.js');

/** Write a flat team-member agent file `<root>/teams/<team>/<agent>.ap` and return its path. */
function makeTeamMember(root, team, agent, about) {
  const teamDir = join(root, 'teams', team);
  mkdirSync(teamDir, { recursive: true });
  const file = join(teamDir, `${agent}.ap`);
  writeFileSync(
    file,
    [`EXPORT AGENT ${agent} AS ${agent}-role:`, `  ABOUT  ${about}`, '  MANDATE  do the work', '', `ROLE ${agent}-role:`, '  ABOUT  a worker', '  ALWAYS do the work', ''].join('\n'),
    'utf-8',
  );
  return file;
}

/** Write the team's flows.ap so the team purpose (its ABOUT) is discoverable. */
function writeTeamFlows(root, team, purpose) {
  writeFileSync(
    join(root, 'teams', team, 'flows.ap'),
    [`# ${team}`, `ABOUT  ${purpose}`, ''].join('\n'),
    'utf-8',
  );
}

// --------------------------------------------------------------------------
// resolveTeamMembership — multi-member team
// --------------------------------------------------------------------------

{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-membership-'));
  try {
    const selfDir = makeTeamMember(tmp, 'dev', 'senior-typescript', 'owns the agent-pack core');
    makeTeamMember(tmp, 'dev', 'architect', 'maintains the architecture diagrams');
    makeTeamMember(tmp, 'dev', 'dry-keeper', 'post-implementation DRY review');
    writeTeamFlows(tmp, 'dev', 'agent-pack core development team');

    const section = resolveTeamMembership(selfDir);

    assert.ok(section.includes('# Your team'), 'heading present');
    assert.ok(
      section.includes('You are `senior-typescript`, a member of the team `dev` (purpose: agent-pack core development team).'),
      'identity line carries agent, team, and team purpose',
    );
    assert.ok(
      section.includes('Within the team you handle: owns the agent-pack core.'),
      "member's own ABOUT rendered as its responsibility",
    );
    assert.ok(section.includes('Fellow members:'), 'fellow-members block present');
    assert.ok(section.includes('· architect — maintains the architecture diagrams'), 'fellow architect listed');
    assert.ok(section.includes('· dry-keeper — post-implementation DRY review'), 'fellow dry-keeper listed');
    assert.ok(
      !section.includes('· senior-typescript —'),
      'the agent itself is NOT listed among fellows',
    );
    assert.ok(
      section.includes("Requests are routed to the team by an orchestrator; stay within your responsibility, don't bypass routing."),
      'closing line verbatim',
    );
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// --------------------------------------------------------------------------
// resolveTeamMembership — single-member team omits the Fellow members block
// --------------------------------------------------------------------------

{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-membership-solo-'));
  try {
    const selfDir = makeTeamMember(tmp, 'solo', 'only-one', 'the sole member');
    writeTeamFlows(tmp, 'solo', 'a one-person team');

    const section = resolveTeamMembership(selfDir);

    assert.ok(section.includes('# Your team'), 'heading present for solo team');
    assert.ok(!section.includes('Fellow members:'), 'no Fellow members block when alone');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

// --------------------------------------------------------------------------
// resolveTeamMembership — standalone agent gets nothing
// --------------------------------------------------------------------------

{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-membership-standalone-'));
  try {
    const dir = join(tmp, 'standalone');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'lonely.ap');
    writeFileSync(file, ['EXPORT AGENT lonely AS lonely-role:', '  ABOUT  a lone agent', '  MANDATE  go solo', '', 'ROLE lonely-role:', '  ABOUT  a loner', '  ALWAYS go solo', ''].join('\n'), 'utf-8');

    assert.equal(resolveTeamMembership(file), '', 'standalone agent (no sibling flows.ap) receives no membership section');
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

console.log('resolveTeamMembership tests passed.');

// --------------------------------------------------------------------------
// Bundle integration
// --------------------------------------------------------------------------

{
  const { bundleAgentToString } = await import('../dist/src/compiler/index.js');

  // Team member: bundle carries the `# Your team` section ahead of the agent's own.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'ap-membership-bundle-'));
    try {
      const agentFile = makeTeamMember(tmp, 'dev', 'coder', 'ships the change');
      makeTeamMember(tmp, 'dev', 'reviewer', 'reviews the change');
      writeTeamFlows(tmp, 'dev', 'the dev team');
      const libraryRoot = join(tmp, 'library');
      mkdirSync(libraryRoot);

      const output = await bundleAgentToString({
        agentName: 'coder',
        agentFile: agentFile,
        agentDir: join(tmp, 'teams', 'dev'),
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      assert.ok(output.includes('# Your team'), "membership section present in member's bundle");
      assert.ok(output.includes('a member of the team `dev` (purpose: the dev team)'), 'team purpose injected');
      assert.ok(output.includes('· reviewer — reviews the change'), 'fellow member listed');
      assert.ok(!output.includes('· coder —'), 'the member itself is not listed among fellows');

      const teamIdx = output.indexOf('# Your team');
      const mandateIdx = output.indexOf('Your mandate: do the work');
      assert.ok(teamIdx !== -1 && mandateIdx !== -1 && teamIdx < mandateIdx,
        "membership section is injected ahead of the agent's own identity");
    } finally {
      rmSync(tmp, { recursive: true });
    }
  }

  // Standalone agent: bundle has no `# Your team` section.
  {
    const tmp = mkdtempSync(join(tmpdir(), 'ap-membership-bundle-standalone-'));
    try {
      const dir = join(tmp, 'standalone');
      mkdirSync(dir, { recursive: true });
      const agentFile = join(dir, 'lonely.ap');
      writeFileSync(agentFile,
        ['EXPORT AGENT lonely AS lonely-role:', '  ABOUT  a lone agent', '  MANDATE  go solo', '', 'ROLE lonely-role:', '  ABOUT  a loner', '  ALWAYS go solo', ''].join('\n'), 'utf-8');
      const libraryRoot = join(tmp, 'library');
      mkdirSync(libraryRoot);

      const output = await bundleAgentToString({
        agentName: 'lonely',
        agentFile: agentFile,
        agentDir: dir,
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      assert.ok(!output.includes('# Your team'), 'standalone bundle has no membership section');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  }

  console.log('Team-membership bundle integration tests passed.');
}
