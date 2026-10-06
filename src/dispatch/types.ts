// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { ChecksConfig } from '../judge/types.js';
import { LintError, LintOptions } from '../lint.js';
import type { Definition } from '../definition.js';
import type { ExportedBlockBody } from '../services/text.js';
import type { SourceRegistry } from '../sources.js';

export interface ToolEntry {
  name: string;
  body: string;
  path: string;
}

export type PolicyEntry    = Definition & { kind: 'policy' };
export type RoleEntry      = Definition & { kind: 'role' };
export type TemplateEntry  = Definition & { kind: 'template' };
export type ProcedureEntry = Definition & { kind: 'procedure' };
export type FlowEntry      = Definition & { kind: 'flow' };
export type StoreEntry     = Definition & { kind: 'store' };

export interface BundleContext {
  agentName: string;
  /** Primary library root (=libraryRoots[0]); kept for back-compat. */
  libraryRoot: string;
  /**
   * Ordered list of library roots searched for `IMPORT … FROM library.<kind>` resolution.
   * First entry is project-local; subsequent entries are shared/fallback.
   */
  libraryRoots: string[];
  /**
   * Named library aliases for `IMPORT … FROM @<alias>.…` directives.
   * Resolved from Config.libraries at bundle init time.
   */
  libraries?: Record<string, string>;
  tools: ToolEntry[];
  policies: PolicyEntry[];
  roles: RoleEntry[];
  templates: TemplateEntry[];
  procedures: ProcedureEntry[];
  flows: FlowEntry[];
  stores: StoreEntry[];
  lintErrors: LintError[];
  lintOptions?: LintOptions;
  /**
   * Harness-native renderings declared by the active adapter
   * (AdapterPlugin.renderings), keyed by keyword then enum value or force level. Absent when
   * bundling without an adapter — every value then renders its neutral prose.
   */
  renderings?: Record<string, Record<string, string>>;
  /**
   * The environment variable the active adapter's harness puts its session id
   * in (AdapterPlugin.sessionEnv) — recorded in the document for the apx.
   */
  sessionEnv?: string;
  /**
   * The judge of checked conditions (`checks` config key) — null/absent: none,
   * so `IF!` falls back to `IF` and `IF!!` fails. Its round limit words the prompt.
   */
  checks?: ChecksConfig | null;
  /** The command that says how to run a flow, by its id — set while a team's routing renders. */
  flowCommand?: (id: string) => string;
  importedPaths: Set<string>;
  /** The compilation's source registry — every `.ap` file it reads, read once. */
  sources: SourceRegistry;
  /**
   * Per-path cache of a module's exported blocks, parsed exactly once. Lets an
   * N-export module imported M times read+parse+lint+side-effect a single time
   * instead of once per imported block. Lazily created by the per-block resolver.
   */
  parsedExports?: Map<string, ExportedBlockBody[]>;
}

