// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { AgentInfo, readTeamMembers, readTeamPurpose, teamRootForAgentFile, agentNameOf } from './teamMetadata.js';
import { basename } from 'path';
import { FORMULAS, fill } from '../formulas.js';

/**
 * The upward, per-member counterpart to the orchestration section. The
 * orchestration section is the orchestrator's downward view of every team; this
 * is one member's upward awareness of the single team it belongs to: who it is
 * within the team, what it owns, and which siblings share the work.
 *
 * Generated from the same `.ap` source the orchestration section reads (team
 * purpose = `flows.ap` ABOUT, members = agent files sibling of `flows.ap`), via
 * the shared {@link readTeamMembers} / {@link readTeamPurpose} reader — no
 * second parser. Always-on for team members; a standalone agent (no sibling
 * `flows.ap`) gets nothing.
 */

const TEAM = FORMULAS.blocks.team;

/** `· <name> — <about>` for one fellow member. */
function fellowLine(member: AgentInfo): string {
  return fill(TEAM.fellow, { name: member.name, about: member.about || TEAM.undescribed });
}

/**
 * Compose the `# Your team` membership section for one agent, given its `.ap`
 * file path. Returns '' for a standalone agent (no sibling `flows.ap`) — the
 * section is injected only into agents that belong to a team.
 *
 * The agent itself is excluded from the fellow-members list; when it is the
 * team's only member the `Fellow members:` block is omitted entirely.
 */
export function resolveTeamMembership(agentFilePath: string): string {
  const teamRoot = teamRootForAgentFile(agentFilePath);
  if (!teamRoot) return '';

  const agentName = agentNameOf(agentFilePath);
  const teamName = basename(teamRoot);
  const purpose = readTeamPurpose(teamRoot) || TEAM.undescribed;
  const members = readTeamMembers(teamRoot);

  const self = members.find(m => m.name === agentName);
  const own = self?.about || TEAM.undescribed;
  const fellows = members.filter(m => m.name !== agentName);

  const lines = [
    TEAM.heading,
    '',
    fill(TEAM.member, { agent: agentName, team: teamName, purpose }),
    fill(TEAM.handles, { about: own }),
  ];
  if (fellows.length > 0) {
    lines.push(TEAM.fellows, ...fellows.map(fellowLine));
  }
  lines.push(TEAM.closing);

  return `${lines.join('\n')}\n\n`;
}
