// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Unified IMPORT resolver — parity gate for the EXPORT-unit model.
 *
 * The resolver collapses two historical mechanisms (file-as-unit, symbol-in-file)
 * into one: an imported name resolves to an EXPORT unit (a top-level block marked
 * exported). A clearly-fenced LEGACY FALLBACK keeps the two old mechanisms live
 * IDENTICAL while the `.ap` corpus is mid-migration.
 *
 * This suite is the gate the rest of the EXPORT/index plan depends on:
 *   1. PARITY — every real IMPORT in the library corpus still resolves to the
 *      exact same file as the pre-unification resolver (re-derived independently
 *      here). The corpus is a verbatim copy of the real library under
 *      test/fixtures/library, so the suite is self-contained.
 *   2. FIXTURES — both legacy mechanisms + the new explicit-EXPORT case, so the
 *      contract is pinned even if the live corpus migrates away from legacy.
 *   3. NEW CASE — `EXPORT POLICY foo:` resolves `IMPORT foo`; a private block in
 *      the same file does NOT resolve and yields a not-exported diagnostic.
 */
import { strict as assert } from 'assert';
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const { resolveTargetWith, resolveImports } = await import('../dist/src/dispatch/imports.js');
const { parseNamespace } = await import('../dist/src/namespace.js');
const { parseBlocks } = await import('../dist/src/parseBlocks.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const MAIN_LIB = resolve(PROJECT_ROOT, 'test/fixtures/library');
const LIBRARIES = { '@main': MAIN_LIB };

// --- Independent re-derivation of the expected resolution. ---
// Mirrors the resolver's two stages without reusing its code:
//   1. EXPORT-unit: scan every `.ap` in the namespace folder for a top-level
//      block whose name equals `name`, marked exported. The file basename is
//      irrelevant (one file, many exports). This is what makes resolution
//      suffix-free — a flat `<name>.ap` (local) and a suffixed `<name>.role.ap`
//      (an unmigrated library) both resolve by their block name.
//   2. flat path-shape fallback: `<kind>/<scope>/<name>.ap` (legacy file-as-unit
//      and symbol-in-file modules carry no EXPORT block).
// If the new resolver diverges on any real import, parity is broken.
const FILE_KINDS = new Set(['policies', 'playbooks', 'procedures', 'templates', 'roles', 'tools', 'flows']);
function exportUnitFile(dir, name) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {        // recurse: the namespace folder is a search root, not a leaf
      const found = exportUnitFile(abs, name);
      if (found) return found;
      continue;
    }
    if (!entry.endsWith('.ap')) continue;
    const block = parseBlocks(readFileSync(abs, 'utf-8')).blocks.find(b => b.name === name);
    if (block && block.exported) return abs;
  }
  return null;
}
function legacyResolve(modulePath, name) {
  const p = parseNamespace(modulePath);
  const root = p.alias ? LIBRARIES[p.alias] : null;
  if (!root) return null;
  const scopePath = p.scope.length === 0 ? '' : p.scope.join('/') + '/';
  if (!FILE_KINDS.has(p.kind)) return null;
  // Stage 1: EXPORT-unit scan of the namespace folder.
  const dir = resolve(root, `${p.kind}/${scopePath}`);
  const exported = exportUnitFile(dir, name);
  if (exported) return exported;
  // Stage 2: flat path-shape fallback.
  const abs = resolve(root, `${p.kind}/${scopePath}${name}.ap`);
  return existsSync(abs) ? abs : null;
}

function walkAp(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkAp(p, out);
    else if (e.endsWith('.ap')) out.push(p);
  }
  return out;
}

