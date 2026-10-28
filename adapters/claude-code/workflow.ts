// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A flow as a Claude Code Workflow tool script — the harness executes the
 * delegations instead of the model following them as prose:
 *
 *   DELEGATE … BY <agent>       → await agent(<the task and its lines>, { agentType: <agent> })
 *   DELEGATE~ … BY <agent>      → the same call, started and not awaited
 *   WAIT <var>, … / WAIT ALL    → await what it names — each delivered or blocked
 *   DELEGATE … AS <template>    → the JSON Schema of what is handed over, enforced
 *                                  on the delegation that produces it (the one just
 *                                  before); only that result is passed on
 *   DELEGATE … BY <agent>       → without AS, every result so far is passed on
 *
 * The request travels as the workflow's `args.request`; the script returns
 * every delegation's result, in order. Every statement ends with `;`: a line
 * opening with `[` must never continue the one before it. A flow the script
 * cannot express — a step with a line of its own for whoever runs the flow
 * (a DO, an IF, a FORK), a delegation to a team or to the default delegate, a
 * `PARALLEL EACH` (its list is a variable the script does not hold), or
 * anything but steps at its top level — compiles to null, and its steps are
 * carried out as written.
 */
import type { ApBlock } from '../../src/apdoc/block.js';
import type { ApDocument } from '../../src/apdoc/document.js';
import type { ApDirectiveNode, ApShape } from '../../src/apdoc/types.js';
import { jsonSchemaOf } from '../../src/shapeSchema.js';
import { DELEGATE_VERB, WAIT_VERB, parseWait } from '../../src/delegation.js';
import { mdEnv } from '../md/index.js';
import { renderNodes } from '../md/toolkit.js';
import { dedentLines } from '../../src/apdoc/nodes.js';
import { refName } from '../md/phrases.js';

/** One delegation of the flow, in order: the step it is in, and its line. */
interface Call { step: string; line: ApDirectiveNode; key: string }
/** What the script does, in order: a delegation, or a WAIT over the ones it names. */
type Op = { call: Call } | { wait: Call[] };

export function compileWorkflow(flow: ApBlock, doc: ApDocument): string | null {
  const teams = new Set(doc.byKind('team').map(t => t.name));
  const ops: Op[] = [];
  let k = 0;
  for (const node of flow.body) {
    if (node.type !== 'step') return null;
    const running: Call[] = [];
    for (const line of node.body) {
      if (line.type !== 'directive') return null;
      if (line.keyword === DELEGATE_VERB) {
        if (!line.by || teams.has(line.by)) return null;
        const call = { step: node.title, line, key: `d${k++}` };
        ops.push({ call });
        if (line.async) running.push(call);
      } else if (line.keyword === WAIT_VERB) {
        const wait = parseWait(line.text);
        const taken = 'all' in wait ? [...running] : running.filter(c => c.line.into && wait.names.includes(refName(c.line.into)));
        for (const c of taken) running.splice(running.indexOf(c), 1);
        ops.push({ wait: taken });
      } else return null;
    }
  }
  const calls = ops.flatMap(op => ('call' in op ? [op.call] : []));
  if (calls.length === 0) return null;

  const env = mdEnv(doc);
  const lit = (v: unknown) => JSON.stringify(v);
  // A delegation's AS binds the answer of the one before it, when that one is awaited where it stands.
  const schemaFor = (i: number): ApShape | null => {
    const next = calls[i + 1];
    return next?.line.as && !calls[i].line.async ? next.line.as : null;
  };
  const expr = (c: Call, i: number): string => {
    const agent = c.line.by!;
    const text = [`Step ${lit(c.step)} of flow \`${flow.name}\`: ${c.line.text}`, ...dedentLines(renderNodes(env, c.line.body ?? [], true))].join('\n');
    const output = schemaFor(i);
    const schema = output ? schemaOf(output, doc) : null;
    const opts = [`agentType: ${lit(agent)}`, `label: ${lit(agent)}`, `phase: ${lit(c.step)}`, ...(schema ? [`schema: ${lit(schema)}`] : [])];
    return `agent(${lit('Request: ')} + request + ${lit(`\n\n${text}`)} + upstream(${lit(c.line.as ? 'shaped' : 'full')}), { ${opts.join(', ')} })`;
  };
  const record = (c: Call, value: string) => `results.push({ step: ${lit(c.step)}, by: ${lit(c.line.by)}, result: ${value} });`;

  const body: string[] = [];
  let phase: string | null = null;
  for (const op of ops) {
    if ('wait' in op) {
      if (op.wait.length === 0) continue;
      // Each started already; awaited in order, every one delivered or blocked — none stops the others.
      for (const c of op.wait) body.push(record(c, `await ${c.key}`));
      continue;
    }
    const c = op.call;
    const i = calls.indexOf(c);
    if (c.step !== phase) { body.push(`phase(${lit(c.step)});`); phase = c.step; }
    if (c.line.async) body.push(`const ${c.key} = ${expr(c, i)}.then(r => r, e => ({ blocked: String(e) }));`);
    else body.push(record(c, `await ${expr(c, i)}`));
  }

  const meta = {
    name: flow.name,
    description: flow.about ?? `the flow ${flow.name} (${flow.id}), compiled by agent-pack`,
    phases: [...new Set(calls.map(c => c.step))].map(title => ({ title })),
  };
  return [
    `export const meta = ${lit(meta)};`,
    `// Compiled by agent-pack from the flow \`${flow.name}\` (${flow.id}) — edit the .ap source, not this file.`,
    `const request = (args && args.request) || '(no request was passed: args.request)';`,
    `const results = [];`,
    // What a delegation is handed: every result so far, or — under an AS — only the one shaped for it.
    `function upstream(mode) {`,
    `  if (results.length === 0) return '';`,
    `  const passed = mode === 'shaped' ? results.slice(-1) : results;`,
    `  return '\\n\\nUpstream context — ' + (mode === 'shaped' ? 'only what you are handed, shaped for you' : 'every result so far') + ':\\n' + JSON.stringify(passed, null, 2);`,
    `}`,
    ...body,
    `return results;`,
    '',
  ].join('\n');
}

/** A template's JSON Schema, from the compiled document — null when the template is not in it. */
function schemaOf(shape: ApShape, doc: ApDocument): Record<string, unknown> | null {
  const slots = doc.slotsOf(shape.ref);
  return slots ? jsonSchemaOf(slots, doc.slotResolver()) : null;
}
