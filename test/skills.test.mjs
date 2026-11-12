// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

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
const { default: codexAdapter } = await import('../dist/adapters/codex/index.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-skills-'));
const prevCwd = process.cwd();
const write = (path, lines) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8'); return path; };

try {
  write(join(tmp, 'agent-pack.config.mjs'), ['export default {', "  libraryRoot: 'library',", "  agentsDir: 'agents',", '};']);
  write(join(tmp, 'library', 'skills', 'pdf-report.ap'), [
    'EXPORT SKILL pdf-report AS reporter:',
    '    ABOUT    turn a PDF into a short report',
    '    APPLIES  #reports',
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

  // --- codex: .agents/skills/<name>/SKILL.md ---
  {
    const { files } = await bundleAndEmit('pdf-report', config, codexAdapter(), ctx);
    const skill = files.find(f => f.path.endsWith('.agents/skills/pdf-report/SKILL.md'));
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
    const user = (imports, body = ['@WITH #skill:reports, pdf, anthropic-skills:xlsx:', '    DO read the files']) => write(join(tmp, 'agents', 'standalone', 'user.ap'), [
      ...imports, '',
      'EXPORT AGENT user AS helping:',
      '    ABOUT    uses skills',
      '    MANDATE  get the work done',
      ...body.map(l => `    ${l}`),
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
    assert.ok(md.includes('use a skill of this chapter wherever its scope line says it applies'), 'a skill holds where its scope says: the chapter says so');
    assert.ok(md.includes('Applies only to the work nested under a line that names it.'), 'each skill opens with its scope line');
    assert.equal(skills[0].tags.join(), 'reports', 'a library skill carries the tags of its APPLIES line');
    assert.ok(md.includes('run `node .agent-pack/apx/pdf-report.apx start`'), 'a library skill is loaded from its apx');
    assert.ok(md.includes('with the Skill tool: `anthropic-skills:xlsx`'), 'a harness skill in the adapter\'s words');
    assert.ok(!md.includes('quote every table as CSV'), 'the skill\'s own body stays in its apx');

    // without the adapter's words, the neutral ones
    const neutral = await bundleAndEmit('user', config, codexAdapter(), ctx);
    assert.ok(neutral.bundle.body.includes('it is a skill of your harness — `pdf`'), neutral.bundle.body);

    // like a policy: a skill no @WITH names and no perimeter brings applies nowhere
    user(['IMPORT pdf-report FROM @main.skills', 'IMPORT pdf FROM @harness.skills'], ['@WITH pdf:', '    DO read it']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /skill `pdf-report` applies nowhere/);
    // a perimeter on its APPLIES line makes it hold there with no @WITH
    write(join(tmp, 'library', 'skills', 'everywhere.ap'), [
      'EXPORT SKILL everywhere AS reporter:', '    ABOUT    always at hand', '    APPLIES  #reports, universal', '    MANDATE  help',
      '', 'EXPORT ROLE reporter:', '    ABOUT  a writer of reports', '    ALWAYS keep a report under one page',
    ]);
    user(['IMPORT everywhere FROM @main.skills'], ['MUST be kind']);
    assert.ok((await bundleAndEmit('user', config, claudeCodeAdapter(), ctx)).bundle.body.includes('Applies everywhere.'));
    rmSync(join(tmp, 'library', 'skills', 'everywhere.ap'));
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

  // --- @WITH is a decorator: the block below it, or the lines nested under `@WITH …:`, are under the skills and policies it names ---
  {
    write(join(tmp, 'library', 'templates', 'report.ap'), ['EXPORT TEMPLATE report:', '    ABOUT  a report', '    SLOTS:', '        summary: TEXT "what it says"', '    BODY:', '        {summary}']);
    write(join(tmp, 'library', 'procedures', 'design-page.ap'), [
      'IMPORT frontend-design:frontend-design FROM @harness.skills', '',
      'EXPORT PROCEDURE design-page:',
      '    ABOUT  design a page',
      '    @WITH frontend-design:frontend-design:',
      '        MUST pick an aesthetic direction before writing code',
    ]);
    write(join(tmp, 'library', 'policies', 'reasons-first.ap'), [
      'EXPORT POLICY reasons-first:',
      '    ABOUT    the developer reasons first',
      '    APPLIES  #decisions',
      '    ALWAYS   ask for the developer\'s solution first',
      '',
      'EXPORT POLICY careful:',
      '    ABOUT    be careful',
      '    APPLIES  #decisions',
      '    ALWAYS   double-check',
      '',
      'EXPORT POLICY baseline:',
      '    ABOUT    always on',
      '    APPLIES  #baseline, universal',
      '    NEVER    leak a secret',
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
      '@WITH pdf-report AS report:',
      '    IF the input is a text PDF:',
      '        MUST extract every table as CSV',
      '@WITH pdf',
      'WHEN asked to read a PDF:',
      '    DO read the PDF',
      'WHEN asked for a page:',
      '    RUN design-page',
    ]);
    const { bundle } = await bundleAndEmit('user', config, claudeCodeAdapter(), ctx);
    const md = bundle.body;
    const id = (name, kind = 'skill') => bundle.structure.byKind(kind).find(b => b.name === name).id;
    assert.ok(md.includes(`For the work below, use the skill \`pdf-report\` (${id('pdf-report')}) — shaped as \`report\` (${id('report', 'template')}):`), md);
    // above a block, it decorates that block
    assert.ok(md.includes(`For the work below, use the skill \`pdf\` (${id('pdf')}):\nWhen asked to read a PDF:`), md);
    // the zone is the nested lines: they render under the head
    assert.ok(/use the skill `pdf-report`[^\n]*:\n\s+[^\n]*text PDF/.test(md), md);
    // first in a procedure's body: the whole procedure, and the skill travels with it
    const proc = bundle.structure.byKind('procedure').find(b => b.name === 'design-page');
    assert.equal(proc.body[0].keyword, '@WITH', JSON.stringify(proc.body));
    assert.ok(md.includes(`For the work below, use the skill \`frontend-design:frontend-design\` (${id('frontend-design:frontend-design')}):`), md);

    // a policy by name, and by #tag — expanded to every imported policy with that tag on its APPLIES line
    user(['@WITH reasons-first:', '    DO weigh the options', '@WITH #policy:decisions, pdf, pdf-report:', '    DO pick one'], ['IMPORT reasons-first, careful, baseline FROM @main.policies']);
    {
      const { bundle } = await bundleAndEmit('user', config, claudeCodeAdapter(), ctx);
      const md = bundle.body;
      const pid = name => bundle.structure.byKind('policy').find(b => b.name === name).id;
      assert.ok(md.includes(`For the work below, use the policy \`reasons-first\` (${pid('reasons-first')}):`), md);
      assert.ok(md.includes(`For the work below, use the policy \`reasons-first\` (${pid('reasons-first')}), the policy \`careful\` (${pid('careful')}), the skill \`pdf\``), md);
      // each policy says where it applies
      assert.ok(md.includes('Applies only to the work nested under a line that names it.'), md);
      assert.ok(md.includes('Applies everywhere.'), md);
      assert.ok(md.includes('wherever its scope line says it applies'), md);
    }
    // a policy with no perimeter that no @WITH names applies nowhere: an error
    user(['@WITH reasons-first:', '    DO weigh the options'], ['IMPORT reasons-first, careful FROM @main.policies']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /policy `careful` applies nowhere/);
    // a tag no import carries selects nothing
    user(['@WITH #policy:nothing, pdf, pdf-report:', '    DO weigh the options']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /no imported policy has #nothing/);
    // a tag selects its kind only: #skill: never brings a policy
    user(['@WITH #skill:decisions, pdf, pdf-report:', '    DO weigh the options'], ['IMPORT reasons-first FROM @main.policies']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /no imported skill has #decisions/);
    // AS shapes the answer of one skill — never a policy's
    user(['@WITH reasons-first AS report:', '    DO weigh the options', '@WITH pdf, pdf-report:', '    DO read'], ['IMPORT reasons-first FROM @main.policies']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /`AS report` shapes the answer of one skill — this @WITH names the policy `reasons-first`/);

    // a name not imported is an unknown name
    user(['@WITH xlsx:', '    IF the input is a sheet:', '        MUST read it']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /`@WITH xlsx`: no imported skill, policy or dimension is called `xlsx`/);
    // the old forms say how to rewrite them
    user(['WITH pdf:', '    DO read it']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /WITH became a decorator — write `@WITH <names>`/);
    user(['!WITH pdf:', '    IF the input is a scan:', '        MUST run OCR']);
    await assert.rejects(() => bundleAndEmit('user', config, claudeCodeAdapter(), ctx), /!WITH was removed — a policy says where it holds with its APPLIES line/);
    {
      const { checkVocabulary } = await import('../dist/src/lint.js');
      const lint = lines => checkVocabulary('p.ap', ['IMPORT pdf FROM @harness.skills', '', ...lines].join('\n'));
      // a decorator decorates a block: above one, or opening one with lines nested below it
      assert.ok(lint(['EXPORT PROCEDURE p:', '    ABOUT  p', '    @WITH pdf', '    DO  work']).some(e => /`@WITH` decorates no block/.test(e.message)));
      assert.ok(lint(['EXPORT PROCEDURE p:', '    ABOUT  p', '    @WITH pdf:', '    DO  work']).some(e => /nothing is nested below it/.test(e.message)));
      // @WITH stands anywhere: above a definition it decorates all its work — a definition is decorated from above, never inside a decorator's block
      assert.deepEqual(lint(['@WITH pdf', 'EXPORT PROCEDURE p:', '    ABOUT  p', '    DO  work']), []);
      assert.ok(lint(['EXPORT AGENT a AS r:', '    ABOUT  a', '    MANDATE  m', '    @WITH pdf:', '        PROCEDURE p:', '            DO  work']).some(e => /holds PROCEDURE, a definition — .* write `@WITH …` right above the definition instead/.test(e.message)));
      // AS shapes one skill's answer
      assert.ok(lint(['EXPORT PROCEDURE p:', '    ABOUT  p', '    @WITH pdf, pdf-report AS report:', '        DO  work']).some(e => /AS shapes the answer of one skill/.test(e.message)));
      assert.deepEqual(lint(['EXPORT PROCEDURE p:', '    ABOUT  p', '    @WITH pdf, #policy:decisions:', '        DO  work']), []);
      // a tag says its kind, when the decorator names several
      assert.ok(lint(['EXPORT PROCEDURE p:', '    ABOUT  p', '    @WITH #decisions:', '        DO  work']).some(e => /a tag says which: `#<kind>:decisions`/.test(e.message)));
      // a perimeter goes on a policy or a skill only
      assert.ok(lint(['EXPORT TEMPLATE t:', '    ABOUT  t', '    APPLIES #x, universal']).some(e => /a perimeter .* goes on a POLICY or a SKILL — found on TEMPLATE/.test(e.message)));
      assert.ok(!lint(['EXPORT POLICY q:', '    ABOUT  q', '    APPLIES #x, team:delivery', '    ALWAYS  be q']).some(e => /perimeter/.test(e.message)));
    }
    rmSync(join(tmp, 'agents', 'standalone', 'user.ap'));
  }
  console.log('skills: @WITH tests passed.');

  // --- a standalone file reads @WITH the same way: a Skills chapter, its scope lines, errors where they were written ---
  {
    const { bundleStandaloneToString } = await import('../dist/src/compiler/index.js');
    const project = lines => write(join(tmp, 'standalone.ap'), lines);
    project([
      'ABOUT  project rules', '',
      'IMPORT pdf FROM @harness.skills',
      'IMPORT reasons-first FROM @main.policies', '',
      'PROCEDURE decide:',
      '  ABOUT  decide together',
      '  @WITH reasons-first, pdf:',
      '    DO  weigh the options', '',
      'WHEN a decision is due:',
      '  RUN decide',
    ]);
    const md = await bundleStandaloneToString(join(tmp, 'standalone.ap'), config);
    assert.ok(/^# Skills$/m.test(md), md);
    assert.ok(md.includes('Applies only to the work nested under a line that names it.'), md);
    assert.ok(/For the work below, use the policy `reasons-first` \(pol-[0-9a-f]{8}\) and the skill `pdf` \(skl-[0-9a-f]{8}\):/.test(md), md);
    assert.ok(md.includes('When a decision is due:'), 'a WHEN with lines beneath is the file\'s trigger');
    // a WHEN with nothing beneath stays header metadata
    project(['ABOUT  project rules', 'WHEN working in this repo:', '', 'IMPORT reasons-first FROM @main.policies', '', 'PROCEDURE decide:', '  ABOUT  d', '  @WITH reasons-first:', '    DO  weigh']);
    assert.ok(!(await bundleStandaloneToString(join(tmp, 'standalone.ap'), config)).includes('working in this repo'));
    // an unknown item of an imported procedure is reported where it was written
    write(join(tmp, 'library', 'procedures', 'broken.ap'), ['EXPORT PROCEDURE broken:', '    ABOUT  broken', '    @WITH nosuch:', '        DO  work']);
    project(['ABOUT  project rules', 'IMPORT broken FROM @main.procedures', '', 'WHEN asked:', '  RUN broken']);
    await assert.rejects(() => bundleStandaloneToString(join(tmp, 'standalone.ap'), config), /broken\.ap:3 {2}`@WITH nosuch`: no imported skill, policy or dimension is called `nosuch`/);
    rmSync(join(tmp, 'library', 'procedures', 'broken.ap'));
    // an AS naming no template fails here too
    project(['ABOUT  project rules', 'IMPORT pdf FROM @harness.skills', '', 'PROCEDURE p:', '  ABOUT  p', '  @WITH pdf AS nope:', '    DO  read']);
    await assert.rejects(() => bundleStandaloneToString(join(tmp, 'standalone.ap'), config), /`AS nope`: no imported template is called `nope`/);
    rmSync(join(tmp, 'standalone.ap'));
  }
  console.log('skills: standalone @WITH tests passed.');
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}
