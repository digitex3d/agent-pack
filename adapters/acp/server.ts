// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * An ACP server, run: spawned in its own process group, its env values masked
 * in whatever of its words is shown, the session opened — what the delegation
 * client and the chat share.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { AcpServer } from './index.js';
import { errorMessage } from '../../src/errors.js';
import { promptUsage, type Usage } from './usage.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import { packageVersion } from '../../src/config.js';
import { RPC, RpcError, list, obj, str, type Connection, type Params } from './rpc.js';

const SAY = FORMULAS.messages.acp;

/** The ACP version this client speaks. */
const ACP_PROTOCOL_VERSION = 1;
/** A masked value shorter than this is left as it is: too short to be a secret, and masking it would mangle the text. */
const MASKED_MIN_LENGTH = 4;
/** The names of env variables that look like they hold a secret — their values are masked. */
const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/i;
/** How much of the server's stderr is kept, and how many of its last lines a failure quotes. */
const STDERR_KEPT = 2000;
const STDERR_QUOTED_LINES = 5;

/** The environment a server runs in: ours, its entry's over it, and `extra` over both. */
function serverEnv(server: Pick<AcpServer, 'env'>, extra: Record<string, string>): Record<string, string | undefined> {
  return { ...process.env, ...server.env, ...extra };
}

/**
 * A text with the server's secrets masked: the values of the variables of the
 * environment it runs in — inherited ones too — whose names look like a
 * secret, or that its entry's `mask` lists; every other value stays readable.
 */
export function maskerOf(server: Pick<AcpServer, 'env' | 'mask'>, extra: Record<string, string> = {}): (text: string) => string {
  const listed = new Set(server.mask);
  const secrets = Object.entries(serverEnv(server, extra))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([name, value]) => (SECRET_NAME_RE.test(name) || listed.has(name)) && value.length >= MASKED_MIN_LENGTH)
    .map(([, value]) => value);
  return text => secrets.reduce((t, s) => t.split(s).join('***'), text);
}

/** A server, started in `cwd` in its environment (`serverEnv`) — and the end of its stderr, masked, for a failure to quote. */
export function spawnServer(server: AcpServer, cwd: string, mask: (text: string) => string, extra: Record<string, string> = {}): { child: ChildProcess; lastWords: () => string } {
  const child = spawn(server.command, server.args, { cwd, env: serverEnv(server, extra), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr = `${stderr}${d.toString()}`.slice(-STDERR_KEPT); });
  const lastWords = (): string => (stderr.trim() ? ` — its stderr ends with: ${mask(stderr.trim().split('\n').slice(-STDERR_QUOTED_LINES).join(' | '))}` : '');
  return { child, lastWords };
}

/** `initialize` — the auth methods the agent offers, by id. */
export async function initialize(conn: Connection, terminal: boolean): Promise<string[]> {
  const init = obj(await conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal },
    clientInfo: { name: 'agent-pack', version: packageVersion() },
  }));
  if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error(fill(SAY.version, { theirs: String(init.protocolVersion), ours: ACP_PROTOCOL_VERSION }));
  return list(init.authMethods).flatMap(m => str(obj(m).id) ?? []);
}

/** `session/new` in `cwd` — the session, or an Error; a sign-in it demands is a failure that says so, never handled here. */
export async function openSession(conn: Connection, at: { harness: string; cwd: string; methods: string[]; mask: (text: string) => string }): Promise<{ sessionId: string; opened: Params }> {
  let opened: Params;
  try {
    opened = obj(await conn.request('session/new', { cwd: at.cwd, mcpServers: [] }));
  } catch (e) {
    if (e instanceof RpcError && (e.code === RPC.authRequired || /auth/i.test(e.message))) {
      const offers = at.methods.length ? fill(SAY.offers, { methods: at.methods.join(', ') }) : '';
      throw new Error(fill(SAY.signIn, { harness: at.harness, offers }));
    }
    throw new Error(fill(SAY.sessionFailed, { why: at.mask(errorMessage(e)) }));
  }
  const sessionId = str(opened.sessionId);
  if (!sessionId) throw new Error(SAY.noSession);
  return { sessionId, opened };
}

/** One turn: `text` sent as the prompt — the reason the turn ended (null when the agent gave none), and its usage when reported. */
export async function prompt(conn: Connection, sessionId: string, text: string): Promise<{ stopReason: string | null; usage: Usage | null }> {
  const answer = obj(await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }));
  return { stopReason: str(answer.stopReason), usage: promptUsage(answer) };
}

/** An error the server answered with, in its own words masked; the client's own errors as they are. */
export function maskedError(e: unknown, mask: (text: string) => string): unknown {
  return e instanceof RpcError ? new Error(fill(SAY.answered, { why: mask(e.message) })) : e;
}
