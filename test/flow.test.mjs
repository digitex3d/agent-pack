// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for FLOW primitive: lint (generic block-contracts + file-level invariants)
 * and bundle integration.
 *
 * Parser-specific tests (parseFlowFile, FlowEntry fields) are removed: the
 * generic file.ts collect pipeline handles flow files without a custom parser.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { lintFlow, lintPolicy, checkVocabulary } = await import('../dist/src/lint.js');

// ---------------------------------------------------------------------------
// 1. Lint OK: well-formed TDD flow passes with zero errors
// ---------------------------------------------------------------------------

{
  const tdd = `# tdd

ABOUT     Test-Driven Development: tester writes failing test, dev implements, tester verifies
APPLIES      #flow, #tdd

FLOW tdd
  STEP tester:
    RUN write-failing-test
  STEP developer:
    DELEGATE make the test pass BY dev
  STEP tester:
    RUN verify-and-refactor
`;

  const errors = lintFlow('tdd.flow.ap', tdd);
  const realErrors = errors.filter(e => e.severity !== 'warning');
  assert.equal(realErrors.length, 0, `valid TDD flow should have no errors, got: ${JSON.stringify(realErrors)}`);

  console.log('Flow lint OK test passed.');
}

// ---------------------------------------------------------------------------
// 2. Lint missing ABOUT
// ---------------------------------------------------------------------------

{
  const noAbout = `# tdd

FLOW tdd
  STEP tester:
    RUN write-failing-test
`;

  const errors = lintFlow('tdd.flow.ap', noAbout);
  assert.ok(errors.some(e => /ABOUT/.test(e.message)), 'missing ABOUT produces lint error');

  console.log('Flow lint missing ABOUT test passed.');
}

// ---------------------------------------------------------------------------
// 3. Lint missing FLOW block
// ---------------------------------------------------------------------------

{
  const noFlow = `# tdd

ABOUT  test
`;

  const errors = lintFlow('tdd.flow.ap', noFlow);
  assert.ok(errors.some(e => /flow has no FLOW block/.test(e.message)), 'missing FLOW block produces lint error');

  console.log('Flow lint missing FLOW block test passed.');
}

// ---------------------------------------------------------------------------
// 4. Lint multiple FLOW blocks
// ---------------------------------------------------------------------------

{
  const twoFlows = `# tdd

ABOUT  test

FLOW tdd
  STEP tester:
    RUN step-one

FLOW other
  STEP tester:
    RUN step-two
`;

  const errors = lintFlow('tdd.flow.ap', twoFlows);
  assert.ok(errors.some(e => /flow has 2 FLOW blocks/.test(e.message)), 'multiple FLOW blocks produces lint error');

  console.log('Flow lint multiple FLOW blocks test passed.');
}

// ---------------------------------------------------------------------------
// 5. Block contract: STEP body without DO/RUN
// ---------------------------------------------------------------------------

