// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

/**
 * A skill is an agent: an `EXPORT SKILL <name> AS <role>:` block in the
 * library, compiled like an agent — its own apx — and written by the adapter
 * as a skill of its harness instead of a subagent.
 */

const { loadConfig } = await import('../dist/src/config.js');
const { bundleAndEmit } = await import('../dist/src/bundlers/run.js');
const { discoverAgentsByWalk } = await import('../dist/src/agentDiscovery.js');
const { default: claudeCodeAdapter } = await import('../dist/adapters/claude-code/index.js');
const { default: claudeCodeApxAdapter } = await import('../dist/adapters/claude-code-apx/index.js');
const { default: junieAdapter } = await import('../dist/adapters/junie/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-skills-'));
const prevCwd = process.cwd();
const write = (path, lines) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, lines.join('\n') + '\n', 'utf-8'); return path; };

try {
  write(join(tmp, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", '};']);
  write(join(tmp, 'library', 'skills', 'pdf-report.ap'), [
    'EXPORT SKILL pdf-report AS reporter:',
    '    ABOUT    turn a PDF into a short report',
    '    MANDATE  read the PDF and report its tables',
    '    VAR pages',
    '    DO  count the pages INTO pages',
    '    MUST quote every table as CSV',
    '',
    'EXPORT ROLE reporter:',
    '    ABOUT  a writer of reports',
    '    ALWAYS keep a report under one page',
  ]);
  write(join(tmp, 'agents', 'standalone', 'helper.ap'), [
    'EXPORT AGENT helper AS helping:',
    '    ABOUT    helps',
    '    MANDATE  help',
    '',
    'EXPORT ROLE helping:',
    '    ABOUT  a helper',
    '    ALWAYS help kindly',
  ]);

  process.chdir(tmp);
  const config = await loadConfig([]);
  const ctx = { projectRoot: tmp, outputDir: join(tmp, '.agent-pack', 'compiled') };

  // --- discovered with the agents: a library skill is built by `bundle all` ---
  assert.deepEqual(discoverAgentsByWalk(config).map(a => a.name).sort(), ['helper', 'pdf-report']);

  // --- claude-code: .claude/skills/<name>/SKILL.md, the compiled definition under the skill frontmatter ---
  {
    const { bundle, files } = await bundleAndEmit('pdf-report', config, claudeCodeAdapter(), ctx);
    assert.equal(bundle.kind, 'skill');
    const skill = files.find(f => f.path.endsWith('.claude/skills/pdf-report/SKILL.md'));
    assert.ok(skill, files.map(f => f.path).join('\n'));
    assert.ok(skill.content.startsWith('---\nname: pdf-report\ndescription: turn a PDF into a short report\n---\n'), skill.content);
    assert.ok(skill.content.includes('read the PDF and report its tables'), 'the mandate is carried');
    assert.ok(skill.content.includes('quote every table as CSV'), 'the rules are carried');
    assert.ok(!files.some(f => f.path.includes('.claude/agents/')), 'a skill is no subagent');
    assert.ok(files.some(f => f.path.endsWith('.agent-pack/apx/pdf-report.apx')), 'a skill gets its apx, like an agent');
  }

  // --- claude-code-apx: the SKILL.md names the skill's apx ---
  {
    const { files } = await bundleAndEmit('pdf-report', config, claudeCodeApxAdapter(), ctx);
    const skill = files.find(f => f.path.endsWith('.claude/skills/pdf-report/SKILL.md'));
    assert.ok(skill.content.startsWith('---\nname: pdf-report\n'), skill.content);
    assert.ok(skill.content.includes('node .agent-pack/apx/pdf-report.apx start'), skill.content);
  }

  // --- junie: .junie/skills/<name>/SKILL.md ---
  {
    const { files } = await bundleAndEmit('pdf-report', config, junieAdapter(), ctx);
    const skill = files.find(f => f.path.endsWith('.junie/skills/pdf-report/SKILL.md'));
    assert.ok(skill && skill.content.includes('description: turn a PDF into a short report'), files.map(f => f.path).join('\n'));
  }

  // --- a path to the skill's file builds the same skill ---
  {
    const { bundle } = await bundleAndEmit(join(tmp, 'library', 'skills', 'pdf-report.ap'), config, claudeCodeAdapter(), ctx);
    assert.equal(bundle.kind, 'skill');
    assert.equal(bundle.name, 'pdf-report');
  }

  console.log('skills: compile tests passed.');

  // --- an agent IMPORTs skills: FROM the library (its apx) or FROM @harness.skills (the harness's own) ---
  {
    const user = (imports) => write(join(tmp, 'agents', 'standalone', 'user.ap'), [
      ...imports, '',
      'EXPORT AGENT user AS helping:',
      '    ABOUT    uses skills',
      '    MANDATE  get the work done',
      '',
      'EXPORT ROLE helping:',
      '    ABOUT  a helper',
      '    ALWAYS help kindly',
    ]);
    user(['IMPORT pdf-report FROM @main.skills', 'IMPORT pdf, anthropic-skills:xlsx FROM @harness.skills']);
    const { bundle, files } = await bundleAndEmit('user', config, claudeCodeAdapter(), ctx);
    const skills = bundle.structure.byKind('skill');
    assert.deepEqual(skills.map(b => b.name), ['pdf-report', 'pdf', 'anthropic-skills:xlsx']);
    assert.equal(skills[0].about, 'turn a PDF into a short report', 'a library skill carries its ABOUT');
    assert.equal(skills[1].namespace, '@harness.skills');
    const md = files.find(f => f.path.endsWith('.claude/agents/user.md')).content;
    assert.ok(/^# (\d+\. )?Skills$/m.test(md), md);
    assert.ok(md.includes('use a skill of this chapter whenever you judge it fits the task'), 'free to use: the chapter says so');
    assert.ok(md.includes('run `node .agent-pack/apx/pdf-report.apx start`'), 'a library skill is loaded from its apx');
    assert.ok(md.includes('with the Skill tool: `anthropic-skills:xlsx`'), 'a harness skill in the adapter\'s words');
    assert.ok(!md.includes('quote every table as CSV'), 'the skill\'s own body stays in its apx');

    // without the adapter's words, the neutral ones
    const neutral = await bundleAndEmit('user', config, junieAdapter(), ctx);
    assert.ok(neutral.bundle.body.includes('it is a skill of your harness — `pdf`'), neutral.bundle.body);

    // @harness holds skills only
    user(['IMPORT pdf FROM @harness.templates']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /@harness holds only skills/);
    // a skill FROM the library must be a SKILL block
    write(join(tmp, 'library', 'skills', 'not-a-skill.ap'), ['EXPORT PROCEDURE not-a-skill:', '    ABOUT  a procedure', '    DO  something']);
    user(['IMPORT not-a-skill FROM @main.skills']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /`not-a-skill` is no SKILL block/);
    rmSync(join(tmp, 'library', 'skills', 'not-a-skill.ap'));
    rmSync(join(tmp, 'agents', 'standalone', 'user.ap'));
  }
  console.log('skills: import tests passed.');

  // --- WITH decorates a block: the skill is for that work, and only that work; !WITH keeps it out ---
  {
    write(join(tmp, 'library', 'templates', 'report.ap'), ['EXPORT TEMPLATE report:', '    ABOUT  a report', '    SLOTS:', '        summary: TEXT "what it says"', '    BODY:', '        {summary}']);
    write(join(tmp, 'library', 'procedures', 'design-page.ap'), [
      'IMPORT frontend-design:frontend-design FROM @harness.skills', '',
      'WITH frontend-design:frontend-design',
      'EXPORT PROCEDURE design-page:',
      '    ABOUT  design a page',
      '    MUST pick an aesthetic direction before writing code',
    ]);
    const user = (body, imports = []) => write(join(tmp, 'agents', 'standalone', 'user.ap'), [
      'IMPORT pdf-report FROM @main.skills', 'IMPORT pdf FROM @harness.skills', 'IMPORT report FROM @main.templates', 'IMPORT design-page FROM @main.procedures', ...imports, '',
      'EXPORT AGENT user AS helping:',
      '    ABOUT    uses skills',
      '    MANDATE  get the work done',
      ...body.map(l => `    ${l}`),
      '',
      'EXPORT ROLE helping:',
      '    ABOUT  a helper',
      '    ALWAYS help kindly',
    ]);
    user([
      'WITH pdf-report AS report',
      'IF the input is a text PDF:',
      '    MUST extract every table as CSV',
      '!WITH pdf',
      'IF the input is a scanned image:',
      '    MUST run OCR with the project script',
      'WHEN asked for a page:',
      '    RUN design-page',
    ]);
    const { bundle } = await bundleAndEmit('user', config, claudeCodeAdapter(), ctx);
    const md = bundle.body;
    const id = name => bundle.structure.byKind('skill').find(b => b.name === name).id;
    assert.ok(md.includes(`Use the skill \`pdf-report\` (${id('pdf-report')}) for the work below — shaped as \`report\``), md);
    assert.ok(md.includes(`Do not use the skill \`pdf\` (${id('pdf')}) for the work below`), md);
    // above an exported block: the decorator opens its body — the whole procedure
    const proc = bundle.structure.byKind('procedure').find(b => b.name === 'design-page');
    assert.equal(proc.body[0].keyword, 'WITH', JSON.stringify(proc.body));
    assert.ok(md.includes(`Use the skill \`frontend-design:frontend-design\` (${id('frontend-design:frontend-design')}) for the work below`), md);

    // a skill not imported is an unknown name
    user(['WITH xlsx', 'IF the input is a sheet:', '    MUST read it']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /unknown skill `xlsx` — IMPORT it FROM @main\.skills, or FROM @harness\.skills/);
    // a decorator decorates something
    user(['MUST be kind', 'WITH pdf', 'MUST be quick']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /`WITH pdf` decorates the block on the very next line/);
    // a skill not used has no answer to shape
    user(['!WITH pdf AS report', 'IF the input is a scan:', '    MUST run OCR']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /a skill not used has no answer to shape/);
    // a decorator sits on the very line above its block: a blank line or a comment between leaves it decorating nothing
    {
      const { checkVocabulary } = await import('../dist/src/lint.js');
      for (const gap of ['', '# a note']) {
        const errors = checkVocabulary('p.ap', ['IMPORT pdf FROM @harness.skills', '', 'WITH pdf', gap, 'EXPORT PROCEDURE p:', '    ABOUT  p', '    DO  work'].join('\n'));
        assert.ok(errors.some(e => e.line === 3 && /decorates the block on the very next line/.test(e.message)), JSON.stringify(errors));
      }
      assert.deepEqual(checkVocabulary('p.ap', ['IMPORT pdf FROM @harness.skills', '', 'WITH pdf', 'EXPORT PROCEDURE p:', '    ABOUT  p', '    DO  work'].join('\n')), []);
    }
    // first in the body: the whole agent
    user(['WITH pdf', 'MUST be kind']);
    assert.ok((await bundleAndEmit('user', config, claudeCodeAdapter(), ctx)).bundle.body.includes('Use the skill `pdf`'));
    rmSync(join(tmp, 'agents', 'standalone', 'user.ap'));
  }
  console.log('skills: WITH tests passed.');
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}
