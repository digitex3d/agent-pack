// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJsonFile, writeFileAtomic } from '../services/fs.js';
import acpAdapter, { acpTransport } from '../../adapters/acp/index.js';
import { COLOR, colorOn, paint } from '../../adapters/acp/ansi.js';
import { banner } from '../../reporters/pretty/logo.js';
import { packageInfo } from '../config.js';
import { Screen } from '../../adapters/acp/screen.js';
import { fitPainted } from '../../adapters/acp/width.js';
import { PICKED, keyPicker, picker, pickerRows, type PickerState } from '../../adapters/acp/picker.js';
import type { MenuItem } from '../../adapters/acp/menu.js';
import type { AdapterPlugin } from '../../adapters/types.js';
import { RUNTIME_DIR } from '../apx/paths.js';
import { onPath } from '../harnesses.js';
import { FORMULAS, fill } from '../formulas.js';

/**
 * The chat's first setup: when the config names no `chat.boss`, the harnesses
 * the chat can reach are ticked once, on the terminal, among the best-known
 * ACP harnesses found on the PATH, then the boss among them — kept in
 * `.agent-pack/chat.json`, the config never edited. The file is the fallback
 * the chat reads when the config names no boss. Each server kept reaches the
 * config's adapter of its harness, as that adapter's acp option would — its
 * name the adapter's, its agents the files the adapter writes; a server no
 * adapter of the config writes agent files for is an acp adapter's, talked to
 * directly.
 */

const SAY = FORMULAS.messages.chat.setup;

/** Where the first setup keeps what it picked, under the project root. */
const CHAT_FILE = `${RUNTIME_DIR}/chat.json`;

/** How a known harness is reached through ACP: its own command, or a bridge — run with npx when not installed. */
interface KnownHarness {
  /** Its key in the kept file, and its name in the room when no adapter of the config writes its agent files — one no installed harness takes (checkHarnessNames). */
  name: string;
  /** The harness's own CLI — the one looked up on the PATH, and the one the adapter writing its agent files declares (`invocation.cli`). */
  cli: string;
  /** Its ACP command when the harness speaks ACP itself. */
  acp?: { command: string; args: string[] };
  /** The bridge that speaks ACP for it: its binary, and its npm package (pinned) for npx. */
  bridge?: { command: string; npm: string };
}

/** The runner a bridge not installed is run with, from its npm package. */
const NPX = 'npx';

/** The indent of the kept file's JSON. */
const JSON_INDENT = 2;

/** The best-known harnesses that speak ACP, in the order they are proposed. */
const KNOWN: readonly KnownHarness[] = [
  { name: 'claude', cli: 'claude', bridge: { command: 'claude-agent-acp', npm: '@agentclientprotocol/claude-agent-acp@0.108.0' } },
  { name: 'codex-acp', cli: 'codex', bridge: { command: 'codex-acp', npm: '@agentclientprotocol/codex-acp@2.7.0' } },
  { name: 'gemini', cli: 'gemini', acp: { command: 'gemini', args: ['--experimental-acp'] } },
  { name: 'opencode-acp', cli: 'opencode', acp: { command: 'opencode', args: ['acp'] } },
  { name: 'junie', cli: 'junie', acp: { command: 'junie', args: ['--acp=true'] } },
  { name: 'goose', cli: 'goose', acp: { command: 'goose', args: ['acp'] } },
];

/** A harness the setup proposes: its name, and the ACP command that reaches it. */
export interface BossCandidate {
  name: string;
  command: string;
  args: string[];
}

/** What the chat talks to when the config names no boss: the boss, and the config's adapters reaching every server kept. */
export interface ChatChoice {
  boss: string;
  adapters: AdapterPlugin[];
}

/**
 * The known harnesses whose CLI is on `path`, each with its ACP command — a
 * bridge's own binary when installed, else npx when that is on the path.
 * Looked up, never run.
 */
export function discoverBosses(path = process.env.PATH ?? ''): BossCandidate[] {
  return KNOWN.filter(known => onPath(known.cli, path)).flatMap(({ name, acp, bridge }): BossCandidate[] => {
    if (acp) return [{ name, ...acp }];
    if (!bridge) return [];
    if (onPath(bridge.command, path)) return [{ name, command: bridge.command, args: [] }];
    if (onPath(NPX, path)) return [{ name, command: NPX, args: ['-y', bridge.npm] }];
    return [];
  });
}

/** Whether a JSON value is an object of named values — no array, no null. */
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The config's adapter that writes the agent files of the known harness kept
 * as `name` — its CLI the harness's own, not reached over ACP already — or
 * undefined when none does.
 */
function writerOf(adapters: readonly AdapterPlugin[], name: string): AdapterPlugin | undefined {
  const cli = KNOWN.find(known => known.name === name)?.cli;
  return cli ? adapters.find(adapter => adapter.invocation?.cli === cli && !adapter.invocation.transport) : undefined;
}

/** A kept server's name in the room: the name of the adapter writing its agent files, else its own. */
function roomName(adapters: readonly AdapterPlugin[], name: string): string {
  return writerOf(adapters, name)?.name ?? name;
}

