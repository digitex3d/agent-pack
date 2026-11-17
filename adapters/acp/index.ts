// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterPlugin, Emitter, Invocation } from '../types.js';
import { checkBudgetModels, type BudgetModels } from '../budget.js';
import { parseDuration, DURATION_FORM, HARNESS_SEP } from '../../src/delegation.js';
import { FORMULAS, fill } from '../../src/formulas.js';

/**
 * ACP — the Agent Client Protocol (agentclientprotocol.com): any agent that
 * speaks it, reached by one client of agent-pack's own (./client.ts), run by
 * the recipe `invoke.ap` (D66). Two ways in:
 *
 *   - open harnesses: `{ name: 'acp', servers: { junie: { command, args, env } } }`
 *     — each server a harness of its own, to talk to directly. No adapter
 *     writes its agent files, so nothing names an agent to it: a task for one
 *     of the project's agents (`BY junie:<agent>`) is refused, saying so.
 *   - a transport: `{ name: 'codex', acp: { command, args, env } }` — a
 *     built-in harness keeps its agent files and its BY, and its delegations
 *     go through the ACP client instead of its own CLI.
 *
 * A server's env is never printed: the recipe names the server, and the
 * client reads its entry from the project's config when it runs.
 */

const SAY = FORMULAS.messages.acp;

/** One ACP server, as the config gives it — the fields of an `agent_servers` entry, and agent-pack's own. */
export interface AcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** How long a run may last before it is stopped and failed — a duration, `30m` by default. */
  timeout: string;
  /** Whether the agent may run commands in terminals of the client — off by default. */
  terminal: boolean;
  /** The env variables whose values are masked in what is shown, beside those whose names look like a secret — none by default. */
  mask: string[];
  /** The model of each `BUDGET` tier on this server — none by default. */
  models?: BudgetModels;
}

export interface AcpOptions {
  servers?: Record<string, unknown>;
}

/** The timeout of a server whose entry gives none. */
export const DEFAULT_ACP_TIMEOUT = '30m';

/**
 * Where an acp server's commands find the session id — agent-pack's own name,
 * the servers declaring none: the chat (`agent-pack chat`) puts its id there.
 */
export const ACP_SESSION_ENV = 'AGENT_PACK_SESSION_ID';

/** The transport the recipe's harnesses are reached by, as `harness list` shows it. */
export const ACP_TRANSPORT = 'acp';

/** The servers an adapter carries, by harness name — on the adapter object, where the client finds them in the loaded config. */
const SERVERS = Symbol.for('agent-pack.acp.servers');
type WithServers = AdapterPlugin & { [SERVERS]?: Record<string, AcpServer> };

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELDS = ['command', 'args', 'env', 'timeout', 'terminal', 'mask', 'models'] as const;
/** The field a built-in harness's acp option leaves to the adapter itself. */
const MODELS_FIELD: typeof FIELDS[number] = 'models';
const EXAMPLE = `{ command: 'junie', args: ['--acp=true'], env: {} }`;

const isEntry = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What each field of an entry must hold — but `models`, the BUDGET tiers' check — and what a message says when it does not. */
const FIELD_RULES: Record<Exclude<typeof FIELDS[number], 'models'>, { holds: (v: unknown) => boolean; says: string }> = {
  command: { holds: v => typeof v === 'string' && v.trim() !== '', says: `must be the server's executable — ${EXAMPLE}` },
  args: { holds: v => Array.isArray(v) && v.every(a => typeof a === 'string'), says: 'must be a list of strings' },
  env: { holds: v => isEntry(v) && Object.values(v).every(x => typeof x === 'string'), says: "must map each variable's name to its value, as strings" },
  timeout: { holds: v => typeof v === 'string' && parseDuration(v) !== null, says: `must be a duration — ${DURATION_FORM}` },
  terminal: { holds: v => typeof v === 'boolean', says: 'is true or false' },
  mask: { holds: v => Array.isArray(v) && v.every(n => typeof n === 'string' && n !== ''), says: "must list the names of env variables whose values are masked, e.g. ['API_URL']" },
};

