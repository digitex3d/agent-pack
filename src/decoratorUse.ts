// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A decorator read against a compilation (src/decorators.ts): the blocks its
 * items name among those the compilation imports, what names nothing, and
 * the sentence the compiled definition prints above the work it decorates.
 * The document builder and the standalone renderer both read a decorator
 * here; they differ only in how they print an id.
 */
import type { Token } from './lexer.js';
import type { BundleContext } from './dispatch/types.js';
import { STRATEGIES, type Definition } from './definition.js';
import { FORMULAS, fill } from './formulas.js';
import { decoratorOf, resolveDecorator, splitDecoratorRest, type DecoratorSpec, type DecoratorLookup } from './decorators.js';

/** A decorator line, read: its entry, the definitions it names, the template its AS names, what does not hold. */
export interface DecoratorRead {
  spec: DecoratorSpec;
  uses: Definition[];
  template: Definition | null;
  problems: string[];
}

/** The definitions a decorator may name, by kind — the compilation's imports. */
export function lookupIn(ctx: BundleContext): (kind: string) => Definition[] {
  return kind => STRATEGIES.find(strategy => strategy.kind === kind)?.getEntries(ctx) ?? [];
}

/** A decorator token read against the compilation — null for any other token, or a key no decorator has (the lint's). */
export function readDecorator(token: Token, ctx: BundleContext): DecoratorRead | null {
  if (token.kind !== 'decorator') return null;
  const spec = decoratorOf(token.key);
  if (!spec) return null;
  const defs = lookupIn(ctx);
  const lookup: DecoratorLookup = kind => defs(kind);
  const { items, template } = splitDecoratorRest(token.rest);
  const { uses, problems } = resolveDecorator(spec, items, lookup, template);
  return {
    spec, problems,
    uses: uses.map(use => defs(use.kind).find(definition => definition.name === use.name)!),
    template: template ? defs('template').find(definition => definition.name === template) ?? null : null,
  };
}

/** The sentence above the work a decorator decorates: its opening, each block it names with its id, the shape of its answer. */
export function decoratorPhrase(spec: DecoratorSpec, uses: { kind: string; name: string; ref: string }[], shape?: { name: string; ref: string }): string {
  const decoratorFormulas = FORMULAS.decorators;
  const named = uses.map(use => fill(decoratorFormulas.use, use));
  const listed = named.length > 1 ? `${named.slice(0, -1).join(', ')}${decoratorFormulas.and}${named[named.length - 1]}` : named[0] ?? '';
  const text = shape ? fill(FORMULAS.keywords.AS.shaped, { text: listed, name: shape.name, ref: shape.ref }) : listed;
  return `${spec.intro} ${text}`.trimEnd();
}
