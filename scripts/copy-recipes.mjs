// Copies each adapter's launch recipe (`adapters/<name>/invoke.ap`, D66) beside its compiled
// adapter, where `invocation.recipe` finds it: dist/adapters/<name>/invoke.ap.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

for (const name of readdirSync('adapters', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
  const recipe = join('adapters', name, 'invoke.ap');
  if (!existsSync(recipe)) continue;
  mkdirSync(join('dist', 'adapters', name), { recursive: true });
  copyFileSync(recipe, join('dist', 'adapters', name, 'invoke.ap'));
}
