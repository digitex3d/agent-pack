// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * agent-pack's ACP client — what the recipe `invoke.ap` runs to hand one task
 * to an agent that speaks the Agent Client Protocol (D66):
 *
 *   node client.js --server <harness> --project <copy> --prompt <file> --answer <file> [--agent <agent>] [--model <id>]
 *
 * It reads the server's entry from the project's config, spawns it in the
 * copy, speaks JSON-RPC 2.0 over its stdio (./rpc.ts), opens a session with
 * the copy as its cwd, sends the prompt, and writes the agent's last message
 * of the turn to the answer file. Any failure — a refusal, a cancelled turn,
 * an error, the server exiting, the timeout — exits non-zero with the reason
 * on stderr, and leaves no answer file.
 *
 * Fail closed: a permission is approved only when every path the tool call
 * touches is inside the copy (./perimeter.ts); files are read and written
 * only inside it; terminals (./terminals.ts) only when the server's entry
 * enables them. Never a secret: the agent signs in with its own credentials,
 * and the server's env values are masked in the server's words this client prints.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AcpServer } from './index.js';
import { parseDuration } from '../../src/delegation.js';
import { errorMessage } from '../../src/errors.js';
import { FORMULAS, fill } from '../../src/formulas.js';
import { WORK_DIR } from '../../src/apx/paths.js';
import { Connection, list, obj, str, type Params } from './rpc.js';
import { answerPermission, type Verdict } from './perimeter.js';
import { killGroup } from './terminals.js';
import { reportedModel } from './usage.js';
import { Host } from './host.js';
import { initialize, maskedError, maskerOf, openSession, prompt, spawnServer } from './server.js';
import { MODEL_OPTION, SESSION_UPDATE, STOP_REASON, TEXT_CONTENT, TURN_END } from './protocol.js';
import { EVENTS_ENV, SOURCE_ENV, EVENT_KIND, VERDICT_STATUS, TurnEvents, eventSink, participantOf, type EventSink } from './events.js';

export { insideCopy, permissionVerdict } from './perimeter.js';

const SAY = FORMULAS.messages.acp;

/** The client's exit codes. */
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** What one run is given: the harness's name and server, the copy, the prompt's text, the model — and where it reports. */
export interface AcpRun {
  harness: string;
  /** The agent of the project the harness runs — null when none is named. */
  agent: string | null;
  server: AcpServer;
  project: string;
  prompt: string;
  model: string | null;
  report: (line: string) => void;
  /** The chat's events file, when the run is no process of the chat's own — else the environment's, if any. */
  events?: string;
  /** Aborted: the run stops, the server with it — a chat's Ctrl-C. */
  signal?: AbortSignal;
}

/** One session with the agent: what it says, and the conversation itself — what it asks of the client, its host's. */
class Session {
  readonly host: Host;
  private message = '';
  private readonly turn: TurnEvents | null;

  constructor(private readonly run: AcpRun, private readonly mask: (text: string) => string, private readonly report: (line: string) => void, private readonly sink: EventSink | null) {
    this.turn = sink ? new TurnEvents(sink) : null;
    this.host = new Host({
      harness: run.harness, root: run.project, terminal: run.server.terminal, report,
      permission: p => answerPermission(run.project, p, run.server.terminal, v => this.decided(v)),
    });
  }

  readonly onNotification = (method: string, params: Params): void => {
    if (method !== SESSION_UPDATE.method) return;
    const update = obj(params.update);
    this.turn?.update(update);
    const content = obj(update.content);
    if (update.sessionUpdate === SESSION_UPDATE.agentMessageChunk && content.type === TEXT_CONTENT) this.message += str(content.text) ?? '';
    // The answer is the agent's last message: what it said before a tool call is not it.
    if (update.sessionUpdate === SESSION_UPDATE.toolCall) this.message = '';
  };

  /** The conversation: initialize, open the session in the copy, set the model, send the prompt — the agent's last message. */
  async converse(conn: Connection): Promise<string> {
    const methods = await initialize(conn, this.run.server.terminal);
    const { sessionId, opened } = await openSession(conn, { harness: this.run.harness, cwd: this.run.project, methods, mask: this.mask });
    const picked = this.run.model ? await pickModel(conn, { sessionId, opened, model: this.run.model, report: this.report }) : null;
    // The model in effect: the one set, else the one the agent reports.
    this.turn?.model(picked ?? reportedModel(opened));
    this.message = '';
    const { stopReason, usage } = await prompt(conn, sessionId, this.run.prompt);
    this.turn?.end(stopReason ?? TURN_END.none, usage);
    if (stopReason !== STOP_REASON.endTurn) throw new Error(fill(SAY.noAnswer, { reason: stopReason ?? '(none)' }));
    if (this.message.trim() === '') throw new Error(SAY.noMessage);
    return this.message;
  }

  /** A permission decided on its own: a refusal said on stderr; either written to the chat's events, when there is a chat. */
  private decided(v: Verdict): void {
    if (!v.allowed) this.report(fill(SAY.refusedPermission, { what: v.what, why: v.why }));
    this.sink?.(EVENT_KIND.verdict, `${v.what}: ${v.why}`, v.allowed ? VERDICT_STATUS.allowed : VERDICT_STATUS.refused);
  }
}

