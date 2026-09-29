// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A flow as a Claude Code Workflow tool script — the harness executes the
 * steps instead of the model following them as prose:
 *
 *   STEP … BY <agent>   → agent(<the step's prose>, { agentType: <agent> })
 *   PARALLEL            → parallel([…])
 *   CONTEXT <mode>      → which upstream results the step's prompt carries (not
 *                         `inherited`: a fork has no counterpart in a script)
 *   AS <template>       → the JSON Schema of the step's input, enforced on the
 *                         step that produces it (the one just before)
 *
 * The request travels as the workflow's `args.request`; the script returns
 * every step's result, in order. Every statement ends with `;`: a line opening
 * with `[` must never continue the one before it. A flow the script cannot express — a step run
 * by a team, or anything but steps at its top level — compiles to null, and
 * its steps are carried out as written.
 */
import type { ApBlock } from '../../src/apdoc/block.js';
import type { ApDocument } from '../../src/apdoc/document.js';
import type { ApStepNode, ApShape } from '../../src/apdoc/types.js';
import { jsonSchemaOf } from '../../src/shapeSchema.js';
import { StepNode } from '../../src/apdoc/nodes.js';
import { enumPrimitiveFor } from '../../src/primitives.js';
import { mdEnv } from '../md/index.js';
import { refName } from '../md/phrases.js';

/**
 * The CONTEXT modes a script can pass upstream results by — `inherited` (a
 * fork of the caller) has no counterpart inside a workflow. A step without a
 * mode gets the full upstream context.
 */
const SCRIPT_MODES = ['isolated', 'summary', 'full'];
const DEFAULT_MODE = 'full';

/** One unit of the flow's sequence: a step alone, or steps run together. */
type Unit = ApStepNode[];

export function compileWorkflow(flow: ApBlock, doc: ApDocument): string | null {
  const units: Unit[] = [];
  for (const node of flow.body) {
    if (node.type === 'step') units.push([node]);
    else if (node.type === 'parallel') units.push(node.steps);
    else return null;
  }
  const steps = units.flat();
  if (steps.length === 0 || steps.some(s => s.by?.kind !== 'agent' || !SCRIPT_MODES.includes(s.context ?? DEFAULT_MODE))) return null;

  const env = mdEnv(doc);
  const context = enumPrimitiveFor('CONTEXT')!;
  const lit = (v: unknown) => JSON.stringify(v);
  const call = (step: ApStepNode, output: ApShape | null): string => {
    const agent = refName(step.by!);
    const text = [`Step ${lit(step.title)} of flow \`${flow.name}\`.`, ...StepNode.fromData(step).bodyLines(env)].join('\n');
    const schema = output ? schemaOf(output, doc) : null;
    const opts = [`agentType: ${lit(agent)}`, `label: ${lit(agent)}`, `phase: ${lit(step.title)}`, ...(schema ? [`schema: ${lit(schema)}`] : [])];
    return `agent(${lit('Request: ')} + request + ${lit(`\n\n${text}`)} + upstream(${lit(step.context ?? DEFAULT_MODE)}), { ${opts.join(', ')} })`;
  };

  const body: string[] = [];
  units.forEach((unit, i) => {
    // The next step's input shape binds this step's answer — when one step alone hands it over.
    const next = units[i + 1];
    const output = unit.length === 1 && next?.length === 1 ? next[0].shape : null;
    if (unit.length === 1) {
      const [step] = unit;
      body.push(`phase(${lit(step.title)});`);
      body.push(`results.push({ step: ${lit(step.title)}, by: ${lit(refName(step.by!))}, result: await ${call(step, output)} });`);
    } else {
      body.push(`const group${i} = await parallel([`);
      for (const step of unit) body.push(`  () => ${call(step, null)},`);
      body.push(`]);`);
      body.push(`${lit(unit.map(s => ({ step: s.title, by: refName(s.by!) })))}.forEach((s, j) => results.push({ ...s, result: group${i}[j] }));`);
    }
  });

  const meta = {
    name: flow.name,
    description: flow.about ?? `the flow ${flow.name} (${flow.id}), compiled by agent-pack`,
    phases: steps.map(s => ({ title: s.title })),
  };
  return [
    `export const meta = ${lit(meta)};`,
    `// Compiled by agent-pack from the flow \`${flow.name}\` (${flow.id}) — edit the .ap source, not this file.`,
    `const request = (args && args.request) || '(no request was passed: args.request)';`,
    `const results = [];`,
    // Each mode's meaning, as the language states it: what the step is told about the results it gets.
    `const CONTEXT = ${lit(Object.fromEntries(SCRIPT_MODES.map(m => [m, context.values[m]()])))};`,
    `function upstream(mode) {`,
    `  if (mode === 'isolated' || results.length === 0) return '';`,
    `  return '\\n\\nUpstream context — this step ' + CONTEXT[mode] + ':\\n' + JSON.stringify(results, null, 2);`,
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