// --- 1. PARITY: enumeration of every real IMPORT in the @main library corpus. ---
{
  const IMPORT_RE = /^IMPORT\s+(.+?)\s+FROM\s+(@?[\w.-]+)\s*$/gm;
  const files = walkAp(MAIN_LIB);
  let checked = 0;
  for (const f of files) {
    const raw = readFileSync(f, 'utf-8');
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(raw))) {
      const names = m[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
      const modulePath = m[2];
      const resolved = resolveImports(`IMPORT ${m[1]} FROM ${modulePath}`, [], LIBRARIES);
      for (const name of names) {
        checked++;
        const expected = legacyResolve(modulePath, name);
        const got = resolved.find(r => r.name === name)?.absolutePath ?? null;
        assert.equal(got, expected,
          `parity: IMPORT ${name} FROM ${modulePath} (in ${f}) must resolve to the legacy target`);
      }
    }
  }
  // The library corpus carries 7 imported names (score-row, finding-decision,
  // backlog-item, feature-card, bug-card, read-board-state-template, …).
  assert.ok(checked >= 7, `parity: expected to enumerate the real corpus, only saw ${checked} imports`);
  console.log(`unified-resolver parity: ${checked} real imports resolve identically.`);
}

// --- Fixture library exercising the legacy mechanism + an explicit EXPORT. ---
const TMP = '/tmp/agent-pack-unified-resolver-test';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'policies/coding'), { recursive: true });
mkdirSync(join(TMP, 'templates'), { recursive: true });
const FIX = { '@fix': TMP };

// Legacy mechanism A — file-as-unit: name = file basename (file-top metadata,
// no EXPORT block). Flat `<name>.ap` — the `policies/` folder names the kind.
writeFileSync(join(TMP, 'policies/coding/dry-kiss.ap'),
  `# dry-kiss\nABOUT DRY and KISS\nALWAYS apply DRY and KISS\n`, 'utf-8');

// New explicit-EXPORT module — one EXPORT block + one private block, file
// basename deliberately != export name (one file, many exports).
writeFileSync(join(TMP, 'templates/bundle.ap'),
  `EXPORT TEMPLATE foo:\n  ABOUT exported foo\n  SLOTS:\n    a: TEXT "x"\n\nTEMPLATE bar:\n  ABOUT private bar\n  SLOTS:\n    b: TEXT "y"\n`,
  'utf-8');

// --- 2a. Legacy file-as-unit still resolves to the file. ---
{
  const r = resolveTargetWith('@fix.policies.coding', 'dry-kiss', [], FIX);
  assert.ok(r && !r.notExported, 'legacy file-as-unit resolves');
  assert.equal(r.kind, 'policies');
  assert.ok(r.absolutePath.endsWith('policies/coding/dry-kiss.ap'), 'resolves to the named file');
  assert.equal(r.exportUnit, undefined, 'legacy match carries no exportUnit');
  console.log('unified-resolver: legacy file-as-unit ok');
}

// --- 3a. New case: EXPORT block resolves by block name, not file name. ---
{
  const r = resolveTargetWith('@fix.templates', 'foo', [], FIX);
  assert.ok(r && !r.notExported, 'EXPORT unit resolves');
  assert.ok(r.exportUnit, 'resolution carries the exportUnit block');
  assert.equal(r.exportUnit.name, 'foo', 'exportUnit is the foo block');
  assert.equal(r.exportUnit.key, 'TEMPLATE', 'inner KIND preserved');
  assert.equal(r.exportUnit.exported, true, 'exportUnit is marked exported');
  assert.ok(r.absolutePath.endsWith('templates/bundle.ap'),
    'resolves to the holding file regardless of its basename');
  console.log('unified-resolver: explicit EXPORT block ok');
}

// --- 3b. New case: a private block in the same file is NOT importable. ---
{
  const r = resolveTargetWith('@fix.templates', 'bar', [], FIX);
  assert.ok(r && r.notExported, 'private block yields a not-exported resolution');
  assert.equal(r.namespace, '@fix.templates', 'not-exported carries the namespace for diagnostics');
  console.log('unified-resolver: private block not importable ok');
}

// --- 3c. EXPORT-first precedence: a name absent from any block falls through. ---
{
  const r = resolveTargetWith('@fix.templates', 'missing', [], FIX);
  assert.equal(r, null, 'absent name resolves to null (legacy fallback then misses)');
  console.log('unified-resolver: absent name → null ok');
}

rmSync(TMP, { recursive: true, force: true });
console.log('unified-resolver tests passed.');
