// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyVars } from '../dist/src/vars.js';

import { bundleAgentToString } from '../dist/src/compiler/index.js';

// --- applyVars ---

{
  const result = applyVars('Hello {{name}}!', { name: 'world' });
  assert.equal(result, 'Hello world!', 'basic substitution');
}

{
  const result = applyVars('{{a}} and {{b}}', { a: 'foo', b: 'bar' });
  assert.equal(result, 'foo and bar', 'multiple vars');
}

{
  const result = applyVars('{{x}} {{x}}', { x: 'hi' });
  assert.equal(result, 'hi hi', 'same key repeated');
}

{
  const result = applyVars('Hello {{missing}}!', { name: 'world' });
  assert.equal(result, 'Hello {{missing}}!', 'unknown key is left as-is');
}

{
  const result = applyVars('no placeholders', { name: 'world' });
  assert.equal(result, 'no placeholders', 'no placeholders unchanged');
}

{
  const result = applyVars('{{name}}', {});
  assert.equal(result, '{{name}}', 'empty vars map leaves placeholders');
}

console.log('applyVars tests passed.');

