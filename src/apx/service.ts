// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A service of the apx — what the executable does, at run time, for one kind
 * the language declares: a store, a dimension, a delegation (`ASK`). One
 * service per kind, reached by the kind's own name in one form shared by all:
 *
 *   <apx> <kind> <operation> [<id>] …
 *
 * The service lists its operations — the help, the compiled definition and
 * the engine's dispatch read them here — and serves one call. What it may use
 * of the engine is `ApxHost`: the document, the output, the shared checks.
 */
import type { ApDocument } from '../apdoc/document.js';
import type { AgentBlock, VarBlock } from '../apdoc/blocks.js';
import type { ApRef } from '../apdoc/types.js';
import type { ApxBuild } from './engine.js';
import type { SessionVars, ExecutorRecord } from './sessionVars.js';
import type { ApExecutorSpec } from '../executor.js';

/** One operation of a service: its name, what follows it, what it does — as the help prints it. */
export interface ApxOperation {
  op: string;
  /** What follows the operation, `<id>` first when it takes one. */
  args: string;
  about: string;
}

export interface ApxService {
  /** The kind served — the word after the apx. */
  kind: string;
  /** One line: what the service is, for the help. */
  about: string;
  operations: ApxOperation[];
  /** Serve one call: the operation (undefined when none was given) and what follows it. */
  serve(host: ApxHost, op: string | undefined, args: string[]): number | Promise<number>;
}

/** What a service may use of the engine. */
export interface ApxHost {
  readonly doc: ApDocument;
  readonly build: ApxBuild;
  /** The path the harness invoked the apx by. */
  readonly exe: string;
  /** The command every printed command starts with. */
  readonly cmd: string;
  readonly root: AgentBlock;
  /** The project root the apx lives in. */
  readonly projectRoot: string;
  lastCode: number;
  out(line: string): void;
  print(text: string): number;
  fail(code: number, message: string): number;
  /** A JSON text checked against a template's slots — the issues, or null. */
  contractIssues(json: string, template: ApRef, list?: { name: string; min: number }): string | null;
  variable(name: string): VarBlock | null;
  storeVariable(block: VarBlock, value: string): { code: number; reason: string } | null;
  openSession(): SessionVars | string;
  executorArg(verb: string, id: string | undefined): ApExecutorSpec | null;
  inputJson(spec: ApExecutorSpec, extra?: Record<string, unknown>): Record<string, unknown> | null;
  intoArg(spec: ApExecutorSpec, id: string, args: string[]): { spec: ApExecutorSpec; args: string[] } | null;
  answerShape(spec: ApExecutorSpec): ApRef | null;
  deliver(id: string, spec: ApExecutorSpec, text: string, outcome: ExecutorRecord['outcome'], fingerprint: string): string | null;
  delivered(id: string, spec: ApExecutorSpec, text: string): number;
}

/** `1 entry`, `3 entries`. */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The command of one operation on one id, as the apx prints it: `<apx> <kind> <op> <id>`. */
export function serviceCommand(apx: string, kind: string, op: string, id = ''): string {
  return `${apx} ${kind} ${op}${id ? ` ${id}` : ''}`;
}
