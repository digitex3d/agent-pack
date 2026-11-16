// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A plugin — a block and the apx commands that serve it, added to the language
 * without a change to the core. A folder: `plugin.ap`, its manifest, and
 * `service.mjs`, one function per operation. One name gives the rest: plugin
 * `checklist` declares the block `CHECKLIST`, lives in `checklists/`, is
 * served as `<apx> checklist <operation> <che-id>`.
 *
 *   PLUGIN checklist:
 *       ABOUT  a list of checks an agent goes through before it delivers
 *       AS     checklist                ← the template its block's lines are
 *       OPERATION tick:
 *           ABOUT  mark one item done
 *           AS     tick                 ← the template of its input
 *
 * A block's lines are a record of its template: slot `item` is the line
 * `ITEM`, written once — or again and again for a LIST slot. An operation's
 * input is a record of its template, written `field=value` after the id.
 *
 * The spec is plain data: the loader reads it from the manifest
 * (src/pluginLoader.ts), the compiled document carries it to the apx
 * (meta.plugins), and both read records through it alike. The apx engine
 * bundles this module.
 */
import { parseTypeSpec, validateRecord, formatIssues, type SlotSpec, type SlotTypeSpec, type SlotResolver } from './shapeSchema.js';

/** One template a plugin declares, as written: a record's slots, or a scalar's type. */
export type PluginTemplate =
  | { slots: { name: string; optional: boolean; rawType: string }[] }
  | { scalar: string };

export interface PluginOperation {
  op: string;
  about: string;
  /** The template of its input — null: it takes nothing after the id. */
  input: string | null;
}

export interface PluginSpec {
  /** Its name: the kind of its blocks and the apx verb that serves them. */
  name: string;
  about: string;
  /** The keyword of its block (`CHECKLIST`), its id prefix (`che`), its library folder (`checklists`). */
  key: string;
  prefix: string;
  folder: string;
  /** The template its block's lines are. */
  block: string;
  operations: PluginOperation[];
  templates: Record<string, PluginTemplate>;
  /** The service module, absolute. */
  service: string;
}

/** The keyword, id prefix and library folder a plugin's name gives. */
export function namesOf(name: string): { key: string; prefix: string; folder: string } {
  return { key: name.toUpperCase(), prefix: name.replace(/-/g, '').slice(0, 3), folder: `${name}s` };
}

/** The line keyword of a slot: `item` → `ITEM`. */
export function lineKeyOf(slot: string): string {
  return slot.toUpperCase();
}

const PLUGINS = new Map<string, PluginSpec>();

/** Make a plugin known to this process — by its kind and its block keyword. */
export function registerPlugin(spec: PluginSpec): void {
  PLUGINS.set(spec.name, spec);
}

/** The plugin serving a kind (`checklist`), or null. */
export function pluginOf(kind: string): PluginSpec | null {
  return PLUGINS.get(kind) ?? null;
}

/** The plugin whose block opens with a keyword (`CHECKLIST`), or null. */
export function pluginOfKey(key: string): PluginSpec | null {
  return [...PLUGINS.values()].find(plugin => plugin.key === key) ?? null;
}

/** Every plugin known to this process. */
export function plugins(): PluginSpec[] {
  return [...PLUGINS.values()];
}

/** A plugin's templates as the validator reads them: a record's slots, or a scalar's type. */
export function pluginResolver(spec: PluginSpec): SlotResolver {
  return name => {
    const template = spec.templates[name];
    if (!template) return null;
    return 'scalar' in template ? parseTypeSpec(template.scalar) : slotSpecs(template);
  };
}

function slotSpecs(template: { slots: { name: string; optional: boolean; rawType: string }[] }): SlotSpec[] {
  return template.slots.map(slot => ({ name: slot.name, optional: slot.optional, spec: parseTypeSpec(slot.rawType) }));
}

/** The slots of a plugin template that is a record — [] for a scalar or none. */
export function templateSlots(spec: PluginSpec, name: string | null): SlotSpec[] {
  const template = name ? spec.templates[name] : undefined;
  return template && 'slots' in template ? slotSpecs(template) : [];
}

