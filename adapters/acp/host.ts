// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The client's side of an ACP session — what the agent asks of it: its
 * permissions (decided by whoever runs the session), its files, read and
 * written only inside `root` (./perimeter.ts), and its terminals, only when
 * its server's entry enables them (./terminals.ts). The delegation client and
 * the chat both serve an agent through it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage } from '../../src/errors.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import { RPC, RpcError, str, type Params } from './rpc.js';
import { insideCopy } from './perimeter.js';
import { Terminals } from './terminals.js';

const SAY = FORMULAS.messages.acp;

export interface HostOptions {
  harness: string;
  /** The folder the agent works in: nothing outside it is read or written. */
  root: string;
  terminal: boolean;
  /** Where a refusal is said. */
  report: (line: string) => void;
  /** The answer to a `session/request_permission`. */
  permission: (params: Params) => Params | Promise<Params>;
}

export class Host {
  readonly terminals: Terminals;
  private readonly handlers: Record<string, (params: Params) => unknown>;

  constructor(private readonly o: HostOptions) {
    this.terminals = new Terminals(cwd => this.inside('terminal/create', cwd ?? o.root));
    this.handlers = {
      'session/request_permission': p => o.permission(p),
      'fs/read_text_file': p => this.read(p),
      'fs/write_text_file': p => this.write(p),
      'terminal/create': p => this.terminals.create(p),
      'terminal/output': p => this.terminals.output(p),
      'terminal/wait_for_exit': p => this.terminals.waitForExit(p),
      'terminal/kill': p => this.terminals.kill(p),
      'terminal/release': p => this.terminals.release(p),
    };
  }

  readonly onRequest = async (method: string, params: Params): Promise<unknown> => {
    if (method.startsWith('terminal/') && !this.o.terminal) {
      this.o.report(fill(SAY.terminalsRefused, { method, harness: this.o.harness }));
      throw new RpcError(RPC.methodNotFound, fill(SAY.terminalsOff, { harness: this.o.harness }));
    }
    const handle = this.handlers[method];
    if (!handle) throw new RpcError(RPC.methodNotFound, fill(SAY.notServed, { method }));
    return handle(params);
  };

  /** A path the agent names, resolved in the root — refused, and reported, outside it. */
  private inside(method: string, path: unknown): string {
    const p = str(path);
    if (p === null) throw new RpcError(RPC.invalidParams, fill(SAY.needsPath, { method }));
    if (!insideCopy(this.o.root, p)) {
      this.o.report(fill(SAY.refusedOutside, { method, path: p }));
      throw new RpcError(RPC.invalidParams, SAY.outside);
    }
    return resolve(this.o.root, p);
  }

  private read(params: Params): Params {
    const file = this.inside('fs/read_text_file', params.path);
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch (e) { throw new RpcError(RPC.internal, `cannot read ${str(params.path)}: ${errorMessage(e)}`); }
    if (params.line === undefined && params.limit === undefined) return { content: text };
    const from = Math.max(0, (typeof params.line === 'number' ? params.line : 1) - 1);
    const to = typeof params.limit === 'number' ? from + params.limit : undefined;
    return { content: text.split('\n').slice(from, to).join('\n') };
  }

  private write(params: Params): null {
    const file = this.inside('fs/write_text_file', params.path);
    // No content as text is a malformed request: refused, never written as an empty file.
    const content = str(params.content);
    if (content === null) throw new RpcError(RPC.invalidParams, SAY.needsContent);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return null;
  }
}
