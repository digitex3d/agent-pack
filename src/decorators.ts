// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Block decorators — `@WITH pdf`, `@WITHIN web`: a line that says under which
 * conditions the work it decorates is done, never what to do.
 *
 *   @KEY items              above a block: decorates that block — a definition, all its work
 *   @KEY items:             in a body: decorates the lines nested beneath
 *
 * The family is one registry. A decorator's entry holds only what sets it
 * apart: the kinds of block its items name, how a decorator nested in another
 * of the same key combines with it, the opening of the sentence the compiled
 * definition prints, and the blocks it may stand above when not every one. Everything else is written once, here and in
 * the readers that consult the registry — the lexer's `decorator` token, the
 * parser's attachment, the lint's checks, the resolution of names and tags,
 * the document's node, the scope a walk carries down, the rendering. A reader
 * never asks which decorator it holds.
 *
 * No imports from the compiler: the parser and the apx engine read this module.
 */
import { FORMULAS } from './formulas.js';
import { splitList } from './lists.js';

/** The mark a decorator line opens with. */
export const DECORATOR_MARK = '@';

/** A block a decorator item resolved to. */
export interface DecoratorUse {
  kind: string;
  name: string;
}

export interface DecoratorSpec {
  /** Its keyword, written after the mark: `WITH`, `WITHIN`. */
  key: string;
  /** The kinds of block its items name; a tag selects among them. */
  names: readonly string[];
  /** How the blocks a nested decorator names combine with the enclosing one's. */
  combine: 'union' | 'intersection';
  /** The opening of the sentence above the work it decorates: `For the work below, use`. */
  intro: string;
  /** The kind whose answer `AS <template>` may shape — one block of it, named alone; absent: no AS. */
  shape?: string;
  /**
   * The blocks it may stand above — and only above: written anywhere else, or
   * opening a block, it is an error. Absent: anywhere. A decorator whose
   * conditions the apx applies by itself is held to the blocks the apx knows
   * the bounds of at run time.
   */
  on?: readonly string[];
}

/**
 * `@WITH pdf, #policy:decisions` — the skills, policies and dimensions the work
 * it decorates is under; nested ones add up. `@WITH pdf-report AS report`
 * shapes one skill's answer as a template.
 */
export const WITH_DECORATOR: DecoratorSpec = {
  key: 'WITH', names: ['skill', 'policy', 'dimension'], combine: 'union', intro: FORMULAS.decorators.intros.WITH, shape: 'skill',
};

/**
 * `@WITHIN web` — the domains the work it decorates is done within (D44): it
 * writes only their WRITES files, reads only their READS ones. Nested, it
 * narrows: it names only domains of the one around it. The compiler lets no
 * ambiguous perimeter through — only above an agent, a team, a flow or a step,
 * the bounds the apx knows by itself.
 */
export const WITHIN_DECORATOR: DecoratorSpec = {
  key: 'WITHIN', names: ['domain'], combine: 'intersection', intro: FORMULAS.decorators.intros.WITHIN, on: ['AGENT', 'TEAM', 'FLOW', 'STEP'],
};

const DECORATORS: DecoratorSpec[] = [WITH_DECORATOR, WITHIN_DECORATOR];

/** Make a decorator known — one entry per key. */
export function registerDecorator(spec: DecoratorSpec): void {
  const at = DECORATORS.findIndex(decorator => decorator.key === spec.key);
  if (at >= 0) DECORATORS[at] = spec;
  else DECORATORS.push(spec);
}

/** The decorator of a key (`WITH`, with or without its mark), or null. */
export function decoratorOf(key: string): DecoratorSpec | null {
  const bare = key.startsWith(DECORATOR_MARK) ? key.slice(DECORATOR_MARK.length) : key;
  return DECORATORS.find(decorator => decorator.key === bare) ?? null;
}

/** Every decorator, in the order they were registered. */
export function decorators(): readonly DecoratorSpec[] {
  return DECORATORS;
}

/** `@WITHN`: what the lint says of a key no decorator has. */
export function unknownDecoratorMessage(key: string): string {
  const known = DECORATORS.map(decorator => `${DECORATOR_MARK}${decorator.key}`).join(', ') || 'none';
  return `\`${DECORATOR_MARK}${key}\`: no decorator has that name — the decorators: ${known}`;
}

/** A decorator line as written: its key, its items, where it stands. */
export interface DecoratorLine {
  key: string;
  rest: string;
  line: number;
}

