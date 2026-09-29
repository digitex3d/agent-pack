// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * claude-code-apx: same file, same frontmatter as claude-code — a different
 * body. The agent's .md carries the agent's own definition, in the same words
 * as claude-code, then points at its apx for the rest.
 */

const { loadConfig } = await import('../dist/src/config.js');
const { bundleAndEmit } = await import('../dist/src/bundlers/run.js');
const { default: claudeCodeAdapter } = await import('../dist/adapters/claude-code/index.js');
const { default: claudeCodeApxAdapter } = await import('../dist/adapters/claude-code-apx/index.js');
const { ApxEngine } = await import('../dist/src/apx/engine.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-claude-code-apx-'));
const prevCwd = process.cwd();

try {
  const standalone = join(tmp, 'agents', 'standalone');
  mkdirSync(standalone, { recursive: true });
  writeFileSync(
    join(standalone, 'note-keeper.ap'),
    [
      'EXPORT AGENT note-keeper AS keeper:',
      '    ABOUT    keeps short notes',
      '    MANDATE  keep one note per topic and answer from them',
      '',
      'EXPORT ROLE keeper:',
      '    ABOUT  a keeper of notes',
      '    ALWAYS file a note under one topic',
      '',
    ].join('\n'),
    'utf-8',
  );

  process.chdir(tmp);
  const config = await loadConfig([]);
  config.adapters = [claudeCodeAdapter(), claudeCodeApxAdapter()];
  const [claudeCode, apx] = config.adapters;
  const ctx = { projectRoot: tmp, outputDir: join(tmp, '.agent-pack', 'compiled') };

  const native = await bundleAndEmit('note-keeper', config, claudeCode, ctx);
  const stub = await bundleAndEmit('note-keeper', config, apx, ctx);

  const nativeFile = native.files.find(f => f.path.endsWith('.claude/agents/note-keeper.md'));
  const stubFile = stub.files.find(f => f.path.endsWith('.claude/agents/note-keeper.md'));
  assert.ok(nativeFile && stubFile, 'both adapters write .claude/agents/<name>.md');

  const frontmatter = s => s.split('\n---\n')[0];
  assert.equal(frontmatter(stubFile.content), frontmatter(nativeFile.content), 'frontmatter is identical to claude-code');

  assert.ok(stubFile.content.includes('node .agent-pack/apx/note-keeper.apx start'), 'body points at the apx');
  // The body carries the agent's own definition in the md projection's words — the text
  // `apx get <agent>` prints — and leaves the rest to the apx.
  const body = stubFile.content.split('\n---\n')[1];
  const exe = '.agent-pack/apx/note-keeper.apx';
  const got = [];
  new ApxEngine(stub.bundle.structure, { builtAt: '', agentPackVersion: '', hash: '' }, exe, l => got.push(l)).run(['get', stub.bundle.structure.root().id]);
  const definition = got.join('\n').split('\n# agent note-keeper ')[0];
  assert.ok(body.trimStart().startsWith(definition.trimEnd()), 'the body opens with the definition apx get prints');
  assert.ok(body.includes('keep one note per topic and answer from them'), 'the mandate is carried');
  assert.ok(nativeFile.content.includes(definition.split('\n').find(l => l.includes('keep one note per topic'))),
    'in the same words as the claude-code agent file');

  // every agent gets its apx beside the harness files, whatever the adapter
  const apxFile = native.files.find(f => f.path.endsWith('.agent-pack/apx/note-keeper.apx'));
  assert.ok(apxFile, 'bundle writes .agent-pack/apx/<name>.apx');
  assert.ok(native.files.some(f => f.path.endsWith('.agent-pack/apx/package.json')), 'with the package.json that runs it as CommonJS');

  console.log('claude-code-apx adapter: passed.');
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}
