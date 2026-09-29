// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { lineOfName } from '../lint.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve as resolvePath, relative as relativeFrom } from 'path';
import { BundleContext } from './types.js';
import { resolveFile } from './file.js';
import { resolveRole } from './role.js';
import { findInRoots, LoadRequest } from './shared.js';
import { unwrapExportFile } from '../services/text.js';
import { lex } from '../lexer.js';
import { parseNamespace } from '../namespace.js';
import { parseBlocks, Block } from '../parseBlocks.js';
import { KIND_DIRS } from '../ingest.js';

/**
 * Bare-line module-style import directive:
 *   IMPORT name1, name2 FROM library.<kind>[.<scope>...]
 *
 * Unified resolution model: an imported name resolves to a single EXPORT unit —
 * a top-level block marked
 * `exported` (via the `EXPORT <KIND> <name>:` modifier) whose block name equals
 * the imported name, discovered among the `.ap` modules of the namespace folder.
 *
 * EXPORT units take precedence. While the library is mid-migration (no `.ap`
 * file declares EXPORT yet), a clearly-fenced LEGACY FALLBACK preserves the
 * historical mechanism verbatim: name = file under the directory-namespace. The
 * fallback is transitional and
 * removable in one block once the codemod migration lands.
 *
 * IMPORT recognition is lexer-driven; the FROM split inside `rest` is the
 * directive's own sub-syntax (not a top-level keyword).
 */
const IMPORT_REST_RE = /^(.+?)\s+FROM\s+(@?[\w.-]+)\s*$/;

/**
 * Namespace kinds whose files live under a `<kind>/…` folder as flat `<name>.ap`.
 * Derived from the single kind registry (the plural folder names) — never
 * re-typed here.
 */
const FILE_KINDS = new Set<string>(Object.values(KIND_DIRS));

export interface ResolvedTarget {
  kind: string;
  absolutePath: string;
  relativePath: string;
  /**
   * Set only when the name resolved to an explicit EXPORT unit (a top-level
   * block marked exported). Carries the resolved block so callers render the
   * exact unit rather than the whole file. Absent for LEGACY FALLBACK matches.
   */
  exportUnit?: Block;
}

/**
 * The name was found in the namespace, but it is not importable: either it is a
 * top-level block declared without the EXPORT modifier (`exported: false`), or
 * (future) any other private symbol. Distinct from "not found" so callers can
 * emit a precise diagnostic instead of a generic miss.
 */
export interface NotExported {
  notExported: true;
  /** The namespace the name was found in, for the diagnostic message. */
  namespace: string;
}

export type Resolution = ResolvedTarget | NotExported | null;

function isNotExported(r: Resolution): r is NotExported {
  return r !== null && 'notExported' in r;
}

/**
 * Map a namespace's `<kind>[.<scope...>]` to its on-disk directory under each
 * candidate root. Mirrors the layout `relativePathFor` writes into.
 */
function namespaceDirs(
  kind: string,
  scope: string[],
  roots: string[],
): string[] {
  const scopePath = scope.length === 0 ? kind : `${kind}/${scope.join('/')}`;
  const dirs: string[] = [];
  for (const root of roots) {
    const dir = resolvePath(root, scopePath);
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * EXPORT-first resolution: scan every `.ap` module in the namespace folder for
 * a top-level block whose name equals `name`. A block marked exported resolves
 * to an EXPORT unit; a block found but unmarked yields `NotExported`. Returns
 * null when no block of that name exists anywhere in the namespace (the caller
 * then drops into the LEGACY FALLBACK).
 *
 * One file can hold several exports, so the file basename is irrelevant here —
 * only the block name matters, exactly like `export function` in TypeScript.
 */
/** Every `.ap` file under `dir`, recursively — so a block resolves regardless of how deep its folder nests. */
function apFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolvePath(dir, entry.name);
    if (entry.isDirectory()) out.push(...apFilesUnder(abs));
    else if (entry.name.endsWith('.ap')) out.push(abs);
  }
  return out;
}

