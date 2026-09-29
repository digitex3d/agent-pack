// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * MEM — "remember this event, to act on it directly next time". A force-level
 * family (`!MEM` never, `MEM` may, `MEM!` should, `MEM!!` must always), usable
 * wherever a rule is; an `AS <template>` line beneath gives the memory a shape.
 * The phrase is neutral unless the adapter renders it (Claude Code: its agent
 * memory, with `memory: project` in the frontmatter).
 */
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { bundleAgentObject } = await import('../dist/src/compiler/index.js');
const { renderTree } = await import('../dist/src/bundlers/renderTree.js');
const { default: claudeCodeAdapter } = await import('../dist/adapters/claude-code/index.js');
const { buildAgentFrontmatter } = await import('../dist/adapters/claude-code/emitters/agent-md.js');
const { AgentBundle } = await import('../dist/adapters/types.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-mem-'));
const lib = join(tmp, 'library');
mkdirSync(lib);

function agentFile(name, lines) {
  const file = join(tmp, `${name}.ap`);
  writeFileSync(file, lines.join('\n'));
  return file;
}
async function compile(name, file, adapter) {
  return bundleAgentObject({ agentName: name, agentFile: file, agentDir: tmp, libraryRoot: lib, libraryRoots: [lib], bundleConfig: { runtime: false }, adapter });
}
function frontmatter(name, compiled) {
  return buildAgentFrontmatter(Object.assign(new AgentBundle(), { name, metadata: compiled.metadata, structure: compiled.structure }), '*');
}

try {
  const file = agentFile('rev', [
    'EXPORT AGENT rev AS rev-role:',
    '    ABOUT     reviews',
    '    MEM!!     the user rejects a finding as intended behaviour',
    '    MEM!      a source turns out unreliable',
    '    MEM       the user states a preference on the report length',
    '    !MEM      credentials, tokens or secrets',
    '    WHEN asked to review:',
    '        DO    read the diff',
    '        MEM   the confirmed project profile',
    '            AS report',
    '',
    'ROLE rev-role:',
    '    ABOUT  a reviewer',
    '    MEM!!  a convention the user asks to follow',
    '',
    'TEMPLATE report:',
    '    ABOUT  a report',
    '    SLOTS:',
    '        v: TEXT "verdict"',
    '    BODY:',
    '        {v}',
    '',
  ]);

  // --- neutral phrases, one per level, in the agent and in its role ---
  const neutral = await compile('rev', file);
  const md = neutral.body;
  assert.ok(md.includes('You must always save to your persistent memory, to act on it directly next time: the user rejects a finding as intended behaviour'), 'MEM!! = must always');
  assert.ok(md.includes('You should save to your persistent memory, to act on it directly next time: a source turns out unreliable'), 'MEM! = should');
  assert.ok(md.includes('You may save to your persistent memory, to act on it directly next time: the user states a preference on the report length'), 'MEM = may');
  assert.ok(md.includes('Never save to your persistent memory: credentials, tokens or secrets'), '!MEM = never');
  assert.ok(md.includes('You must always save to your persistent memory, to act on it directly next time: a convention the user asks to follow'), 'MEM in a role');

  // --- AS beneath MEM shapes the memory, never the answer ---
  const tplId = neutral.structure.all().find(b => b.kind === 'template' && b.name === 'report').id;
  assert.ok(md.includes(`You may save to your persistent memory, to act on it directly next time: the confirmed project profile — shaped as \`report\` (${tplId})`), 'the shape folds into the MEM line');
  assert.equal(neutral.structure.root().shape, null, "the agent's own answer shape is untouched");

  // --- the flows path (AGENTS.md) folds the shape the same way ---
  const flowLine = renderTree(`MEM!!  the finding the user rejected\n    AS \`report\` (${tplId})`);
  assert.equal(flowLine, `You must always save to your persistent memory, to act on it directly next time: the finding the user rejected — shaped as \`report\` (${tplId})`);

  // --- Claude Code: its agent memory, and memory: project in the frontmatter ---
  const cc = await compile('rev', file, claudeCodeAdapter());
  assert.ok(cc.body.includes('You must always save to your agent memory, to act on it directly next time: the user rejects a finding as intended behaviour'), 'Claude Code renders its own memory');
  assert.ok(cc.body.includes('Never save to your agent memory: credentials, tokens or secrets'));
  assert.ok(frontmatter('rev', cc).includes('memory: project'), 'an agent that remembers gets memory: project');

  // --- an agent that only forbids remembering, or never mentions it, gets no memory ---
  const never = agentFile('quiet', ['EXPORT AGENT quiet AS quiet-role:', '    ABOUT  quiet', '    !MEM   credentials', '', 'ROLE quiet-role:', '    ABOUT  quiet', '']);
  assert.ok(!frontmatter('quiet', await compile('quiet', never, claudeCodeAdapter())).includes('memory:'), '!MEM alone needs no memory');

  console.log('MEM tests passed.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