{
  const noAction = `# no-action

ABOUT  step without action

FLOW no-action
  STEP first:
    RUN step-one
  STEP second:
    MUST be quick
`;

  const errors = lintFlow('no-action.flow.ap', noAction);
  assert.ok(
    errors.some(e => /STEP block requires at least one of: DO, DELEGATE, COMPUTE, FORK, WAIT, MARK, EACH, RUN/.test(e.message)),
    `step without DO/RUN produces contract error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint STEP without DO/RUN test passed.');
}

// ---------------------------------------------------------------------------
// 6. A step names no one: BY, CONTEXT and AS are its DELEGATE's
// ---------------------------------------------------------------------------

{
  const old = `# old-step

ABOUT  a step written the old way

FLOW old-step
  STEP review:
    BY bob
    CONTEXT summary
    AS brief
    ASK check it INTO notes BY carol
    DO check it
`;
  const contract = lintFlow('old-step.flow.ap', old).map(e => `${e.line}: ${e.message}`);
  assert.ok(contract.some(m => m.startsWith('7: BY is not allowed inside STEP — a step names no one')), contract.join('\n'));
  assert.ok(contract.some(m => m.startsWith('9: AS is not allowed inside STEP — a step hands nothing over itself')), contract.join('\n'));
  const words = checkVocabulary('old-step.flow.ap', old).map(e => `${e.line}: ${e.message}`);
  assert.ok(words.some(m => m.startsWith('8: CONTEXT was removed — the form of a DELEGATE says the context')), words.join('\n'));
  // ASK is an agent's question: a step hands the work over with DELEGATE.
  assert.ok(contract.some(m => m.startsWith('10: ASK is not allowed inside STEP')), contract.join('\n'));
  // Each said once: a removed keyword is the vocabulary check's alone.
  assert.ok(!contract.some(m => /CONTEXT/.test(m)), contract.join('\n'));

  console.log('Flow lint old step signature test passed.');
}

// ---------------------------------------------------------------------------
// 7. DELEGATE, FORK, `~` and WAIT — the lines of a step, in their order
// ---------------------------------------------------------------------------

{
  const errs = (...lines) => checkVocabulary('d.flow.ap', ['FLOW d', '  STEP s:', ...lines.map(l => `    ${l}`), ''].join('\n'))
    .map(e => `${e.line}: ${e.message}`);
  assert.deepEqual(errs('DELEGATE review it INTO notes BY bob AS! brief', 'DELEGATE~ trace it INTO paths BY carol', 'FORK~ wire it INTO wired', 'WAIT paths, wired'), []);
  assert.deepEqual(errs('DELEGATE review it BY bob INTO notes'), ['3: DELEGATE: INTO comes right after the task — write `DELEGATE <task> INTO <name> BY <agent> AS <template>`']);
  assert.deepEqual(errs('DELEGATE review it AS brief BY bob'), ['3: DELEGATE: BY comes after INTO, before AS — write `DELEGATE <task> INTO <name> BY <agent> AS <template>`']);
  // A fork inherits the conversation; its AS shapes what it is handed on top of it (D58).
  assert.deepEqual(errs('FORK wire it BY dave AS brief'), []);
  assert.deepEqual(errs('DELEGATE review it'), ['3: DELEGATE in a flow names who it goes to — end it with `BY <agent | team>`']);
  // Structured: every `~` is waited for in its own block, and read after its WAIT.
  assert.deepEqual(errs('DELEGATE~ trace it INTO paths BY carol'), ['3: started with ~ and never waited for — WAIT paths before its STEP ends']);
  assert.deepEqual(errs('DELEGATE~ trace it INTO paths BY carol', 'DO read {{paths}}', 'WAIT paths'),
    ['4: `{{paths}}` is read before its WAIT — it was started with ~ at line 3: write `WAIT paths` above this line']);
  assert.deepEqual(errs('WAIT nope'), ['3: WAIT nope: no DELEGATE~ or FORK~ of this block fills `nope` — a WAIT takes back what its own block started']);
  assert.deepEqual(errs('WAIT ALL'), ['3: WAIT ALL: nothing was started with ~ in this block — drop the WAIT']);
  assert.deepEqual(errs('DELEGATE~ a BY bob', 'DELEGATE~ b BY carol', 'WAIT ALL'), [], 'WAIT ALL takes back what has no name');
  assert.deepEqual(errs('IF the plan is big:', '  DELEGATE~ trace it INTO paths BY carol', 'WAIT paths'),
    ['4: started with ~ and never waited for — WAIT paths before its IF ends', '5: WAIT paths: no DELEGATE~ or FORK~ of this block fills `paths` — a WAIT takes back what its own block started']);
  // Outside a flow step: a DELEGATE waits where it stands; FORK, `~` and WAIT are a step's.
  const agent = checkVocabulary('a.ap', ['EXPORT AGENT a AS r:', '    ABOUT x', '    MANDATE y', '    WHEN asked:',
    '        DELEGATE check it INTO notes BY bob', '        DELEGATE~ check it BY bob', '        FORK wire it', '        WAIT ALL', '', 'ROLE r:', '    ABOUT z', '    ALWAYS be'].join('\n'))
    .map(e => `${e.line}: ${e.message}`);
  assert.deepEqual(agent, [
    "6: DELEGATE~: starting work without waiting for it is a flow STEP's — here, write DELEGATE and wait for it",
    '7: FORK hands work to a fork of whoever runs a flow — it stands in a flow STEP; an agent asks a question with ASK',
    '8: WAIT takes back what a STEP started with ~ — it stands in a flow STEP',
  ]);

  console.log('Flow lint delegation lines test passed.');
}

// ---------------------------------------------------------------------------
// 8. Block contract: FLOW without STEP
// ---------------------------------------------------------------------------

{
  const noStep = `# no-step

ABOUT  flow without steps

FLOW no-step
  RUN some-subflow
`;

  const errors = lintFlow('no-step.flow.ap', noStep);
  assert.ok(
    errors.some(e => /FLOW block requires at least one STEP/.test(e.message)),
    `FLOW without STEP produces contract error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint FLOW without STEP test passed.');
}

// ---------------------------------------------------------------------------
// 9. A bare PARALLEL is gone: its rewrite
// ---------------------------------------------------------------------------

{
  const nestedParallel = `# nested-parallel

ABOUT  nested parallel test

FLOW nested-parallel
  STEP first:
    RUN step-one
  PARALLEL
    STEP inner:
      RUN inner-step
    PARALLEL
      STEP deep:
        RUN deep-step
`;

  // A retired word is the vocabulary check's to name, once (lintFile runs it with the block contracts).
  const errors = checkVocabulary('nested-parallel.flow.ap', nestedParallel);
  assert.ok(
    errors.some(e => e.line === 8 && /PARALLEL was removed — in one STEP, start each piece with `DELEGATE~/.test(e.message)),
    `a bare PARALLEL is told its rewrite, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint bare PARALLEL test passed.');
}

// ---------------------------------------------------------------------------
// 10. Block contract: FLOW inside STEP
// ---------------------------------------------------------------------------

{
  const flowInStep = `# flow-in-step

ABOUT  flow inside step test

FLOW flow-in-step
  STEP first:
    RUN step-one
    FLOW nested
`;

  const errors = lintFlow('flow-in-step.flow.ap', flowInStep);
  assert.ok(
    errors.some(e => /FLOW is not allowed inside STEP/.test(e.message)),
    `FLOW inside STEP produces contract error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint FLOW inside STEP test passed.');
}

// ---------------------------------------------------------------------------
// 11. Agent-only enforcement: FLOW keyword in .policy.ap rejected
// ---------------------------------------------------------------------------

{
  const policyWithFlow = `# bad-policy

ABOUT  test policy
ALWAYS do something
FLOW bad-flow
`;

  const errors = lintPolicy('bad.policy.ap', policyWithFlow);
  assert.ok(
    errors.some(e => /FLOW is only allowed in a flow/.test(e.message)),
    'FLOW in policy.ap produces lint error',
  );

  console.log('Flow lint FLOW keyword in policy.ap test passed.');
}

// ---------------------------------------------------------------------------
// 12. Bundle integration: flow body appears in compiled bundle
// ---------------------------------------------------------------------------

{
  const tmp = '/tmp/agent-pack-flow-test';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(tmp, 'agents/standalone'), { recursive: true });
  mkdirSync(join(tmp, 'library/flows'), { recursive: true });
  mkdirSync(join(tmp, 'library/templates'), { recursive: true });
  writeFileSync(join(tmp, 'library/templates/brief.ap'), [
    'EXPORT TEMPLATE brief:', '    ABOUT  what the reviewer is handed', '    SLOTS:', '        plan: TEXT "the plan"', '    BODY:', '        {plan}', '',
  ].join('\n'), 'utf-8');

  writeFileSync(join(tmp, 'agents/standalone/test-agent.ap'), [
    'IMPORT tdd FROM library.flows',
    '',
    'EXPORT AGENT test-agent AS test-runner:',
    '    ABOUT    Test agent for flow rendering',
    '    MANDATE  verify flow rendering works',
    '',
    'EXPORT ROLE test-runner:',
    '    ABOUT  a runner that verifies flow rendering',
    '    ALWAYS run the flow as written',
    '',
  ].join('\n'), 'utf-8');

  writeFileSync(join(tmp, 'library/flows/tdd.ap'), [
    '# tdd',
    '',
    'ABOUT     Test-Driven Development: tester writes failing test, dev implements, tester verifies',
    'APPLIES      #flow, #tdd',
    '',
    'IMPORT brief FROM library.templates',
    '',
    'FLOW tdd',
    '  STEP tester:',
    '    DO write-failing-test',
    '  STEP developer:',
    '    DELEGATE make-test-pass BY test-agent',
    '  STEP reviewer:',
    '    DELEGATE review-the-change BY test-agent AS! brief',
    '  STEP tester:',
    '    DO verify-and-refactor',
    '',
  ].join('\n'), 'utf-8');

  const prevCwd = process.cwd();
  process.chdir(tmp);

  const { loadConfig } = await import('../dist/src/config.js');
  const { bundleAgentFromConfig } = await import('../dist/src/compiler/index.js');

  const config = await loadConfig([]);
  const bundle = await bundleAgentFromConfig('test-agent', config, {});

  assert.ok(bundle.includes('Flows'), 'bundle contains Flows section');
  assert.ok(bundle.includes('`tdd`'), 'bundle contains flow heading (no kind-word prefix)');
  assert.ok(bundle.includes('Test-Driven Development'), 'bundle contains flow ABOUT');
  assert.ok(bundle.includes('write-failing-test'), 'bundle contains first step action');
  assert.ok(bundle.includes('make-test-pass'), 'bundle contains second step action');
  assert.match(bundle, /developer\n +Delegate: make-test-pass — to `test-agent`, with all your context/, 'a delegation without AS hands over all the context');
  assert.match(bundle, /reviewer\n +Delegate: review-the-change — to `test-agent`, handing over only what `brief` \(tpl-[0-9a-f]+\) holds/,
    'a delegation with AS hands over only what its template holds');

  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true });

  console.log('Flow bundle integration test passed.');
}

// ---------------------------------------------------------------------------
// 13. A DELEGATE block: the lines the one it goes to is told
// ---------------------------------------------------------------------------

{
  const block = `# with-block

ABOUT  a delegation with its own lines

FLOW with-block
  STEP implement idea:
    DELEGATE implement the idea BY design:
      DO write it test-first
      NEVER touch the docs
`;
  const errors = lintFlow('with-block.flow.ap', block).filter(e => e.severity !== 'warning');
  assert.deepEqual(errors, [], 'a DELEGATE block holds DO and rule lines');

  const wrong = lintFlow('wrong-block.flow.ap', block.replace('      DO write it test-first', '      WAIT ALL').replace('wrong-block', 'with-block'))
    .map(e => e.message);
  assert.ok(wrong.some(m => /WAIT is not allowed inside DELEGATE/.test(m)), wrong.join('\n'));

  console.log('Flow DELEGATE block test passed.');
}

console.log('All flow tests passed.');
