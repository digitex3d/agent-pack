// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import type { Keyword } from './lexer.js';
import type { BundleContext } from './dispatch/types.js';
import type { BreadcrumbSegment } from './ingest.js';
import { renderTemplate } from './shapeCompiler.js';

/**
 * A definition: a named primitive extracted from an .ap file (explicit via
 * `KEYWORD <name>:` block or implicit from file header `# <name>`).
 *
 * The `kind` field is a free string — concrete kinds are declared by
 * DefinitionStrategy instances registered below. Adding a new kind requires
 * exactly one new entry in STRATEGIES, no changes to consumers.
 */
export interface Definition {
  kind: string;
  name: string;
  about: string | null;
  body: string;
  path: string;
  /** TAGS declared by the source module (empty when none). */
  tags: string[];
  /** Breadcrumb slug chain (e.g., ["coding", "code-quality"]). Empty when the file is at the library root. */
  breadcrumb: string[];
  /** Per-segment scope metadata (slug + optional ABOUT from each index.ap). Same length and order as `breadcrumb`. */
  breadcrumbSegments: BreadcrumbSegment[];
  /** Block id stamped during bundle render — the target of every reference to it. */
  refId?: string;
  /**
   * Role identity — the display name this role embodies (the de-slugified block
   * name). Set only on `kind: 'role'` entries; an agent that binds the role via
   * `AS <role>` reads it to render the `# Identity` block. Undefined elsewhere.
   */
  role?: string;
  /** Role identity — the EXPERTISE domains, lifted out of the role body. */
  expertise?: string;
}

/**
 * Per-kind strategy. Most fields are derived from `kind` by `defaults()`;
 * override only what diverges from convention.
 */
export interface DefinitionStrategy {
  kind: string;
  /** Header keyword opening the definition block, or null if file-implicit. */
  headerKeyword: Keyword | null;
  /** Whether instances of this kind are callable via `RUN <name>`. */
  runnable: boolean;
  sectionTitle: string;
  formatHeading(name: string): string;
  getEntries(ctx: BundleContext): Definition[];
  /**
   * Strategy hook to render this kind's body into its bundle block. Returns
   * null to defer to the generic rendering (verbatim body, header keyword
   * stripped when the kind declares one). Only kinds with bespoke body shapes
   * (e.g. template) override it.
   */
  renderBody?(source: Definition, ctx: BundleContext): string | null;
  /** Optional post-emit side-effect on the source entry (e.g. propagate refId). */
  afterEmit?: (source: Definition, entry: { refId?: string }) => void;
  /**
   * Optional enum-primitive keyword whose modes this chapter must explain: the
   * renderer appends the enum's legend (neutral or adapter-native, see
   * `renderEnumLegend`) after the chapter intro. A plain string — not a
   * function — so this registry stays import-free of the primitives module.
   */
  legendEnum?: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Conventional defaults derived from `kind`. Override what differs:
 *   headerKeyword  = `${KIND}` (uppercase; null if file-implicit)
 *   runnable       = false
 *   sectionTitle   = `${Capitalize(kind)}s`
 *   formatHeading  = `` `<name>` `` (the chapter title already names the kind —
 *                    repeating it on every entry heading is redundant)
 *   getEntries     = ctx => ctx[`${kind}s`]
 *   afterEmit      = propagateRefId (so the source Definition carries
 *                    its emitted section number; consumed by the
 *                    cross-references appendix and by `RETURN AS` for templates)
 */
export function defaults(kind: string): DefinitionStrategy {
  return {
    kind,
    headerKeyword: kind.toUpperCase() as Keyword,
    runnable: false,
    sectionTitle: capitalize(kind) + 's',
    formatHeading: name => `\`${name}\``,
    getEntries: ctx => (ctx as any)[kind + 's'] as Definition[],
    afterEmit: propagateRefId,
  };
}

/**
 * Side-effect helper that propagates the assigned section number back to the
 * source entry. Consumed by `RETURN AS`/`@shape` (template) and by `RUN`
 * cross-references (procedure, flow), which print its id.
 */
function propagateRefId(source: Definition, entry: { refId?: string }): void {
  source.refId = entry.refId;
}

/**
 * Registry of definition kinds. Add a new entry to register a new kind.
 * Lint, dispatch, render, and RUN resolution all read from this registry.
 *
 * Order determines bundle section order (backward-compatible):
 *   role → template → procedure → flow
 */
export const STRATEGIES: DefinitionStrategy[] = [
  // Policy, like role, is inline-able as `POLICY <name>:` in an agent file;
  // `stripHeaderKeyword` is a no-op on the import path.
  { ...defaults('policy'),    headerKeyword: 'POLICY', sectionTitle: 'Policies', getEntries: ctx => (ctx as any).policies as Definition[] },
  // Role is file-implicit when imported from a role file (the file's H1
  // names it), but also inline-able as a `ROLE <role>:` block inside an
  // agent.ap. `headerKeyword: 'ROLE'` lets `extractInlineDefinitions` collect
  // those inline blocks; `stripHeaderKeyword` is a no-op on the import path,
  // whose body is already resolved to indent 0.
  { ...defaults('role'),      headerKeyword: 'ROLE', sectionTitle: 'Roles' },
  { ...defaults('template'),  renderBody: (e, ctx) => renderTemplate(e.body, e.name, ctx.templates), afterEmit: propagateRefId },
  { ...defaults('procedure'), runnable: true, afterEmit: propagateRefId },
  // The flow chapter explains the CONTEXT step-signature modes via the enum's
  // legend — harness-native when the active adapter declares renderings.
  { ...defaults('flow'),      runnable: true, afterEmit: propagateRefId, legendEnum: 'CONTEXT' },
  // A store is a named working table, not a callable routine: NOT runnable. It
  // is referenced by name from a runnable's `IN`/`AS`, which resolves the (id)
  // back-reference from the emitted section number the same way RUN does.
  // ⚠ GAP — a store renders only on the AGENT path.
  //
  // Rendering lives in StoreBlock (apdoc), because the md is a projection of
  // the document and a second renderer here would be a second source of truth.
  // But only `bundleAgentToString` goes through the document. The three legacy
  // callers of `emitCollectedSections` — buildPlaybookBundle,
  // bundleStandaloneToString and orchestrationSection — still render from THIS
  // registry, and with no `renderBody` here they fall through to the generic
  // verbatim body.
  //
  // So a playbook that imports a store prints its RAW SOURCE — `TYPE tabeli`,
  // `LASTS project`, the SLOTS region as written — instead of the field list
  // and the commands. Not an error, and silent.
  //
  // It does not bite today: no playbook declares or imports a store. It closes
  // when playbook/orchestration migrate onto the document (see the header of
  // src/apdoc/builder.ts) — not by adding a renderer here, which would put the
  // same prose in two places again.
  { ...defaults('store'),     afterEmit: propagateRefId },
];

/** Lookup strategy by kind. */
export function strategyFor(kind: string): DefinitionStrategy | null {
  return STRATEGIES.find(s => s.kind === kind) ?? null;
}

/** All definitions across all `runnable: true` kinds. */
export function allRunnables(ctx: BundleContext): Definition[] {
  return STRATEGIES.filter(s => s.runnable).flatMap(s => s.getEntries(ctx));
}

/** Resolve a `RUN <name>` reference. Returns null if no imported definition matches. */
export function resolveRunTarget(name: string, ctx: BundleContext): Definition | null {
  return allRunnables(ctx).find(d => d.name === name) ?? null;
}