/** The model of the session, set the way the agent advertises — a model config option, or its model list; else its default, said. The model set — null when none was. */
async function pickModel(conn: Connection, at: { sessionId: string; opened: Params; model: string; report: (line: string) => void }): Promise<string | null> {
  const { sessionId, opened, model } = at;
  const option = str(list(opened.configOptions).map(obj).find(o => o.category === MODEL_OPTION || o.id === MODEL_OPTION)?.id);
  if (option) {
    await conn.request('session/set_config_option', { sessionId, configId: option, value: model });
    return model;
  }
  const offered = list(obj(opened.models).availableModels).map(m => str(obj(m).modelId));
  if (offered.includes(model)) {
    await conn.request('session/set_model', { sessionId, modelId: model });
    return model;
  }
  at.report(fill(SAY.modelDefault, { model, why: offered.length ? SAY.modelNotOffered : SAY.modelNoWay }));
  return null;
}

/** What ends a run before its answer — the server not starting, exiting, the timeout — and how to stop watching. */
function watch(child: ChildProcess, server: AcpServer, lastWords: () => string, signal?: AbortSignal): { stopped: Promise<never>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error(SAY.cancelled)), { once: true });
    child.on('error', e => reject(new Error(`cannot start ${server.command}: ${errorMessage(e)}`)));
    child.on('exit', (code, signal) => reject(new Error(fill(SAY.serverExited, { how: signal ?? fill(SAY.exitCode, { code: String(code) }), lastWords: lastWords() }))));
    timer = setTimeout(() => reject(new Error(fill(SAY.timeout, { timeout: server.timeout }))), parseDuration(server.timeout) ?? 0);
  });
  return {
    stopped,
    stop: () => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      stopped.catch(() => { /* settled after the run: nobody waits for it */ });
    },
  };
}

/**
 * One task, run on an ACP agent: the agent's last message of the turn — or an
 * Error saying why there is none. The server is stopped either way. Inside a
 * chat (`AGENT_PACK_CHAT_EVENTS` set) its updates and verdicts are also
 * written to the chat's events, tagged with the harness.
 */
export async function runAcp(run: AcpRun): Promise<string> {
  const mask = maskerOf(run.server);
  // What the client reports names the server's tool calls and paths: masked too.
  const report = (line: string): void => run.report(mask(line));
  const events = run.events ?? process.env[EVENTS_ENV];
  // A chat's events that cannot be written are not the run's failure: it goes on without them, and says so.
  const sink = events ? eventSink(events, participantOf(run.harness, run.agent), mask, why => report(fill(SAY.eventsLost, { why }))) : null;
  // Its commands write to the chat's events — an apx it reads, its identity — under its participant's name.
  const { child, lastWords } = spawnServer(run.server, run.project, mask, { [SOURCE_ENV]: participantOf(run.harness, run.agent), ...(events ? { [EVENTS_ENV]: events } : {}) });
  const session = new Session(run, mask, report, sink);
  const conn = new Connection(child, session.host.onRequest, session.onNotification);
  const { stopped, stop } = watch(child, run.server, lastWords, run.signal);
  try {
    return await Promise.race([session.converse(conn), stopped]);
  } catch (e) {
    const failed = maskedError(e, mask);
    sink?.(EVENT_KIND.notice, `failed — ${errorMessage(failed)}`);
    throw failed;
  } finally {
    stop();
    session.host.terminals.closeAll();
    child.stdin?.end();
    killGroup(child);
  }
}

/** A flag's value among the arguments — null when it is not given. */
function flag(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : null;
}

/** The project a copy belongs to — the folder above its `.agent-pack/work/` — else the folder the command runs from. */
function projectOfCopy(copy: string): string {
  const at = copy.indexOf(`${sep}${WORK_DIR.split('/').join(sep)}${sep}`);
  return at > 0 ? copy.slice(0, at) : process.cwd();
}

/** The server a harness reaches, from the project's config — where the copy belongs. */
async function serverOf(copy: string, harness: string): Promise<AcpServer> {
  const root = projectOfCopy(copy);
  const configFile = join(root, 'agent-pack.config.mjs');
  if (!existsSync(configFile)) throw new Error(fill(SAY.noConfig, { root }));
  // The config resolves its paths from the project root, as every agent-pack command does.
  process.chdir(root);
  const { loadConfig } = await import('../../src/config.js');
  const { acpServerOf } = await import('./index.js');
  const server = acpServerOf((await loadConfig(['--config', configFile])).adapters, harness);
  if (!server) throw new Error(fill(SAY.noServer, { harness }));
  return server;
}

async function main(args: string[]): Promise<number> {
  const [harness, project, promptFile, answerFile] = ['--server', '--project', '--prompt', '--answer'].map(f => flag(args, f));
  const say = (line: string): void => { process.stderr.write(`acp ${harness ?? ''}: ${line}\n`); };
  if (!harness || !project || !promptFile || !answerFile) {
    say('usage: client.js --server <harness> --project <copy> --prompt <file> --answer <file> [--agent <agent>] [--model <id>]');
    return EXIT.usage;
  }
  const answer = resolve(answerFile);
  // A failed run leaves no answer behind — not even an earlier one.
  rmSync(answer, { force: true });
  try {
    const copy = realpathSync(resolve(project));
    const prompt = readFileSync(resolve(promptFile), 'utf-8');
    const server = await serverOf(copy, harness);
    const text = await runAcp({ harness, agent: flag(args, '--agent'), server, project: copy, prompt, model: flag(args, '--model'), report: say });
    writeFileSync(answer, text.endsWith('\n') ? text : `${text}\n`);
    return EXIT.ok;
  } catch (e) {
    say(`failed — ${errorMessage(e)}`);
    return EXIT.failed;
  }
}

// Run as a script — not imported, as the tests do.
const [, script, ...args] = process.argv;
if (script && import.meta.url === pathToFileURL(realpathSync(script)).href) {
  void main(args).then(code => process.exit(code));
}
