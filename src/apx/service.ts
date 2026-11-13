// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * A service of the apx — what the executable does, at run time, for one kind
 * the language declares: a store, a dimension, a delegation (`DELEGATE`). One
 * service per kind, reached by the kind's own name in one form shared by all:
 *
 *   <apx> <kind> <operation> [<id>] …
 *
 * The service lists its operations — the help, the compiled definition and
 * the engine's dispatch read them here — and serves one call. What it may use
 * of the engine is `ApxHost`: the document, the output, the shared checks.
 */
import type { ApDocument } from '../apdoc/document.js';
import type { VarBlock } from '../apdoc/blocks.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef } from '../apdoc/types.js';
import type { ApxBuild } from './engine.js';
import type { SessionVars, ExecutorRecord } from './sessionVars.js';
import type { ApExecutorSpec } from '../executor.js';
import type { ContractWork } from './contractWork.js';
import { FORMULAS, fill } from '../formulas.js';

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
  /** The document's root — an agent, or a unit: its name is who the apx serves. */
  readonly root: ApBlock;
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
  /** The harness session id — or why there is none, opening with what `needs` it. */
  sessionIdOrReason(needs?: string): { id: string } | { reason: string };
  executorArg(verb: string, id: string | undefined): ApExecutorSpec | null;
  inputJson(spec: ApExecutorSpec, extra?: Record<string, unknown>): Record<string, unknown> | null;
  intoArg(spec: ApExecutorSpec, id: string, args: string[]): { spec: ApExecutorSpec; args: string[] } | null;
  answerShape(spec: ApExecutorSpec): ApRef | null;
  deliver(id: string, spec: ApExecutorSpec, text: string, outcome: ExecutorRecord['outcome'], fingerprint: string): string | null;
  delivered(id: string, spec: ApExecutorSpec, text: string): number;
  /** A formula filled with the values and the command prefix every printed command starts with. */
  phrase(formula: string, values?: Record<string, string | number>): string;
  /** Print a formula, filled. */
  say(formula: string, values?: Record<string, string | number>): void;
  /** Fail with a formula, filled — its exit code is returned. */
  refuse(code: number, formula: string, values?: Record<string, string | number>): number;
  /** This session's variables — or null after saying why there are none. */
  sessionVars(): SessionVars | null;
  /** The values this session holds for `names` — or the first one that is empty. */
  readVariables(session: SessionVars, names: string[]): { values: NamedValue[] } | { empty: string };
  /** The contracts: their verbs, the guard, and their own steps on copies (src/apx/contractWork.ts). */
  readonly contracts: ContractWork;
}

/** The node types of a block's body the apx reads. */
export const NODE = { when: 'when', run: 'run', directive: 'directive' } as const;

/** A variable's name and the value this session stores for it. */
export interface NamedValue { name: string; value: string }

/** What a caught value says, whatever was thrown. */
export const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What an empty variable is told — the caller says what follows from it. */
export const emptyVariable = (name: string): string => fill(FORMULAS.apx.variables.empty, { name });

/** Why a value cannot be checked: what holds it is typed with a template this agent was not compiled with. */
export function notCompiled(what: string, template: string): string {
  return `\`${what}\` is shaped as \`${template}\`, a template not compiled into this agent`;
}

/** `1 entry`, `3 entries`. */
export function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The command of one operation on one id, as the apx prints it: `<apx> <kind> <op> <id>`. */
export function serviceCommand(apx: string, kind: string, op: string, id = ''): string {
  return `${apx} ${kind} ${op}${id ? ` ${id}` : ''}`;
}