/** `@WITHIN web` over a line, or at the end of a body: it decorates no block. */
export function danglingDecoratorMessage(key: string): string {
  return `\`${DECORATOR_MARK}${key}\` decorates no block — write it right above a block, at the block's indent, or open one: \`${DECORATOR_MARK}${key} …:\``;
}

/** A decorator held to some blocks (`on`), above another one — or opening a block: where it may stand. Null when it stands there. */
export function placementMessage(spec: DecoratorSpec, block: string | null): string | null {
  if (!spec.on || (block !== null && spec.on.includes(block))) return null;
  const where = block === null ? `\`${DECORATOR_MARK}${spec.key} …:\` opens a block` : `\`${DECORATOR_MARK}${spec.key}\` stands above ${block}`;
  return `${where} — ${DECORATOR_MARK}${spec.key} stands only right above ${orList(spec.on)}, whose bounds the apx knows at run time`;
}

/** A definition inside a decorator's block (`@WITH pdf:` around `PROCEDURE p:`): a definition is decorated from above. */
export function definitionInDecoratorMessage(key: string, block: string): string {
  return `\`${DECORATOR_MARK}${key} …:\` holds ${block}, a definition — a decorator's block holds lines and blocks like WHEN or IF: write \`${DECORATOR_MARK}${key} …\` right above the definition instead`;
}

/** A definition the decorator above it finds no work in (a TEMPLATE, a DOMAIN): it decorates nothing. */
export function workless(key: string, block: string): string {
  return `\`${DECORATOR_MARK}${key}\` stands above ${block}, which holds no work to decorate`;
}

/** A nested decorator that narrows, naming blocks the one around it does not: an error, never a silent intersection. */
export function escapeMessage(spec: DecoratorSpec, outside: readonly DecoratorUse[], outer: readonly DecoratorUse[]): string {
  const names = (us: readonly DecoratorUse[]) => us.map(use => `\`${use.name}\``).join(', ');
  return `\`${DECORATOR_MARK}${spec.key} ${outside.map(use => use.name).join(', ')}\`: the ${DECORATOR_MARK}${spec.key} around it names ${names(outer) || 'nothing'} — a nested ${DECORATOR_MARK}${spec.key} names only what that one does`;
}

/** `@WITH pdf:` with nothing nested below it: it opens a block that holds no line. */
export function emptyDecoratorMessage(key: string): string {
  return `\`${DECORATOR_MARK}${key} …:\` opens a block, and nothing is nested below it — indent the lines it is for under it`;
}

/** A tag item: `#<kind>:<tag>`, or `#<tag>` when the decorator names one kind only. */
const TAG_RE = /^#(?:([a-z][a-z0-9-]*):)?([a-zA-Z0-9][a-zA-Z0-9-]*)$/;
// A harness skill is named `plugin:skill`: a name may hold a colon.
const NAME_RE = /^[a-z0-9][\w:-]*$/;

/** A decorator line's rest as items, and the template its `AS` names — null when there is none. */
export function splitDecoratorRest(rest: string): { items: string[]; template: string | null } {
  const match = rest.trim().match(/^(.*?)(?:\s+AS\s+(\S+))?$/);
  return { items: splitList(match?.[1] ?? ''), template: match?.[2] ?? null };
}

/** What is wrong with an item's form, before anything resolves — null when it is well formed. */
export function decoratorItemError(spec: DecoratorSpec, item: string): string | null {
  const tag = TAG_RE.exec(item);
  if (tag) {
    if (!tag[1] && spec.names.length > 1) return `\`${item}\`: ${DECORATOR_MARK}${spec.key} names ${spec.names.join(', ')} — a tag says which: \`#<kind>:${tag[2]}\``;
    if (tag[1] && !spec.names.includes(tag[1])) return `\`${item}\`: ${DECORATOR_MARK}${spec.key} names ${spec.names.join(', ')} — not a ${tag[1]}`;
    return null;
  }
  return NAME_RE.test(item) ? null : `\`${item}\`: a decorator names blocks or tags — \`<name>\`, \`#<kind>:<tag>\``;
}

/** The blocks a decorator may name, of one kind — each with the tags its source gives it. */
export type DecoratorLookup = (kind: string) => readonly { name: string; tags: readonly string[] }[];

/**
 * A decorator's items as the blocks they name: a name among the blocks of its
 * kinds, a tag every block of those kinds that has it. What names nothing is
 * a problem, said once for every decorator.
 */
