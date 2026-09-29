// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A config names the built-in adapters instead of importing them, so it loads
 * with a global install and in projects that are not Node packages.
 */
import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { loadConfig } = await import('../dist/src/config.js');
const { AdapterRegistry } = await import('../dist/src/adapter-registry.js');

const tmp = mkdtempSync(join(tmpdir(), 'ap-adapter-names-'));
const prevCwd = process.cwd();
try {
  process.chdir(tmp);
  const configFile = join(tmp, 'agent-pack.config.mjs');

  writeFileSync(configFile, "export default { adapters: ['claude-code-apx', 'junie'] };\n");
  const config = await loadConfig(['--config', configFile]);
  assert.deepEqual(config.adapters.map(a => a.name), ['claude-code-apx', 'junie'], 'names resolve to the built-in adapters');

  const registry = AdapterRegistry.fromConfig(config);
  assert.equal(registry.get('cursor').name, 'cursor', '--adapter reaches a built-in even when not configured');
  assert.throws(() => registry.get('nope'), /Available: .*claude-code.*cursor/, 'an unknown --adapter lists the built-ins');

  const badFile = join(tmp, 'bad.config.mjs'); // a new path: ESM caches the first import
  writeFileSync(badFile, "export default { adapters: ['nope'] };\n");
  await assert.rejects(loadConfig(['--config', badFile]), /Unknown adapter "nope" — built-in adapters: claude-code, claude-code-apx, cursor, junie/);

  console.log('adapter names in config: passed.');
} finally {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
}