function resolveExportUnit(
  namespace: string,
  name: string,
  kind: string,
  scope: string[],
  roots: string[],
): Resolution {
  let foundPrivate = false;
  const scopePath = `${kind}${scope.length ? '/' + scope.join('/') : ''}`;
  for (const dir of namespaceDirs(kind, scope, roots)) {
    // Recursive: the namespace dir is the SEARCH ROOT, not the exact leaf — a
    // block resolves by name regardless of how deeply its folder nests under it.
    for (const abs of apFilesUnder(dir)) {
      const { blocks } = parseBlocks(readFileSync(abs, 'utf-8'));
      const match = blocks.find(b => b.name === name);
      if (!match) continue;
      if (match.exported) {
        return {
          kind,
          absolutePath: abs,
          relativePath: `${scopePath}/${relativeFrom(dir, abs)}`,
          exportUnit: match,
        };
      }
      foundPrivate = true;
    }
  }
  return foundPrivate ? { notExported: true, namespace } : null;
}

/**
 * Lower-level resolver — takes library roots + alias map directly. Used by
 * `resolveTarget` (which extracts them from a BundleContext) and by
 * `resolveImports` (which is called outside the bundle pipeline, e.g. for
 * dynamic.ap parsing).
 *
 * Two prefix forms:
 *   library.<rest>             → search across all `libraryRoots`
 *   @<alias>.<rest>            → search only inside `libraries[@alias]`
 *
 * After stripping the prefix, `<rest>` is parsed as `<kind>[.<scope...>]`:
 *   <plural-kind>[.X.Y].<name>         where kind ∈ {policies,playbooks,procedures,templates,roles}
 *                                      → <root>/<kind>[/X/Y]/<name>.<kind-singular>.ap
 */
export function resolveTargetWith(
  modulePath: string,
  name: string,
  libraryRoots: string[],
  libraries: Record<string, string>,
): Resolution {
  const parsed = parseNamespace(modulePath);

  let roots: string[];
  if (parsed.alias !== null) {
    // @alias-prefixed path: resolve inside that alias's root.
    const aliasRoot = libraries[parsed.alias];
    if (!aliasRoot) return null;
    roots = [aliasRoot];
  } else if (modulePath.startsWith('library.') || modulePath === 'library') {
    roots = libraryRoots;
  } else {
    return null;
  }

  const { kind, scope: scopeSegments } = parsed;

  // Unified model: an import resolves to an EXPORT unit (a block marked
  // exported whose name equals the imported name).
  const exportResolution = resolveExportUnit(modulePath, name, kind, scopeSegments, roots);
  if (exportResolution !== null) return exportResolution;

  // ─── LEGACY FALLBACK (transitional — remove after the codemod migration) ───
  // No EXPORT unit named `name` exists in the namespace. While library `.ap`
  // files are unmigrated (file-top metadata, no EXPORT blocks), the historical
  // file-as-unit mechanism stays live: name = file basename under the
  // directory-namespace.
  // `relativePathFor` + `findInRoots` reproduce the exact pre-unification path
  // resolution. Deleting this block (and `resolveExportUnit`'s null branch
  // callers) collapses resolution to the EXPORT model alone.
  const rel = relativePathFor(kind, scopeSegments, name);
  if (!rel) return null;
  const abs = findInRoots(roots, rel);
  return abs ? { kind, absolutePath: abs, relativePath: rel } : null;
  // ─── END LEGACY FALLBACK ───
}

function resolveTarget(
  modulePath: string,
  name: string,
  ctx: BundleContext,
): Resolution {
  return resolveTargetWith(modulePath, name, ctx.libraryRoots, ctx.libraries ?? {});
}

/**
 * Parse a `.ap` source for `IMPORT name1, name2 FROM <module-path>` lines and
 * resolve each to an absolute file path via `resolveTargetWith`. Used outside
 * the bundle pipeline (e.g. `dynamic.ap` parsing) where a full BundleContext
 * is not available.
 *
 * Returns one entry per `<name>` resolved. Unresolvable names are silently
 * skipped — callers can lint-warn if they need to surface them.
 */
export interface ResolvedImport {
  name: string;
  absolutePath: string;
  kind: string;
}

