// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { FORMULAS, fill } from './formulas.js';
import { splitList } from './lists.js';
/**
 * Definition arguments — the declarative split between a block's *signature*
 * and its *body*.
 *
 * Some child keywords are not body content but attributes of the enclosing
 * definition — its signature. This mirrors how an AGENT's MANDATE and bound ROLE
 * are the agent's identity (rendered apart from its body), not body lines.
 *
 * This registry is the single source of truth: declaring that another block
 * kind has signature arguments is one entry here, with zero renderer changes —
 * the renderer asks `definitionArgsFor(<block>)`, it never names STEP.
 */
export interface ArgumentSpec {
  /** The child keyword that is a signature argument (e.g. `BY`). */
  keyword: string;
  /** Render the argument's value as an inline signature fragment. */
  inline(value: string): string;
  /** The argument's value, and the body line it also stands for (null when none). */
  split?(value: string): { value: string; line: string | null };
}

export const DEFINITION_ARGS: Record<string, ArgumentSpec[]> = {
  // AGENT carries its signature argument on the HEADER line, not as a child:
  // `AGENT <name> AS <role>:`. `AS` binds the agent to the NAME of a role
  // — distinct from a DELEGATE's `AS`, which shapes what is handed over. `inline`
  // renders the binding for any signature-line consumer.
  AGENT: [
    { keyword: 'AS', inline: v => fill(FORMULAS.keywords.AS.agent, { value: v }) },
  ],
};

export function definitionArgsFor(blockKeyword: string): ArgumentSpec[] {
  return DEFINITION_ARGS[blockKeyword] ?? [];
}

/** Parsed signature of an `AGENT <name> AS <role>, …:` header. */
export interface AgentSignature {
  /** The roles bound via `AS <role>, …`, in the order written — empty when the agent binds none. */
  roles: string[];
}

/** Matches a leading `AS <role>, …` clause in an AGENT header's `rest`, up to its colon. */
const AGENT_AS_RE = /^AS[ \t]+(.+?)[ \t]*:?[ \t]*$/;

/**
 * Parse an AGENT block's header `rest` (everything after `AGENT <name>`) into
 * its signature arguments. Today the only argument is `AS <role>, …`: the
 * roles the agent binds, a list like every list of the language (src/lists.ts)
 * — one role is a list of one.
 *
 * `AS` is the agent's signature binding — parallel to how a DELEGATE's `BY`/`AS`
 * are signature arguments rather than body — so it is read here, not treated as
 * a body line.
 */
export function parseAgentSignature(rest: string): AgentSignature {
  return { roles: splitList(agentAsText(rest)).map(item => item.split(/\s+/)[0]) };
}

/** The text of the `AS` clause of an AGENT header, as written — empty when there is none; the lint checks its list form. */
export function agentAsText(rest: string): string {
  return rest.trim().match(AGENT_AS_RE)?.[1] ?? '';
}