export function resolveDecorator(spec: DecoratorSpec, items: readonly string[], lookup: DecoratorLookup, template: string | null = null): { uses: DecoratorUse[]; problems: string[] } {
  const uses: DecoratorUse[] = [];
  const problems: string[] = [];
  const add = (use: DecoratorUse) => { if (!uses.some(existing => existing.kind === use.kind && existing.name === use.name)) uses.push(use); };
  for (const item of items) {
    const malformed = decoratorItemError(spec, item);
    if (malformed) { problems.push(malformed); continue; }
    const tag = TAG_RE.exec(item);
    if (tag) {
      const kinds = tag[1] ? [tag[1]] : spec.names;
      const found = kinds.flatMap(kind => lookup(kind).filter(definition => definition.tags.some(blockTag => blockTag.replace(/^#/, '') === tag[2])).map(definition => ({ kind, name: definition.name })));
      if (found.length === 0) problems.push(`\`${DECORATOR_MARK}${spec.key} ${item}\`: no imported ${orList(kinds)} has #${tag[2]}`);
      found.forEach(add);
      continue;
    }
    const kind = spec.names.find(candidateKind => lookup(candidateKind).some(definition => definition.name === item));
    if (kind) add({ kind, name: item });
    else problems.push(`\`${DECORATOR_MARK}${spec.key} ${item}\`: no imported ${orList(spec.names)} is called \`${item}\` — IMPORT it, or declare it here`);
  }
  if (template) problems.push(...shapeProblems(spec, uses, template, lookup));
  return { uses, problems };
}

/** `skill, policy or dimension`. */
function orList(words: readonly string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}` : words[0] ?? '';
}

/** What does not hold in an `AS <template>`: a decorator that shapes nothing, an unknown template, more than its one block. */
function shapeProblems(spec: DecoratorSpec, uses: readonly DecoratorUse[], template: string, lookup: DecoratorLookup): string[] {
  if (!spec.shape) return [`\`${DECORATOR_MARK}${spec.key} … AS ${template}\`: ${DECORATOR_MARK}${spec.key} shapes no answer — drop the AS`];
  const problems: string[] = [];
  if (!lookup('template').some(definition => definition.name === template)) problems.push(`\`AS ${template}\`: no imported template is called \`${template}\` — IMPORT it FROM @main.templates`);
  if (!(uses.length === 1 && uses[0].kind === spec.shape)) {
    const named = uses.length === 1 ? `the ${uses[0].kind} \`${uses[0].name}\`` : `${uses.length} blocks`;
    problems.push(`\`AS ${template}\` shapes the answer of one ${spec.shape} — this ${DECORATOR_MARK}${spec.key} names ${named}`);
  }
  return problems;
}

/**
 * The conditions a piece of work is done under, as a walk carries them down:
 * for each decorator, the blocks it names here. Entering a decorated block
 * gives a new scope — the enclosing one is never changed.
 */
export class DecoratorScope {
  private constructor(private readonly by: ReadonlyMap<string, readonly DecoratorUse[]>) {}

  static readonly EMPTY = new DecoratorScope(new Map());

  /** The blocks a decorator names here — null when none encloses this point. */
  get(key: string): readonly DecoratorUse[] | null {
    return this.by.get(key) ?? null;
  }

  /** The scope beneath a decorator: its blocks, combined with the enclosing ones of the same key. */
  enter(spec: DecoratorSpec, uses: readonly DecoratorUse[]): DecoratorScope {
    const outer = this.by.get(spec.key);
    const combined = !outer ? [...uses]
      : spec.combine === 'union' ? [...outer, ...uses.filter(use => !outer.some(outerUse => same(outerUse, use)))]
        : outer.filter(outerUse => uses.some(use => same(outerUse, use)));
    return new DecoratorScope(new Map([...this.by, [spec.key, combined]]));
  }

  /** What a narrowing decorator names that the enclosing one of its key does not — empty when nothing encloses it, or it adds up. */
  outside(spec: DecoratorSpec, uses: readonly DecoratorUse[]): DecoratorUse[] {
    const outer = this.by.get(spec.key);
    return spec.combine === 'intersection' && outer ? uses.filter(use => !outer.some(outerUse => same(outerUse, use))) : [];
  }
}

function same(left: DecoratorUse, right: DecoratorUse): boolean {
  return left.kind === right.kind && left.name === right.name;
}