/** The type a value of a slot takes once written as text: a scalar reached through a template, or the slot's own. */
function scalarType(slot: SlotTypeSpec, resolve: SlotResolver): SlotTypeSpec {
  if (slot.kind !== 'shape' && slot.kind !== 'list') return slot;
  const resolved = resolve(slot.ref);
  return resolved && !Array.isArray(resolved) ? resolved as SlotTypeSpec : slot;
}

/** A value written as text, as its type reads it: a NUMBER is a number, anything else stays text. */
function valueOf(type: SlotTypeSpec, text: string): unknown {
  return type.kind === 'number' && text.trim() !== '' && !Number.isNaN(Number(text)) ? Number(text) : text;
}

/**
 * A plugin block's lines as a record of its template: each slot's line read
 * once, or every time for a LIST slot. Lines no slot names are left to the
 * block's contract, which refuses them.
 */
export function recordOfLines(spec: PluginSpec, lines: readonly { key: string; rest: string }[]): Record<string, unknown> {
  const resolve = pluginResolver(spec);
  const record: Record<string, unknown> = {};
  for (const slot of templateSlots(spec, spec.block)) {
    const written = lines.filter(line => line.key === lineKeyOf(slot.name)).map(line => valueOf(scalarType(slot.spec, resolve), line.rest.trim()));
    if (slot.spec.kind === 'list') { if (written.length > 0) record[slot.name] = written; }
    else if (written.length > 0) record[slot.name] = written[written.length - 1];
  }
  return record;
}

/** What is wrong with a record against a plugin template — one line, or null when it fits. */
export function recordIssues(spec: PluginSpec, template: string | null, record: Record<string, unknown>): string | null {
  const issues = validateRecord(record, templateSlots(spec, template), pluginResolver(spec));
  return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
}

/**
 * What is wrong with a block's lines against its template — said in the
 * block's own words: the slot `item` is the line `ITEM`, its third value the
 * third `ITEM` line. Null when the lines fit.
 */
export function lineIssues(spec: PluginSpec, record: Record<string, unknown>): string | null {
  const issues = validateRecord(record, templateSlots(spec, spec.block), pluginResolver(spec));
  if (issues.length === 0) return null;
  return issues.map(issue => {
    const at = issue.field.match(/^([^.[]+)(?:\[(\d+)\])?(.*)$/);
    const line = at ? `${lineKeyOf(at[1])}${at[2] !== undefined ? ` line ${Number(at[2]) + 1}` : ''}${at[3]}` : issue.field;
    return issue.message === 'required field missing' ? `${line}: missing — the block needs this line` : `${line}: ${issue.message}`;
  }).join('; ');
}

/**
 * An operation's input from what follows the id: `field=value` pairs, each
 * read as its slot's type — or `-`, its JSON on stdin (`stdin` reads it). A
 * pair that is no `field=value` is the error.
 */
export function recordOfArgs(spec: PluginSpec, template: string | null, args: readonly string[], stdin: () => string): { record: Record<string, unknown> } | { error: string } {
  if (args.length === 1 && args[0] === '-') {
    try { return { record: JSON.parse(stdin()) as Record<string, unknown> }; } catch { return { error: 'the input on stdin is not valid JSON' }; }
  }
  const resolve = pluginResolver(spec);
  const slots = templateSlots(spec, template);
  const record: Record<string, unknown> = {};
  for (const pair of args) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return { error: `\`${pair}\` is not a field=value pair` };
    const field = pair.slice(0, eq);
    const slot = slots.find(candidate => candidate.name === field);
    record[field] = slot ? valueOf(scalarType(slot.spec, resolve), pair.slice(eq + 1)) : pair.slice(eq + 1);
  }
  return { record };
}

/** An operation's input as its command shows it: `item=<check>`, `[note=<text>]` — `-` for JSON on stdin. */
export function inputUsage(spec: PluginSpec, template: string | null): string {
  return templateSlots(spec, template).map(slot => {
    const shown = slot.spec.kind === 'shape' || slot.spec.kind === 'list' ? `<${slot.spec.ref}>` : `<${slot.spec.kind}>`;
    return slot.optional ? `[${slot.name}=${shown}]` : `${slot.name}=${shown}`;
  }).join(' ');
}
