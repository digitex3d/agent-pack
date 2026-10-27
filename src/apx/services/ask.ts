// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The `ask` service — a delegation (`ASK … BY`, `PROCEDURE*`, `IF*`): what the
 * delegate is handed, and its answer checked against the contract and kept.
 * `<apx> ask input <exe-id>`, `<apx> ask answer <exe-id> - [--into <var>]`.
 * A program's contract (`PROCEDURE**`, `COMPUTE`) is the engine's `run`.
 */
import { readFileSync } from 'fs';
import { FORMULAS, fill } from '../../formulas.js';
import { refName } from '../../../adapters/md/phrases.js';
import { jsonExample } from '../../shapeSchema.js';
import { sha256Hex } from '../../apdoc/ids.js';
import type { ApxHost, ApxService } from '../service.js';

export const askService: ApxService = {
  kind: 'ask',
  about: 'a delegation: what the delegate receives, and its answer',
  operations: [
    { op: 'input', args: '<exe-id>', about: 'what the delegate receives: the JSON of the variables and constants it reads, then the shape of its answer' },
    { op: 'answer', args: '<exe-id> - [--into <var>]', about: "store the delegate's answer (on stdin): checked against its contract, kept in its INTO variable" },
  ],
  serve(host, op, args) {
    switch (op) {
      case 'input': return input(host, args);
      case 'answer': return answer(host, args);
    }
    return host.fail(2, `${op ? `'${op}' is no operation of ask` : 'ask takes an operation'} — ${host.cmd} ask input|answer <exe-id> …`);
  },
};

/**
 * `input <exe-id>` — what a delegate is handed: the JSON it receives, and
 * nothing else, then the shape its answer takes — `{"holds": …}` for a
 * condition, its template's example, or plain text.
 */
function input(host: ApxHost, args: string[]): number {
  const spec = host.executorArg('ask input', args[0]);
  if (!spec) return host.lastCode;
  const json = host.inputJson(spec);
  if (!json) return host.lastCode;
  host.out(JSON.stringify(json, null, 1));
  const A = FORMULAS.keywords.EXECUTOR.answer;
  const shape = host.answerShape(spec);
  if (spec.output.holds) return host.print(A.holds);
  if (!shape) return host.print(A.text);
  const slots = host.doc.slotsOf(shape);
  host.out(fill(A.shaped, { name: refName(shape) }));
  return host.print(JSON.stringify(slots ? jsonExample(slots, host.doc.slotResolver()) : {}));
}

/** `answer <exe-id> -` — a delegate's answer, checked against its contract, stored and recorded. */
function answer(host: ApxHost, argv: string[]): number {
  const id = argv[0];
  const found = host.executorArg('ask answer', id);
  const into = found && host.intoArg(found, id!, argv);
  if (!into) return host.lastCode;
  const { spec, args } = into;
  const from = args[1];
  if (spec.executor !== 1) return host.fail(1, `a program carries out ${id}, not a delegate: ${host.cmd} run ${id}`);
  const text = from === '-' || from === undefined ? readFileSync(0, 'utf-8') : args.slice(1).join(' ');
  const json = host.inputJson(spec);
  if (!json) return host.lastCode;
  const broken = host.deliver(id!, spec, text, 'answered', sha256Hex(JSON.stringify(json)));
  if (broken) return host.fail(6, `the delegate's answer breaks the contract of ${id}: ${broken} — hand it over again, with the same input; nothing was stored`);
  return host.delivered(id!, spec, text);
}
