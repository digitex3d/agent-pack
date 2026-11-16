// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/** The terminals the ACP client runs an agent's commands in — only when its server's entry enables them. */
import { spawn, type ChildProcess } from 'node:child_process';
import { errorMessage } from '../../src/errors.js';
import { FORMULAS } from '../../src/formulas.js';
import { list, obj, RPC, RpcError, str, type Params } from './rpc.js';

type ExitStatus = { exitCode: number | null; signal: string | null };

interface Terminal {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  status: ExitStatus | null;
  exited: Promise<ExitStatus>;
}

/** Kill a process and everything it started — its group. */
export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // The group is already gone when the kill fails: nothing left to stop.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Over its byte limit, an output is cut from its start: the end is what matters. */
function keepEnd(t: Terminal, limit: number | null): void {
  while (limit !== null && Buffer.byteLength(t.output) > limit) {
    t.output = t.output.slice(Math.max(1, t.output.length - limit));
    t.truncated = true;
  }
}

export class Terminals {
  private readonly open = new Map<string, Terminal>();
  private made = 0;

  /** `cwdOf` resolves the cwd a terminal asks for — refusing one outside the copy. */
  constructor(private readonly cwdOf: (cwd: unknown) => string) {}

  create(params: Params): Params {
    const command = str(params.command);
    if (!command) throw new RpcError(RPC.invalidParams, FORMULAS.messages.acp.noCommand);
    // A malformed arg or env entry is refused: the command never runs with less than it asked for.
    const args = list(params.args);
    if (!args.every((a): a is string => typeof a === 'string')) throw new RpcError(RPC.invalidParams, FORMULAS.messages.acp.badArgs);
    const entries = list(params.env).map(obj).map(e => [str(e.name), str(e.value)] as const);
    if (entries.some(([name, value]) => !name || value === null)) throw new RpcError(RPC.invalidParams, FORMULAS.messages.acp.badEnv);
    const env = Object.fromEntries(entries);
    const limit = typeof params.outputByteLimit === 'number' ? params.outputByteLimit : null;
    const child = spawn(command, args, { cwd: this.cwdOf(params.cwd), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const t: Terminal = { child, output: '', truncated: false, status: null, exited: Promise.resolve({ exitCode: null, signal: null }) };
    const add = (d: Buffer | string): void => { t.output += d.toString(); keepEnd(t, limit); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    t.exited = new Promise(done => {
      child.on('error', e => { add(errorMessage(e)); t.status = { exitCode: null, signal: null }; done(t.status); });
      child.on('close', (exitCode, signal) => { t.status = { exitCode, signal }; done(t.status); });
    });
    const terminalId = `term-${++this.made}`;
    this.open.set(terminalId, t);
    return { terminalId };
  }

  output(params: Params): Params {
    const t = this.of(params);
    return { output: t.output, truncated: t.truncated, exitStatus: t.status };
  }

  waitForExit(params: Params): Promise<ExitStatus> {
    return this.of(params).exited;
  }

  kill(params: Params): Params {
    killGroup(this.of(params).child);
    return {};
  }

  release(params: Params): Params {
    killGroup(this.of(params).child);
    this.open.delete(str(params.terminalId) ?? '');
    return {};
  }

  /** Every terminal still running, stopped — at the end of the run. */
  closeAll(): void {
    for (const t of this.open.values()) killGroup(t.child);
  }

  private of(params: Params): Terminal {
    const t = this.open.get(str(params.terminalId) ?? '');
    if (!t) throw new RpcError(RPC.invalidParams, `no terminal ${String(params.terminalId)}`);
    return t;
  }
}