/** The config's adapters with the kept servers: each on its harness's adapter as a transport, the rest an acp adapter's. */
function choiceOf(boss: string, servers: Record<string, unknown>, config: readonly AdapterPlugin[]): ChatChoice {
  const adapters = [...config];
  const bare: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const writer = writerOf(adapters, name);
    if (writer) adapters[adapters.indexOf(writer)] = acpTransport(writer, server);
    else bare[name] = server;
  }
  // The servers left are an acp adapter's: each entry checked, and reached, as the config's are.
  if (Object.keys(bare).length) adapters.push(acpAdapter({ servers: bare }));
  return { boss: roomName(config, boss), adapters };
}

/** What a first setup kept, checked, on the config's adapters — null when the project has none; throws, naming the file, on a malformed one. */
export function readChatFile(root: string, adapters: readonly AdapterPlugin[]): ChatChoice | null {
  const file = resolve(root, CHAT_FILE);
  if (!existsSync(file)) return null;
  const bad = (): Error => new Error(fill(SAY.badFile, { file: CHAT_FILE }));
  // readJsonFile gives undefined for a file that is no JSON.
  const entry = readJsonFile(file);
  if (!isRecord(entry) || typeof entry.boss !== 'string' || !isRecord(entry.servers) || !Object.hasOwn(entry.servers, entry.boss)) throw bad();
  return choiceOf(entry.boss, entry.servers, adapters);
}

/** Keep the harnesses ticked and the boss, for the next chats. */
function writeChatFile(root: string, boss: string, reached: readonly BossCandidate[]): void {
  const file = resolve(root, CHAT_FILE);
  const servers = Object.fromEntries(reached.map(candidate => [candidate.name, { command: candidate.command, args: candidate.args }]));
  writeFileAtomic(file, `${JSON.stringify({ boss, servers }, null, JSON_INDENT)}\n`);
}

/** The terminal the setup draws on. */
interface Terminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/** One page of the setup: its step, its title and its hint. */
interface Page {
  step: number;
  title: string;
  hint: string;
}

/** The setup's steps: the harnesses ticked, then the boss. */
const STEP = { reach: 1, boss: 2 } as const;
const STEPS = STEP.boss;

/** A page's header: the CLI's banner (agent-pack --help's), each row fitted, then the step. */
function header(step: number, width: number, color: boolean): string[] {
  return ['', ...banner(packageInfo(), { color, columns: width }).map(row => fitPainted(row, width)), '', ` ${paint(fill(SAY.step, { step: String(step), steps: String(STEPS) }), { fg: COLOR.muted }, color)}`, ''];
}

/** A picker drawn full screen, under the header, until it is answered: the indexes picked — null when given up. */
function ask({ input, output }: Terminal, start: PickerState, { step, title, hint }: Page): Promise<number[] | null> {
  return new Promise(done => {
    let state = start;
    const color = colorOn();
    const screen: Screen = new Screen(output, input, () => {
      const { width } = screen.size();
      return { rows: [...header(step, width, color), ...pickerRows(state, title, hint, width, color)], cursor: null, scrollMax: 0, page: 0 };
    }, () => finish(null));
    const finish = (picked: number[] | null): void => { screen.close(); done(picked); };
    screen.open((_str, key) => {
      const outcome = keyPicker(state, key);
      state = outcome.state;
      if (outcome.action) finish(outcome.action.type === PICKED ? outcome.action.picked : null);
      else screen.schedule();
    });
  });
}

/** The candidates as the picker's items: the names in one column, the commands dim after them. */
function itemsOf(candidates: readonly BossCandidate[]): MenuItem[] {
  const width = Math.max(...candidates.map(candidate => candidate.name.length));
  return candidates.map(({ name, command, args }) => ({ insert: name, label: name.padEnd(width), detail: [command, ...args].join(' ') }));
}

/**
 * The first setup, full screen: the harnesses found, every one ticked; those
 * kept ticked the chat can reach; the boss among them, asked only when more
 * than one — kept in `.agent-pack/chat.json`. Null when none is found or the
 * user gives up. Asked only on an interactive terminal.
 */
export async function setupBoss(root: string, terminal: Terminal, adapters: readonly AdapterPlugin[]): Promise<ChatChoice | null> {
  const { output } = terminal;
  const found = discoverBosses();
  if (found.length === 0) {
    output.write(`${fill(SAY.noneFound, { harnesses: KNOWN.map(known => known.name).join(', ') })}\n`);
    return null;
  }
  const ticked = await ask(terminal, picker(itemsOf(found), true, found.map(() => true)), { step: STEP.reach, title: SAY.reachTitle, hint: SAY.reachHint });
  if (!ticked) return null;
  const reached = ticked.map(index => found[index]);
  // One harness reached is the boss itself: no second step.
  const [only] = reached;
  const pickedBoss = reached.length === 1 ? [only] : (await ask(terminal, picker(itemsOf(reached), false), { step: STEP.boss, title: SAY.bossTitle, hint: SAY.bossHint }))?.map(index => reached[index]);
  const [boss] = pickedBoss ?? [];
  if (!boss) return null;
  writeChatFile(root, boss.name, reached);
  output.write(`${fill(SAY.saved, { boss: roomName(adapters, boss.name), harnesses: reached.map(candidate => roomName(adapters, candidate.name)).join(', '), file: CHAT_FILE })}\n`);
  return readChatFile(root, adapters);
}
