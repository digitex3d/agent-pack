// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The opencode adapter — out, its agents in `.opencode/agents/<name>.md`; in,
 * its recipe: `opencode run --agent`, the answer filtered out of the JSON
 * events, with the permissions opencode refused on its own.
 */

const { default: opencodeAdapter, agentMarkdown } = await import('../dist/adapters/opencode/index.js');
const { readInvocation } = await import('../dist/src/harnesses.js');
const { fill } = await import('../dist/src/formulas.js');

// --- an agent: the description quoted in the frontmatter, the instructions as body ---
{
  const bundle = { name: 'hunter', kind: 'agent', body: '# hunter\n\nTrace every path.', metadata: new Map([['ABOUT', ['traces paths: every one']]]) };
  assert.equal(agentMarkdown(bundle), '---\ndescription: "traces paths: every one"\n---\n# hunter\n\nTrace every path.\n');
  const [file] = opencodeAdapter().emitters.agent(bundle, { projectRoot: '/p', outputDir: '/p/out' });
  assert.equal(file.path, '/p/.opencode/agents/hunter.md');
  assert.equal(opencodeAdapter({ agentsDir: 'x/agents' }).emitters.agent(bundle, { projectRoot: '/p', outputDir: '/p/out' })[0].path, '/p/x/agents/hunter.md');
}

// --- the recipe: read like every other, no shape, no intro ---
const read = readInvocation(opencodeAdapter());
assert.ok('invocation' in read, JSON.stringify(read));
const inv = read.invocation;
assert.equal(inv.cli, 'opencode');
assert.deepEqual(inv.carry, ['.opencode/agents/{agent}.md', 'AGENTS.md']);
assert.equal(inv.shape, undefined);
assert.equal(inv.intro, undefined);
assert.ok(inv.command.startsWith('opencode run --agent {agent} --dir {project} --format json < {prompt}'), inv.command);
assert.ok(!inv.command.includes('--auto'), 'permissions are never approved on their own');
assert.ok(inv.command.endsWith('> {answer}'), inv.command);

// --- the filter: only the answer text, then the refused permissions ---
{
  const tmp = mkdtempSync(join(tmpdir(), 'ap-opencode-'));
  try {
    const events = join(tmp, 'events.txt');
    const answer = join(tmp, 'answer.txt');
    writeFileSync(events, [
      JSON.stringify({ type: 'step_start', part: {} }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }),
      '\x1b[33;1m!\x1b[0m permission requested: external_directory (/etc/*); auto-rejecting',
      JSON.stringify({ type: 'text', part: { text: 'Found two ' } }),
      'some log line',
      JSON.stringify({ type: 'text', part: { text: 'unhandled paths.' } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: {} } }),
      '',
    ].join('\n'));
    // The recipe with `opencode run …` swapped for a cat of the events: the rest of the line runs as written.
    const line = fill(inv.command, { agent: 'hunter', project: tmp, prompt: events, answer })
      .replace(/^opencode run .*? < (\S+)/, 'cat $1');
    execFileSync('sh', ['-c', line]);
    const { readFileSync } = await import('fs');
    assert.equal(readFileSync(answer, 'utf-8'),
      'Found two unhandled paths.\n\nPermissions opencode refused on its own, for the harness that launched it to decide on:\n- external_directory (/etc/*)\n');

    writeFileSync(events, JSON.stringify({ type: 'text', part: { text: 'All clear.' } }) + '\n');
    execFileSync('sh', ['-c', line]);
    assert.equal(readFileSync(answer, 'utf-8'), 'All clear.', 'no permission refused: the answer alone');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('opencode: adapter tests passed.');
