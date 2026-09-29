// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { FORMULAS, fill } from './formulas.js';
/**
 * Definition arguments — the declarative split between a block's *signature*
 * and its *body*.
 *
 * Some child keywords are not body content but attributes of the enclosing
 * definition — its signature. This mirrors how an AGENT's MANDATE and bound ROLE
 * are the agent's identity (rendered apart from its body), not playbook lines.
 *
 * A STEP works the same way: `BY` (executor) and `CONTEXT` (how much upstream
 * context) describe the step, while `DO`/`RUN` are what it does. The renderer
 * folds the arguments into the step's head line and renders only the body
 * beneath it.
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
}

export const DEFINITION_ARGS: Record<string, ArgumentSpec[]> = {
  STEP: [
    { keyword: 'BY', inline: v => fill(FORMULAS.keywords.STEP.args.find(a => a.keyword === 'BY')!.formula, { value: v }) },
    { keyword: 'CONTEXT', inline: v => fill(FORMULAS.keywords.STEP.args.find(a => a.keyword === 'CONTEXT')!.formula, { value: v }) },
  ],
  // AGENT carries its signature argument on the HEADER line, not as a child:
  // `AGENT <name> AS <role>:`. `AS` binds the agent to the NAME of a role
  // — distinct from STEP's `AS`, which declares a response shape. `inline`
  // renders the binding for any signature-line consumer.
  AGENT: [
    { keyword: 'AS', inline: v => fill(FORMULAS.keywords.AS.agent, { value: v }) },
  ],
};

export function definitionArgsFor(blockKeyword: string): ArgumentSpec[] {
  return DEFINITION_ARGS[blockKeyword] ?? [];
}

/** Parsed signature of an `AGENT <name> AS <role>:` header. */
export interface AgentSignature {
  /** The role name bound via `AS <role>`, or null when absent. */
  role: string | null;
}

/** Matches a leading `AS <role>` clause in an AGENT header's `rest`. */
const AGENT_AS_RE = /^AS[ \t]+(\S+)\b/;

/**
 * Parse an AGENT block's header `rest` (everything after `AGENT <name>`) into
 * its signature arguments. Today the only argument is `AS <role>`; the parser
 * is deliberately narrow so the `.ap` source stays readable and unambiguous.
 *
 * `AS` is the agent's signature binding — parallel to how STEP's `BY`/`CONTEXT`
 * are signature arguments rather than body — so it is read here, not treated as
 * a body line.
 */
export function parseAgentSignature(rest: string): AgentSignature {
  const m = rest.trim().match(AGENT_AS_RE);
  return { role: m ? m[1] : null };
}