export function resolveImports(
  raw: string,
  libraryRoots: string[],
  libraries: Record<string, string>,
): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  for (const t of lex(raw)) {
    if (t.kind !== 'keyword' || t.indent !== 0 || t.keyword !== 'IMPORT') continue;
    const m = t.rest.match(IMPORT_REST_RE);
    if (!m) continue;
    const names = m[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    const modulePath = m[2];
    for (const name of names) {
      const target = resolveTargetWith(modulePath, name, libraryRoots, libraries);
      // Skip unresolved (null) and found-but-not-exported (NotExported): this
      // out-of-pipeline resolver surfaces only successfully located files.
      if (target !== null && !isNotExported(target)) {
        out.push({ name, absolutePath: target.absolutePath, kind: target.kind });
      }
    }
  }
  return out;
}

function relativePathFor(kind: string, scope: string[], name: string): string | null {
  const scopePath = scope.length === 0 ? '' : `${scope.join('/')}/`;
  if (!FILE_KINDS.has(kind)) return null;
  return `${kind}/${scopePath}${name}.ap`;
}

/**
 * Process every `IMPORT … FROM library.<kind>…` directive in `body`,
 * resolve the names via the single `resolveTarget` function, and dispatch
 * to the appropriate existing handler:
 *   roles      → roleHandler
 *   others     → fileHandler (which already routes template and
 *                procedure units to their dedicated collections)
 *
 * Directive lines are replaced with the handler output (empty for
 * templates / procedures / roles).
 */
export async function processImports(body: string, ctx: BundleContext, sourcePath?: string): Promise<string> {
  // An IMPORT error points at the IMPORT line of the file that wrote it.
  const at = (name: string, line: number) => sourcePath
    ? { file: sourcePath, line: lineOfName(sourcePath, name, 'import') }
    : { file: '<body>', line };
  const tokens = lex(body);
  let result = '';

  // The legacy substring approach used `\s*$` greedy match. That match
  // consumed the IMPORT line's trailing `\n` IFF the next line was blank
  // (otherwise `$` couldn't anchor). This state machine reproduces the
  // same effect: after emitting an IMPORT replacement, if the next token
  // is a blank line, skip it — equivalent to "the IMPORT line and the
  // following blank line collapse into a single separator".
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const isImport = t.kind === 'keyword' && t.indent === 0 && t.keyword === 'IMPORT';

    if (i > 0) result += '\n';

    if (!isImport) {
      result += t.kind === 'blank' ? '' : ('raw' in t ? t.raw : '');
      i++;
      continue;
    }

    const m = t.rest.match(IMPORT_REST_RE);
    if (!m) {
      ctx.lintErrors.push({
        ...(sourcePath ? { file: sourcePath, line: lineOfName(sourcePath, t.rest.trim().split(/\s+/)[0] ?? '', 'import') } : { file: '<body>', line: t.line }),
        message: `malformed IMPORT directive: "${t.raw}" (expected: IMPORT <name1>, <name2> FROM <module-path>)`,
      });
      i++;
      continue;
    }

    const names = m[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
    const modulePath = m[2];
    let replacement = '';

    for (const name of names) {
      const target = resolveTarget(modulePath, name, ctx);
      if (target === null) {
        ctx.lintErrors.push({
          ...at(name, t.line),
          message: `IMPORT ${name} FROM ${modulePath}: not found in library roots`,
        });
        continue;
      }

      if (isNotExported(target)) {
        ctx.lintErrors.push({
          ...at(name, t.line),
          message: `IMPORT ${name} FROM ${modulePath}: "${name}" exists in ${target.namespace} but is not exported`,
        });
        continue;
      }

      // Pass the absolute path so resolution skips libraryRoots lookup (the file
      // may live in a sharedLibrary alias, not in the project's libraryRoot), and
      // the resolved EXPORT block name so a multi-export module registers THAT
      // block under its own name. Absent for LEGACY FALLBACK whole-file matches.
      const req: LoadRequest = {
        path: target.absolutePath, props: {}, exportBlockName: target.exportUnit?.name ?? undefined,
      };
      const handlerResult = target.kind === 'roles'
        ? await resolveRole(req, ctx)
        : await resolveFile(req, ctx);
      if (handlerResult) replacement += handlerResult + '\n';
    }

    result += replacement.trimEnd();
    i++;
    // Consume the trailing blank line (mirrors the OLD `\s*$` greedy match).
    if (i < tokens.length && tokens[i].kind === 'blank') i++;
  }
  return result;
}
