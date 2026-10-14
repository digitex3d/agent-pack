// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { Block } from './parseBlocks.js';
import type { VarDecl, VarScope } from './vars.js';
import type { LintError } from './lint.js';
import { alreadyRegistered } from './dispatch/shared.js';

/**
 * Variables a module exports (D32, I7) — `EXPORT VAR …` lines in any module of
 * a library, found by `IMPORT <name> FROM <module-path>` like every export:
 *
 *   EXPORT VAR board = Product                  a constant, substituted at compile time
 *   EXPORT VAR draft                            a private variable — each importing agent its own
 *   EXPORT SESSION VAR plan AS impl-plan        shared by the session's agents that import it
 *
 * An agent reads a variable it declares in its body or imports — never one it
 * merely sits next to. The grammar of a line is `parseExportedVar`'s.
 */

/** A declared variable: its name, scope, template (or none), where it was written and how `ls kind=var` names its origin. */
export interface PlacedVariable {
  name: string;
  scope: VarScope;
  type: string | null;
  file: string;
  line: number;
  where: string;
}

/**
 * An `EXPORT VAR` an IMPORT resolved: its declaration, its file and line, the
 * module path imported from, and the files that import it — imports never pass
 * on: a file sees what it declares or imports itself.
 */
export interface ImportedVariable {
  name: string;
  path: string;
  line: number;
  from: string;
  decl: VarDecl;
  importers: string[];
}

/** Register an imported `EXPORT VAR` block — once per name, like every import — and the file importing it. */
export function importVariable(
  block: Block & { variable: VarDecl }, path: string, from: string, importer: string,
  ctx: { variables: ImportedVariable[]; lintErrors: LintError[] },
): void {
  const name = block.variable.name;
  const existing = alreadyRegistered(ctx.variables, name, path, 'variable', block.startLine, ctx);
  if (!existing) ctx.variables.push({ name, path, line: block.startLine, from, decl: block.variable, importers: [importer] });
  else if (existing.path === path && !existing.importers.includes(importer)) existing.importers.push(importer);
}

/**
 * What `file` sees: the constants and variables every file sees (`everywhere` —
 * the implicit ones, the bodies' declarations), and those `file` imports itself.
 */
export function visibleIn(
  file: string, imported: ImportedVariable[], everywhere: { constants: Record<string, string>; variables: Iterable<string> },
): { constants: Record<string, string>; variables: Set<string> } {
  const own = imported.filter(v => v.importers.includes(file));
  const { constants } = importedVariables(own, everywhere.constants);
  return { constants, variables: new Set([...everywhere.variables, ...own.filter(v => v.decl.form !== 'constant').map(v => v.name)]) };
}

/** The constants — merged over `known` — and the variables a compilation imported. */
export function importedVariables(
  imported: ImportedVariable[], known: Record<string, string>,
): { constants: Record<string, string>; variables: PlacedVariable[] } {
  const constants = { ...known };
  const variables: PlacedVariable[] = [];
  for (const { decl, path, line, from } of imported) {
    if (decl.form === 'constant') constants[decl.name] = decl.value;
    else variables.push({ name: decl.name, scope: decl.scope, type: decl.type, file: path, line, where: `\`${from}\`` });
  }
  return { constants, variables };
}
