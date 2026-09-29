// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Tests for FLOW primitive: lint (generic block-contracts + file-level invariants)
 * and bundle integration.
 *
 * Parser-specific tests (parseFlowFile, FlowEntry fields) are removed: the
 * generic file.ts collect pipeline handles flow files without a custom parser.
 */
import { strict as assert } from 'assert';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { lintFlow, lintPolicy, checkVocabulary } = await import('../dist/src/lint.js');
const { applyForceLevels } = await import('../dist/src/forceLevel.js');

// ---------------------------------------------------------------------------
// 1. Lint OK: well-formed TDD flow passes with zero errors
// ---------------------------------------------------------------------------

{
  const tdd = `# tdd

ABOUT     Test-Driven Development: tester writes failing test, dev implements, tester verifies
TAGS      #flow #tdd

FLOW tdd
  STEP tester:
    RUN write-failing-test
  STEP developer:
    CONTEXT full
    RUN make-test-pass
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
    CONTEXT full
`;

  const errors = lintFlow('no-action.flow.ap', noAction);
  assert.ok(
    errors.some(e => /STEP block requires at least one of: DO, RUN/.test(e.message)),
    `step without DO/RUN produces contract error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint STEP without DO/RUN test passed.');
}

// ---------------------------------------------------------------------------
// 6. Block contract: STEP with 2 CONTEXT (unique violation)
// ---------------------------------------------------------------------------

{
  const dupCtx = `# dup-ctx

ABOUT  duplicate context test

FLOW dup-ctx
  STEP first:
    RUN step-one
  STEP second:
    CONTEXT full
    CONTEXT summary
    RUN step-two
`;

  const errors = lintFlow('dup-ctx.flow.ap', dupCtx);
  assert.ok(
    errors.some(e => /STEP block has 2 occurrences of CONTEXT/.test(e.message)),
    `duplicate CONTEXT produces unique violation, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint duplicate CONTEXT test passed.');
}

// ---------------------------------------------------------------------------
// 7. CONTEXT invalid mode (semantic check in lintFlow)
// ---------------------------------------------------------------------------

{
  const badMode = `# bad-mode

ABOUT  bad context mode test

FLOW bad-mode
  STEP first:
    RUN step-one
  STEP second:
    CONTEXT verbose
    RUN step-two
`;

  const errors = checkVocabulary('bad-mode.flow.ap', badMode);
  assert.ok(
    errors.some(e => /CONTEXT: unknown value `verbose`/.test(e.message) && e.line === 9),
    `invalid CONTEXT mode produces lint error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint invalid CONTEXT mode test passed.');
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
// 9. Block contract: PARALLEL nested inside PARALLEL
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

  const errors = lintFlow('nested-parallel.flow.ap', nestedParallel);
  assert.ok(
    errors.some(e => /PARALLEL is not allowed inside PARALLEL/.test(e.message)),
    `nested PARALLEL produces contract error, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow lint nested PARALLEL test passed.');
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
    'TAGS      #flow #tdd',
    '',
    'FLOW tdd',
    '  STEP tester:',
    '    DO write-failing-test',
    '  STEP developer:',
    '    CONTEXT full',
    '    DO make-test-pass',
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

  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true });

  console.log('Flow bundle integration test passed.');
}

// ---------------------------------------------------------------------------
// 13. BY primitive: renders inline with the executor name in backticks
// ---------------------------------------------------------------------------

{
  const rendered = applyForceLevels('BY design');
  assert.ok(
    rendered.includes('By `design`'),
    `BY renders the executor in backticks, got: ${JSON.stringify(rendered)}`,
  );

  console.log('Flow BY rendering test passed.');
}

// ---------------------------------------------------------------------------
// 14. Block contract: STEP with BY + DO is valid
// ---------------------------------------------------------------------------

{
  const withBy = `# with-by

ABOUT  step bound to an executor via BY

FLOW with-by
  STEP implement idea:
    BY design
    DO implement the idea
`;

  const errors = lintFlow('with-by.flow.ap', withBy).filter(e => e.severity !== 'warning');
  assert.equal(errors.length, 0, `STEP with BY + DO should have no errors, got: ${JSON.stringify(errors)}`);

  console.log('Flow STEP with BY test passed.');
}

// ---------------------------------------------------------------------------
// 15. Block contract: STEP with 2 BY (unique violation)
// ---------------------------------------------------------------------------

{
  const dupBy = `# dup-by

ABOUT  duplicate executor test

FLOW dup-by
  STEP implement idea:
    BY design
    BY dev
    DO implement the idea
`;

  const errors = lintFlow('dup-by.flow.ap', dupBy);
  assert.ok(
    errors.some(e => /STEP block has 2 occurrences of BY/.test(e.message)),
    `duplicate BY produces unique violation, got: ${JSON.stringify(errors)}`,
  );

  console.log('Flow duplicate BY test passed.');
}

console.log('All flow tests passed.');