/** A server's entry, checked — throws, naming the server and the field, on anything else. */
export function checkServer(where: string, raw: unknown, { models = true } = {}): AcpServer {
  if (!isEntry(raw)) throw new Error(fill(SAY.notServer, { where, example: EXAMPLE }));
  const fields: readonly string[] = models ? FIELDS : FIELDS.filter(f => f !== MODELS_FIELD);
  const stray = Object.keys(raw).find(k => !fields.includes(k));
  if (stray) {
    throw new Error(fill(SAY.noField, { where, field: stray, fields: fields.join(', '), note: models ? '' : SAY.modelsNote }));
  }
  const entry: Record<string, unknown> = { args: [], env: {}, timeout: DEFAULT_ACP_TIMEOUT, terminal: false, mask: [], ...raw };
  for (const [field, rule] of Object.entries(FIELD_RULES)) {
    if (!rule.holds(entry[field])) throw new Error(`adapters: ${where}.${field} ${rule.says}`);
  }
  // Each field was checked against its rule just above: the entry holds what a server is.
  const { command, args, env, timeout, terminal, mask } = entry as unknown as Omit<AcpServer, 'models'>;
  return { command, args, env, timeout, terminal, mask, ...(raw.models !== undefined ? { models: checkBudgetModels(where, raw.models) } : {}) };
}

/** The recipe that reaches `harness` through the ACP client — its CLI the server's command, looked up when a delegation names it. */
function acpInvocation(harness: string, server: AcpServer, own: Pick<Invocation, 'carry' | 'intro'> = {}): Invocation {
  return {
    recipe: resolve(HERE, 'invoke.ap'),
    cli: server.command,
    model: '--model {model}',
    transport: ACP_TRANSPORT,
    fills: { client: resolve(HERE, 'client.js'), server: harness },
    ...(own.carry?.length ? { carry: own.carry } : {}),
    ...(own.intro ? { intro: own.intro } : {}),
  };
}

/**
 * The intro a harness whose CLI picks the agent itself (`--agent`) declares
 * for a transport, where no CLI does: it names the agent and the native file
 * that defines it — `file` with `{agent}` in it, carried into the copy.
 */
export function agentFileIntro(file: string): string {
  return `Act as the agent \`{agent}\` defined in \`${file}\`: read that file first and follow it, then carry out the task below, and answer with its result.`;
}

/** What an acp server's agents and skills get from this adapter: no file — no agent files of its own. */
const NO_FILES: Emitter = () => [];

/** The open harnesses: one per configured server, named by its key. */
export default function acpAdapter(opts: AcpOptions = {}): AdapterPlugin {
  const raw = opts.servers ?? {};
  if (!isEntry(raw)) {
    throw new Error(SAY.serversShape);
  }
  const servers: Record<string, AcpServer> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!SERVER_NAME_RE.test(name) || name.includes(HARNESS_SEP)) {
      throw new Error(fill(SAY.serverName, { name }));
    }
    servers[name] = checkServer(`acp's server \`${name}\``, entry);
  }
  const plugin: WithServers = {
    type: 'adapter',
    apiVersion: 2,
    name: 'acp',
    emitters: { agent: NO_FILES, skill: NO_FILES },
    sessionEnv: ACP_SESSION_ENV,
    harnesses: Object.entries(servers).map(([name, server]) => ({
      name, invocation: acpInvocation(name, server), ...(server.models ? { models: server.models } : {}),
    })),
    [SERVERS]: servers,
  };
  return plugin;
}

/**
 * A built-in harness reached through the ACP client (`acp: { … }` among its
 * options): its agent files, its carried files and its intro kept, its own CLI
 * recipe replaced by the client's. A harness whose CLI picked the agent itself
 * has no intro: its `transportIntro` names the agent instead. Its models stay
 * the adapter's own.
 */
export function acpTransport(adapter: AdapterPlugin, raw: unknown): AdapterPlugin {
  const server = checkServer(`${adapter.name}'s acp`, raw, { models: false });
  const plugin: WithServers = {
    ...adapter,
    invocation: acpInvocation(adapter.name, server, { carry: adapter.invocation?.carry, intro: adapter.invocation?.intro ?? adapter.invocation?.transportIntro }),
    [SERVERS]: { [adapter.name]: server },
  };
  return plugin;
}

/**
 * The server a harness reaches through ACP, among the config's adapters, and
 * where its commands find the session id (its adapter's `sessionEnv`) — null
 * when no server is configured under that name.
 */
export function acpHarnessOf(adapters: readonly AdapterPlugin[], harness: string): { server: AcpServer; sessionEnv: string } | null {
  for (const a of adapters as readonly WithServers[]) {
    const server = a[SERVERS]?.[harness];
    if (server) return { server, sessionEnv: a.sessionEnv ?? ACP_SESSION_ENV };
  }
  return null;
}

/** Every harness the config's adapters reach through ACP, by name, in the config's order. */
export function acpHarnessNames(adapters: readonly AdapterPlugin[]): string[] {
  return (adapters as readonly WithServers[]).flatMap(a => Object.keys(a[SERVERS] ?? {}));
}

/** The server a harness reaches through ACP, among the config's adapters — null when none is configured under that name. */
export function acpServerOf(adapters: readonly AdapterPlugin[], harness: string): AcpServer | null {
  return acpHarnessOf(adapters, harness)?.server ?? null;
}
