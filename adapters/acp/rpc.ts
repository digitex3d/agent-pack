// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** JSON-RPC 2.0 over a child's stdio, one message a line — the wire of the ACP client. */
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { errorMessage } from '../../src/errors.js';

/** JSON-RPC error codes the client answers with, or reads. */
export const RPC = { methodNotFound: -32601, invalidParams: -32602, internal: -32603, authRequired: -32000 } as const;

/** A JSON-RPC error, as a request is answered with — or as the server answered one. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export type Params = Record<string, unknown>;
/** A value as an object — an empty one when it is none. */
export const obj = (v: unknown): Params => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Params : {});
/** A value as a string — null when it is none. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A value as a list — an empty one when it is none. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One connection: requests out, the server's requests and notifications in. */
export class Connection {
  private next = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly child: ChildProcess,
    private readonly onRequest: (method: string, params: Params) => Promise<unknown>,
    private readonly onNotification: (method: string, params: Params) => void,
  ) {
    if (child.stdout) createInterface({ input: child.stdout }).on('line', line => this.receive(line));
  }

  request(method: string, params: Params): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** A notification: no answer awaited. */
  notify(method: string, params: Params): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: Params): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: Params;
    // A line that is no JSON is a server's own logging on stdout: not a message, so not one to answer.
    try { message = obj(JSON.parse(line)); } catch { return; }
    const method = str(message.method);
    if (method !== null && message.id !== undefined) this.answer(message.id, method, obj(message.params));
    else if (method !== null) this.onNotification(method, obj(message.params));
    else if (typeof message.id === 'number') this.settle(message.id, message);
  }

  private answer(id: unknown, method: string, params: Params): void {
    this.onRequest(method, params).then(
      result => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
      (e: unknown) => this.send({ jsonrpc: '2.0', id, error: { code: e instanceof RpcError ? e.code : RPC.internal, message: errorMessage(e) } }),
    );
  }

  private settle(id: number, message: Params): void {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (message.error === undefined) { waiting.resolve(message.result); return; }
    const error = obj(message.error);
    waiting.reject(new RpcError(typeof error.code === 'number' ? error.code : RPC.internal, str(error.message) ?? 'error'));
  }
}
