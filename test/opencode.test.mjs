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
 * events, with the permissions opencode refused on its own; the model of each
 * BUDGET tier, from the config (`{ name: 'opencode', models: { … } }`).
 */

const { default: opencodeAdapter, agentMarkdown } = await import('../dist/adapters/opencode/index.js');
const { readInvocation } = await import('../dist/src/harnesses.js');
const { fill } = await import('../dist/src/formulas.js');
const { resolveAdapter } = await import('../dist/src/adapter-registry.js');
const { agentModels, modelProblem, harnessesOf } = await import('../dist/src/harnesses.js');
const FREE = 'opencode/deepseek-v4.1-flash-free';

// --- an agent: the description quoted in the frontmatter, the instructions as body ---
{
  const bundle = { name: 'hunter', kind: 'agent', body: '# hunter\n\nTrace every path.', metadata: new Map([['ABOUT', ['traces paths: every one']]]) };
  assert.equal(agentMarkdown(bundle), '---\ndescription: "traces paths: every one"\n---\n# hunter\n\nTrace every path.\n');
  const [file] = opencodeAdapter().emitters.agent(bundle, { projectRoot: '/p', outputDir: '/p/out' });
  assert.equal(file.path, '/p/.opencode/agents/hunter.md');
  assert.equal(opencodeAdapter({ agentsDir: 'x/agents' }).emitters.agent(bundle, { projectRoot: '/p', outputDir: '/p/out' })[0].path, '/p/x/agents/hunter.md');

  // An agent's BUDGET tier, mapped by the config: its `model` in the frontmatter; unmapped, or no tier: none.
  const cheap = { ...bundle, structure: { root: () => ({ budget: 'cheap' }) } };
  assert.equal(agentMarkdown(cheap, { cheap: FREE }), `---\ndescription: "traces paths: every one"\nmodel: "${FREE}"\n---\n# hunter\n\nTrace every path.\n`);
  assert.ok(!agentMarkdown(cheap, { costly: FREE }).includes('model:'), 'a tier mapped to none: opencode picks its default');
  assert.ok(!agentMarkdown(bundle, { cheap: FREE }).includes('model:'), 'no tier: opencode picks its default');
  assert.ok(opencodeAdapter({ models: { cheap: FREE } }).emitters.agent(cheap, { projectRoot: '/p', outputDir: '/p/out' })[0].content.includes(`model: "${FREE}"`));
}

// --- the config: a built-in by name, or with its options — models checked against the BUDGET tiers ---
{
  assert.equal(resolveAdapter('opencode').models, undefined, 'opencode maps no tier of its own');
  assert.deepEqual(resolveAdapter({ name: 'opencode', models: { cheap: FREE } }).models, { cheap: FREE });
  assert.deepEqual(resolveAdapter('claude-code').models, { cheap: 'haiku', moderate: 'sonnet', costly: 'opus' }, 'claude-code keeps its own mapping');
  assert.deepEqual(resolveAdapter({ name: 'claude-code', models: { costly: 'opus[1m]' } }).models, { cheap: 'haiku', moderate: 'sonnet', costly: 'opus[1m]' }, 'the config maps over it');
  assert.throws(() => resolveAdapter({ name: 'opencode', models: { premium: FREE } }), /`premium` is no BUDGET tier — the tiers: cheap, moderate, costly/);
  assert.throws(() => resolveAdapter({ name: 'opencode', models: { cheap: '' } }), /models\.cheap must be a model id/);
  assert.throws(() => resolveAdapter({ name: 'opencode', models: [FREE] }), /models map each BUDGET tier to a model/);
  assert.throws(() => resolveAdapter({ name: 'nowhere' }), /Unknown adapter "nowhere"/);

  // The model of each agent on a harness: its tier's — an agent without one, or with a tier mapped to none, left out; a warning names the gap.
  const rows = harnessesOf([resolveAdapter({ name: 'opencode', models: { cheap: FREE } })], '');
  const row = rows.find(r => r.name === 'opencode');
  const agents = [{ name: 'fixer', budget: 'cheap' }, { name: 'thinker', budget: 'costly' }, { name: 'plain' }];
  assert.deepEqual(agentModels(row, agents), { fixer: FREE });
  assert.equal(modelProblem('opencode', agents[0], rows), null);
  assert.equal(modelProblem('opencode', agents[2], rows), null, 'no tier declared: nothing to warn about');
  assert.match(modelProblem('opencode', agents[1], rows), /`thinker` declares BUDGET costly, and opencode maps no model to it — it runs on opencode's own default model; .*models: \{ costly: '<model>' \}/);
}

// --- the recipe: read like every other, no shape, no intro ---
const read = readInvocation(opencodeAdapter());
assert.ok('invocation' in read, JSON.stringify(read));
const inv = read.invocation;
assert.equal(inv.cli, 'opencode');
assert.deepEqual(inv.carry, ['.opencode/agents/{agent}.md', 'AGENTS.md']);
assert.equal(inv.shape, undefined);
assert.equal(inv.intro, undefined);
assert.equal(inv.model, '--model {model}', 'the model the agent\'s tier maps to reaches the CLI as --model');
assert.ok(inv.command.startsWith('opencode run {model} --agent {agent} --dir {project} --format json < {prompt}'), inv.command);
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
    const line = fill(inv.command, { agent: 'hunter', project: tmp, prompt: events, answer, model: `--model ${FREE}` })
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
