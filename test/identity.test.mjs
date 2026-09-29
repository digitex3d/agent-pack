// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for the ROLE / EXPERTISE / MANDATE agent-level identity primitives.
 *
 * Covers:
 *   - renderIdentityBlock: all combinations of ROLE / EXPERTISE / MANDATE
 *   - lintAgent: missing required fields, duplicates, forbidden fields in other kinds
 *   - Bundle integration: round-trip from agent.ap with identity fields
 */

import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --------------------------------------------------------------------------
// renderIdentityBlock
// --------------------------------------------------------------------------

const { renderIdentityBlock } = await import('../dist/src/primitives.js');

{
  // All three fields present
  const meta = new Map([
    ['ROLE', ['senior backend developer']],
    ['EXPERTISE', ['nodejs python go']],
    ['MANDATE', ['build scalable secure systems without breaking what works']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(block.includes('# Identity'), 'contains # Identity heading');
  assert.ok(block.includes('**senior backend developer**'), 'ROLE is bold');
  assert.ok(block.includes('**nodejs**'), 'nodejs is bold');
  assert.ok(block.includes('**python**'), 'python is bold');
  assert.ok(block.includes('**go**'), 'go is bold');
  assert.ok(block.includes('**nodejs**, **python**, **go**'), 'expertise items joined with comma+space');
  assert.ok(!block.includes(' and **go**'), 'last expertise item has no "and"');
  assert.ok(block.includes('Your mandate: build scalable secure systems without breaking what works'), 'mandate plain text');
  assert.ok(block.endsWith('\n'), 'block ends with trailing newline');
}

{
  // No EXPERTISE
  const meta = new Map([
    ['ROLE', ['product manager']],
    ['MANDATE', ['turn user problems into working software']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(block.includes('You are: **product manager**.'), 'ROLE rendered without expertise line');
  assert.ok(!block.includes('expertise in'), 'no expertise line when absent');
  assert.ok(block.includes('Your mandate: turn user problems into working software'));
}

{
  // Arbitrary source order — MANDATE declared before ROLE in the Map
  const meta = new Map([
    ['MANDATE', ['keep the system alive']],
    ['ROLE', ['site reliability engineer']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(block.includes('You are: **site reliability engineer**.'), 'ROLE line always comes first');
  // The mandate line follows
  const roleIdx = block.indexOf('You are a');
  const mandateIdx = block.indexOf('Your mandate:');
  assert.ok(roleIdx < mandateIdx, 'ROLE appears before MANDATE in rendered output');
}

{
  // Single-item expertise (no comma needed)
  const meta = new Map([
    ['ROLE', ['data scientist']],
    ['EXPERTISE', ['python']],
    ['MANDATE', ['find signal in noise']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(block.includes('expertise in **python**'), 'single expertise item is bold and not followed by comma');
}

{
  // Neither ROLE nor MANDATE → no block emitted
  const meta = new Map();
  const block = renderIdentityBlock(meta);
  assert.equal(block, '', 'empty metadata produces empty string');
}

{
  // Only ROLE, no MANDATE → still emits a block (partial; lint reports the missing MANDATE)
  const meta = new Map([['ROLE', ['analyst']]]);
  const block = renderIdentityBlock(meta);
  assert.ok(block.includes('# Identity'), 'block emitted even with ROLE only');
  assert.ok(!block.includes('Your mandate:'), 'no mandate line when absent');
}

{
  // ROLE-ABOUT folds into the "You are a" line, between role and expertise.
  const meta = new Map([
    ['ROLE', ['software architect']],
    ['ROLE-ABOUT', ['a software architect who keeps the system legible']],
    ['EXPERTISE', ['plantuml system-design']],
    ['MANDATE', ['keep diagrams current']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(
    block.includes('You are: **software architect** — a software architect who keeps the system legible — with expertise in **plantuml**, **system-design**.'),
    'ABOUT folds between role and expertise',
  );
}

{
  // ROLE-ABOUT without EXPERTISE closes the about fragment with a period.
  const meta = new Map([
    ['ROLE', ['reviewer']],
    ['ROLE-ABOUT', ['a careful post-implementation reviewer']],
    ['MANDATE', ['review every change']],
  ]);
  const block = renderIdentityBlock(meta);
  assert.ok(
    block.includes('You are: **reviewer** — a careful post-implementation reviewer.'),
    'ABOUT without expertise closes with a period',
  );
}

{
  // The bound role's behaviours are appended after the mandate, verbatim.
  const meta = new Map([
    ['ROLE', ['simplifier']],
    ['MANDATE', ['reduce to essence']],
  ]);
  const behaviours = 'ALWAYS  prefer the simpler solution\nNEVER   over-engineer';
  const block = renderIdentityBlock(meta, behaviours);
  const mandateIdx = block.indexOf('Your mandate:');
  const behaviourIdx = block.indexOf('ALWAYS  prefer the simpler solution');
  assert.ok(behaviourIdx > mandateIdx, 'role behaviours follow the mandate');
  assert.ok(block.includes('NEVER   over-engineer'), 'all behaviour lines carried verbatim');
}

console.log('renderIdentityBlock tests passed.');

// --------------------------------------------------------------------------
// lintAgent
// --------------------------------------------------------------------------

const { lintPolicy, lintPlaybook, lintProcedure, lintRole, lintTemplate } = await import('../dist/src/lint.js');

{
  // EXPERTISE in policy.ap must be rejected — it belongs to the role now
  const errs = lintPolicy('coding.policy.ap', '# coding\nABOUT test\nEXPERTISE nodejs\nALWAYS write tests\n');
  assert.ok(errs.some(e => /EXPERTISE is only allowed in a role/.test(e.message)), 'EXPERTISE rejected in policy.ap');
}

{
  // MANDATE in policy.ap must be rejected — it is the agent's own directive (EXPORT AGENT block)
  const errs = lintPolicy('coding.policy.ap', '# coding\nABOUT test\nMANDATE do things\nALWAYS write tests\n');
  assert.ok(errs.some(e => /MANDATE is only allowed inside an EXPORT AGENT block/.test(e.message)), 'MANDATE rejected in policy.ap');
}

{
  // EXPERTISE in playbook.ap must be rejected
  const errs = lintPlaybook('review.playbook.ap', '# review\nWHEN review requested\nEXPERTISE nodejs\nDO review the code\n');
  assert.ok(errs.some(e => /EXPERTISE is only allowed in a role/.test(e.message)), 'EXPERTISE rejected in playbook.ap');
}

{
  // EXPERTISE in procedure.ap must be rejected
  const errs = lintProcedure('setup.procedure.ap', '# setup\nPROCEDURE setup\n  DO step one\nEXPERTISE nodejs\n');
  assert.ok(errs.some(e => /EXPERTISE is only allowed in a role/.test(e.message)), 'EXPERTISE rejected in procedure.ap');
}

{
  // A `.role.ap` file: the ROLE block opener + EXPERTISE + behaviours lint clean.
  const errs = lintRole('simplifier.role.ap', '# simplifier\nROLE simplifier:\n  ABOUT a lean role\n  EXPERTISE typescript\n  ALWAYS remove dead code\n');
  assert.equal(errs.length, 0, 'role file with ROLE block + EXPERTISE lints clean');
}

{
  // Duplicate EXPERTISE in role.ap is rejected (cardinality at most 1).
  const errs = lintRole('simplifier.role.ap', '# simplifier\nROLE simplifier:\n  ABOUT a role\n  EXPERTISE one\n  EXPERTISE two\n  ALWAYS remove dead code\n');
  assert.ok(errs.some(e => /2 occurrences of EXPERTISE/.test(e.message)), 'duplicate EXPERTISE rejected in role.ap');
}

{
  // EXPERTISE in template.ap must be rejected
  const errs = lintTemplate('bug-report.template.ap', '# bug-report\nTEMPLATE bug-report\nEXPERTISE nodejs\n');
  assert.ok(errs.some(e => /EXPERTISE is only allowed in a role/.test(e.message)), 'EXPERTISE rejected in template.ap');
}

console.log('identity cross-kind lint tests passed.');

// --------------------------------------------------------------------------
// lintAgentBlocks — first-class `AGENT <name> AS <role>:` inline blocks
// --------------------------------------------------------------------------
{
  const { lintAgentBlocks } = await import('../dist/src/lint.js');

  // Valid block: AS header + MANDATE child → no errors.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  MANDATE keep it lean\n');
    assert.equal(errs.length, 0, 'valid AGENT block lints clean');
  }

  // HARD error: ROLE inside an AGENT block points back to the role.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  MANDATE x\n  ROLE senior engineer\n');
    assert.ok(
      errs.some(e => /ROLE is not allowed inside an AGENT block/.test(e.message)),
      'ROLE inside AGENT block is a HARD error',
    );
  }

  // HARD error: EXPERTISE inside an AGENT block.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  MANDATE x\n  EXPERTISE typescript\n');
    assert.ok(errs.some(e => /EXPERTISE is not allowed inside an AGENT block/.test(e.message)), 'EXPERTISE rejected in AGENT block');
  }

  // HARD error: TAGS inside an AGENT block.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  MANDATE x\n  TAGS #foo\n');
    assert.ok(errs.some(e => /TAGS is not allowed inside an AGENT block/.test(e.message)), 'TAGS rejected in AGENT block');
  }

  // Missing AS header → error.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl:\n  MANDATE x\n');
    assert.ok(errs.some(e => /requires an `AS <role>` binding/.test(e.message)), 'missing AS rejected');
  }

  // Missing MANDATE → error.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  ABOUT just an about\n');
    assert.ok(errs.some(e => /requires a MANDATE/.test(e.message)), 'missing MANDATE rejected');
  }

  // Child keyword outside the allowed surface → error.
  {
    const errs = lintAgentBlocks('team.ap', 'AGENT impl AS simplifier:\n  MANDATE x\n  PROCEDURE foo\n');
    assert.ok(errs.some(e => /PROCEDURE is not allowed inside AGENT/.test(e.message)), 'disallowed child rejected');
  }

  console.log('lintAgentBlocks tests passed.');
}

// --------------------------------------------------------------------------
// Bundle integration: round-trip from agent.ap with identity fields
// --------------------------------------------------------------------------

{
  const { bundleAgentToString } = await import('../dist/src/compiler/index.js');

  const tmp = mkdtempSync(join(tmpdir(), 'ap-identity-'));

  try {
    const agentDir = join(tmp, 'my-agent');
    mkdirSync(agentDir);
    const libraryRoot = join(tmp, 'library');
    mkdirSync(libraryRoot);

    // NEW contract: identity (the ROLE block name + EXPERTISE + behaviours) lives
    // in the bound role; the agent declares AS + MANDATE. The bundle must fuse the
    // role's identity into the `# Identity` block. The block name IS the role, so
    // its de-slugified form ("backend engineer") is the display role.
    const agentFile = join(agentDir, 'my-agent.ap');
    writeFileSync(agentFile, [
      'EXPORT AGENT my-agent AS backend-engineer:',
      '    ABOUT      a test agent for identity block integration',
      '    MANDATE    build scalable secure systems without breaking what works',
      '    OWNS       src/**',
      '',
      'EXPORT ROLE backend-engineer:',
      '    ABOUT      a senior backend developer who ships secure systems',
      '    EXPERTISE  nodejs python go',
      '    ALWAYS     keep the system secure',
      '',
    ].join('\n'), 'utf-8');

    const output = await bundleAgentToString({
      agentName: 'my-agent',
      agentFile,
      agentDir,
      libraryRoot,
      libraryRoots: [libraryRoot],
      bundleConfig: { runtime: false },
    });

    // Identity block must be present
    assert.ok(output.includes('# Identity'), 'Identity section present in bundle');
    assert.ok(output.includes('**backend engineer**'), 'de-slugified role display is bold in bundle');
    assert.ok(output.includes('a senior backend developer who ships secure systems'), 'role ABOUT folded into Identity');
    assert.ok(output.includes('You must always keep the system secure'), 'role behaviour fused into Identity');
    assert.ok(output.includes('**nodejs**'), 'nodejs expertise bold in bundle');
    assert.ok(output.includes('**python**'), 'python expertise bold in bundle');
    assert.ok(output.includes('**go**'), 'go expertise bold in bundle');
    assert.ok(output.includes('Your mandate: build scalable secure systems without breaking what works'), 'mandate in bundle');

    // OWNS scope warning must appear before Identity block (OWNS is a leading fence)
    const ownsIdx = output.indexOf('SCOPE — WARNING');
    const identityIdx = output.indexOf('# Identity');
    if (ownsIdx !== -1) {
      assert.ok(ownsIdx < identityIdx, 'OWNS scope fence appears before Identity block');
    }

    // Identity block must come before any `# 1.` rule sections that may follow
    // (no rule sections in this minimal bundle, but the identity block itself
    // must not be at the very end)
    assert.ok(identityIdx !== -1, 'Identity block found in output');

    // Primitive keywords must be stripped from the body
    assert.ok(!/^ROLE\s/m.test(output), 'ROLE keyword stripped from body');
    assert.ok(!/^EXPERTISE\s/m.test(output), 'EXPERTISE keyword stripped from body');
    assert.ok(!/^MANDATE\s/m.test(output), 'MANDATE keyword stripped from body');

  } finally {
    rmSync(tmp, { recursive: true });
  }

  // Round-trip without EXPERTISE
  {
    const tmp2 = mkdtempSync(join(tmpdir(), 'ap-identity-noexp-'));
    try {
      const agentDir = join(tmp2, 'lean-agent');
      mkdirSync(agentDir);
      const libraryRoot = join(tmp2, 'library');
      mkdirSync(libraryRoot);

      const agentFile = join(agentDir, 'lean-agent.ap');
      writeFileSync(agentFile, [
        'EXPORT AGENT lean-agent AS product-manager:',
        '    MANDATE    turn user problems into shipped features',
        '',
        'EXPORT ROLE product-manager:',
        '    ABOUT      a product manager who ships value',
        '    ALWAYS     ship value',
        '',
      ].join('\n'), 'utf-8');

      const output = await bundleAgentToString({
        agentName: 'lean-agent',
        agentFile,
        agentDir,
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      assert.ok(output.includes('You are: **product manager** — a product manager who ships value.'), 'role + ABOUT rendered without expertise in bundle');
      assert.ok(!output.includes('expertise in'), 'no expertise line in no-EXPERTISE bundle');
      assert.ok(output.includes('Your mandate: turn user problems into shipped features'), 'mandate present');
    } finally {
      rmSync(tmp2, { recursive: true });
    }
  }

  // An agent with no role and no MANDATE must not emit an Identity block and must not throw
  {
    const tmp3 = mkdtempSync(join(tmpdir(), 'ap-identity-legacy-'));
    try {
      const agentDir = join(tmp3, 'legacy-agent');
      mkdirSync(agentDir);
      const libraryRoot = join(tmp3, 'library');
      mkdirSync(libraryRoot);

      const agentFile = join(agentDir, 'legacy-agent.ap');
      writeFileSync(agentFile, [
        'EXPORT AGENT legacy-agent:',
        '    ABOUT  agent without identity fields',
        '',
      ].join('\n'), 'utf-8');

      const output = await bundleAgentToString({
        agentName: 'legacy-agent',
        agentFile,
        agentDir,
        libraryRoot,
        libraryRoots: [libraryRoot],
        bundleConfig: { runtime: false },
      });

      // No Identity block for legacy agents
      assert.ok(!output.includes('# Identity'), 'no Identity block for legacy agent without ROLE/MANDATE');
    } finally {
      rmSync(tmp3, { recursive: true });
    }
  }

  console.log('Bundle identity integration tests passed.');
}
