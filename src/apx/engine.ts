// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * The apx engine — answers questions about one agent, from its compiled
 * document alone. A harness runs `node <exe> <verb>`; every verb writes lines
 * and returns its exit code, so the engine is testable without a process.
 *
 * The text is the md projection's own (`renderPreamble`/`renderEntry`): the
 * engine only changes the form of a reference, from ` (tpl-…)` to the command
 * that prints that block — ` [node <exe> get tpl-…]`.
 *
 * Exit codes: 0 ok, 1 something does not exist, 2 wrong usage. Every error is
 * one `# error:` line carrying the command that fixes it. `check` answers on its
 * first line, `open` (exit 0) or `closed` (exit 1, or 2 on a usage or config error).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { ApDocument as ApDocumentClass, type ApDocument } from '../apdoc/document.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef, ApNode, ApWhenNode, ApRunNode, ApDirectiveNode } from '../apdoc/types.js';
import { KIND_STRATEGIES, type AgentBlock, type TeamBlock, type MainBlock, type VarBlock, type DimensionBlock, type DomainBlock } from '../apdoc/blocks.js';
import { mdEnv, renderPreamble, renderEntry, renderMd } from '../../adapters/md/index.js';
import { renderNodes, type MdEnv } from '../../adapters/md/toolkit.js';
import { FORMULAS, fill, type QuizQuestion } from '../formulas.js';
import { FLOWS_DIR, WORK_DIR, apxPath, flowScriptStem, projectRootOf, } from './paths.js';
import type { ApxVerb } from './verbs.js';
import { openSessionVars, type SessionVars, type CheckRecord, type ExecutorRecord } from './sessionVars.js';
import { checkedKeyword, roundLine, roundOf, stateOf, type ApCheckSpec } from '../check.js';
import { PROGRAM, WRITE_PROGRAM, executorKey, programDir, programFolders, type ApExecutorSpec } from '../executor.js';
import { resolveJudge } from '../judge/builtins.js';
import type { JudgePlugin } from '../judge/types.js';
import { refName } from '../../adapters/md/phrases.js';
import { scopeLabel } from '../withUse.js';
import { SCOPED_KINDS } from '../services/tags.js';
import { CREDIT } from '../credits.js';
import { validateRecord, formatIssues, jsonExample, jsonSchemaOf } from '../shapeSchema.js';
import { BLOCK_ID_RE, addressName, sha256Hex, shortId } from '../apdoc/ids.js';
import { perimeterFiles, scanZones, zoneMarks, zonesText, parseZones } from './contracts.js';
import { DelegationTable, CONTRACT_ID_RE, MARK_ID_RE, Piece, STATE, pieceRecord, pieceOf, answerFlag, type DelegationRecord } from './delegations.js';
import { ApxArgs } from './args.js';
import { splitHarness, type ApMark, type HarnessInvocation } from '../delegation.js';
import { parsePayload } from './payload.js';
import type { DriverEntry } from '../storeDrivers/registry.js';
import { installRecorded } from './stores.js';
import { resolveWorkspace } from '../workspace/registry.js';
import type { Allowed, Delivery, WorkspaceSession } from '../workspace/types.js';
import { constantOf, readsOf } from '../vars.js';
import { servicesOf, serviceOf } from './services/registry.js';
import { waitFor, OLD_DELEGATE_KIND } from './services/delegate.js';
import { countOf } from './service.js';
import { type PerimeterGlobs } from '../primitives.js';
import { globRegExp, matchesAnyGlob, literalGlob } from '../services/glob.js';

/** The exit of an UNTIL*'s answer at its round limit: the loop ends (src/check.ts roundLine). */
const ROUND_LIMIT = 7;

/** What an empty variable is told — the caller says what follows from it. */
const emptyVariable = (name: string): string => `\`${name}\` is empty — nothing is stored in it in this session`;

/** Build provenance sealed next to the document. */
export interface ApxBuild {
  builtAt: string;
  agentPackVersion: string;
  hash: string;
  /** The tabeli engine of the agent-pack that wrote the apx — absent in an apx written before it shipped one. */
  tabeli?: string;
  /** What `check` needs at run time, from the `checks` config key — absent: no judge was configured. */
  checks?: ApxChecks;
  /** How long `wait` waits at most when a WAIT names no MAX — the `wait.max` config key; absent: the default. */
  waitMax?: string;
  /** How many zones a MARK binds at most when its line names no MAX — the `mark.max` config key; absent: the default. */
  markMax?: number;
  /** The store drivers of the config, to import again — absent: only the shipped ones (src/storeDrivers/registry.ts). */
  drivers?: DriverEntry[];
}

/**
 * The `checks` config as an apx records it: the judge by name (a built-in one,
 * loaded from the engine itself — judge/builtins.ts), the threshold, and the
 * model the judge lock pins for that judge, when it pins one. A loop's round
 * limit is its own, on its head (`MAX <n>`), kept in its check spec.
 * The judge's key is never recorded: the judge reads it at run time.
 */
export interface ApxChecks {
  adapter: string;
  threshold: number;
  model?: string;
}

/** Kinds in reading order: who you are, your team, then the md chapter order. */
const KIND_ORDER = [...new Set(['agent', 'team', ...KIND_STRATEGIES.map(strategy => strategy.kind)])];

/** A dimension write's optional refs — the files its answer also depends on. */


const HELP: [string, string][] = [
  ['start', 'the entry point: who you are and a short quiz — run it once, at the start'],
  ['start 1=<a|b|c> …', 'grade the quiz: the introduction of each kind you missed, then your scope'],
  ['scope', 'everything needed to start: who you are, team, policies, workflows, stores, answer shape'],
  ['ls [kind= tag= name~ about~] [count]', 'every block grouped by kind, with its id — filtered'],
  ['get <id> [json]', 'one block: its text, then what it uses and what uses it'],
  ['get <variable>', 'a variable: its scope, who stores it, who reads it, then its value in this session'],
  ['set <variable> -|<value>', 'store a variable for this session — the value on stdin with -; a typed one as JSON of its template'],
  ['refs <id>', 'only the links of a block: what it uses, what uses it'],
  ['find <text>', 'the blocks containing the text, with the matching lines'],
  ['md', 'the whole prompt at once'],
  ['flow <flw-id>', 'how to run a flow: by the harness, from its compiled script — or its steps, to carry out in order'],
  ['run <exe-id> [in-json] [--into <var>]', 'run a program: its tests when it is new, then the program on its input — its answer back, or kept in <var>'],
  ['check <cnd-id>', 'a checked condition (IF!, IF!!, UNTIL!, UNTIL!!), put to the judge on this session\'s variables: open or closed'],
  ['contract mark|start|get|within|merge|land|list …', 'the contracts a flow\'s MARKs bind: mark a zone, start a MARK\'s with --by <agent>, read one, merge and land after a conflict'],
  ['wait <dlg-id | mrk-id | var> … [--max <duration>] [--now] | all', 'take back what a flow started in the background: each one delivered, blocked or ended — or the limit reached; then each one\'s state. --now: at once, the limit counted from each one\'s start'],
  ['guard <path> [--agent <name>] [--subagent] [--after]', 'whether a write stays within the perimeter of the work in progress in this session: exit 0, or 3 with why — what the harness hook asks before each write (--after: after it, for a contract\'s copy)'],
  ['version', 'agent, build date, agent-pack version, hash, block count'],
];

/** What every contract verb works with: the session's registry, where the copies live. */
interface ContractCx {
  table: DelegationTable;
  /** The project root — where the copies live. */
  root: string;
  session: string;
  /** The session's copies, opened on first use. */
  ws: () => WorkspaceSession;
}

/** How many zones a MARK binds at most when neither it nor the config says (`mark.max`). */
export const DEFAULT_MARK_MAX = 20;

/** The workspace engine the copies run on — one ships; a second one is a registry entry and a config key (src/workspace/registry.ts). */
const CONTRACT_WORKSPACE = 'git';

/** The value of `--flag <value>` among args, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  return new ApxArgs(args).value(flag.replace(/^--/, ''));
}

/** Why a trial delivery cannot go through — its zones' marks lost, the work done outside the copy, something left out with no reason — or null when it can. */
type DeliveryRefusal = 'lostZones' | 'strayed' | 'leftOut';

function deliveryRefusal(delivery: Delivery, why: string | undefined): DeliveryRefusal | null {
  if (delivery.lostZones.length) return 'lostZones';
  if (delivery.committed.length === 0 && delivery.strayed.length) return 'strayed';
  if (delivery.leftOut.length && !why) return 'leftOut';
  return null;
}

/** Whether some of `globs` admits every file `glob` does — by its folders before the first wildcard (`src/actors/**` under `src/**`). */
function coversGlob(globs: string[], glob: string): boolean {
  const prefix = glob.split('/').filter((part, index, all) => !/[*?[{]/.test(part) && all.slice(0, index).every(previous => !/[*?[{]/.test(previous))).join('/');
  return globs.some(candidate => globRegExp(candidate).test(glob) || (prefix !== '' && globRegExp(candidate).test(`${prefix}/x`)));
}

const FILTER_RE = /^(kind|tag|name|about)(=|~)(.+)$/;

/** A session id as it may name a folder: no separator, never `.` or `..`. */
const SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** A program's manifest (`distilled/<dst-id>/manifest.json`) — written by the agent, `tested` by the apx. */
interface ProgramManifest {
  version: number;
  previous?: string;
  lineage?: string;
  timeout_ms: number;
  /** A hash of the script and its tests the last time all its tests passed. */
  tested?: string;
}

/** One case of a program's `tests.json`: an input and its expected output, or the refusal it must give. */
type ProgramTest = { why: string; input: unknown } & ({ output: unknown } | { exit: number });

/** Two JSON texts or values that mean the same value, key order aside. */
function sameJson(text: string, expected: unknown): boolean {
  const canon = (value: unknown): unknown => Array.isArray(value) ? value.map(canon)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as object).sort(([leftKey], [rightKey]) => leftKey < rightKey ? -1 : 1).map(([key, child]) => [key, canon(child)])) : value;
  try { return JSON.stringify(canon(JSON.parse(text))) === JSON.stringify(canon(expected)); } catch { return false; }
}

/** Why a script failed, from its stderr: the last lines that say something — stack frames, carets and runtime banners left out. */
function stderrCause(stderr: string): string {
  return stderr.split(/\r?\n/)
    .filter(line => line.trim() && !/^\s+at\s/.test(line) && !/^\s*\^+\s*$/.test(line) && !/^Node\.js v\d/.test(line))
    .slice(-3)
    .map(line => line.trim())
    .join(' | ');
}
const ANSWER_RE = /^(\d+)=(.*)$/;

/**
 * When to read on demand, and when not to: a definition this small is printed
 * whole by `start` — no quiz, no `get` — because reading it costs less than
 * the calls that would fetch it; above it, a block is opened with the agent
 * when it is always needed (role, policies, the shapes requests and answers
 * take) or this small, and only the large, conditional ones stay a `get`.
 */
export interface ApxBudget {
  /** Characters of the whole definition under which `start` prints it all. */
  whole: number;
  /** Characters of a block under which it opens with the agent. */
  block: number;
}
export const APX_BUDGET: ApxBudget = { whole: 12000, block: 600 };

/** Whether an executable is an `.apx` file Node runs — else an executable `bundle --executable` compiled, run as it is. */
const isApx = (exe: string): boolean => exe.endsWith('.apx');

/** The command that runs an executable of the engine, as every answer prints it. */
const runCommand = (exe: string): string => isApx(exe) ? `node ${exe}` : exe;

export class ApxEngine {
  /** The command prefix every printed command starts with. */
  readonly cmd: string;
  /** The project root this apx lives in. */
  get projectRoot(): string { return resolve(projectRootOf(this.exe)); }
  /** The md environment with references in the apx form. */
  private readonly env: MdEnv;
  /** The document's root: an agent, or a unit — a team, the main. */
  readonly root: ApBlock;
  /** The root when it is an agent — a unit has no role, mandate or team of its own. */
  private readonly agent: AgentBlock | null;
  private readonly byId = new Map<string, ApBlock>();
  /** Every verb, by name — the table APX_VERBS lists. */
  private readonly verbs: Record<ApxVerb, (args: string[]) => number | Promise<number>> = {
    start: args => this.start(args),
    scope: () => this.scope(),
    ls: args => this.ls(args),
    get: args => this.get(args),
    set: args => this.set(args),
    refs: args => this.refs(args),
    find: args => this.find(args),
    md: () => this.print(renderMd(this.doc)),
    flow: args => this.flow(args),
    run: args => this.runProgram(args),
    check: args => this.check(args),
    contract: args => this.contract(args),
    wait: args => waitFor(this, args),
    guard: args => this.guard(args),
    version: () => this.version(),
    help: () => this.help(),
  };

  /** The contracts' own steps, for the `delegate` service and `wait` (src/apx/services/delegate.ts). */
  readonly contracts = {
    deliver: (table: DelegationTable, record: DelegationRecord, args: string[]) => this.deliverContract(table, record, args),
    copy: (ctr: string) => this.contractCopy(ctr),
    fold: (table: DelegationTable, pieces: DelegationRecord[]) => this.foldContracts(table, pieces),
    launch: (record: DelegationRecord) => this.launchElsewhere(record),
    deliverElsewhere: (table: DelegationTable, record: DelegationRecord) => this.deliverElsewhere(table, record),
  };

  constructor(
    readonly doc: ApDocument,
    readonly build: ApxBuild,
    /** The path the harness invoked this file by — printed commands reuse it. */
    readonly exe: string,
    private readonly write: (line: string) => void,
    private readonly budget: ApxBudget = APX_BUDGET,
    /** The judge a check asks, by the name the apx records — a built-in one. */
    private readonly judgeNamed: (name: string) => JudgePlugin = name => resolveJudge(name),
    /** In a unit's apx — the main's or a team's — the agent it runs: every command names it after the unit; null in an agent's own apx. */
    private readonly inUnit: string | null = null,
  ) {
    this.cmd = inUnit === null ? runCommand(exe) : `${runCommand(exe)} ${inUnit}`;
    this.env = mdEnv(doc, id => ` [${this.cmd} get ${id}]`, agent => (!agent || agent === doc.root()?.name ? this.cmd : this.sibling(agent)));
    this.root = doc.root() as ApBlock;
    this.agent = this.root.kind === 'agent' ? (this.root as AgentBlock) : null;
    for (const block of doc.all()) this.byId.set(block.id, block);
  }

  /** Whether the config's store drivers were installed in this run. */
  private driversInstalled = false;

  /** Dispatch one invocation: a verb of the engine, or a served kind and its operation (`<kind> <op> [<id>] …`). No verb = start. `check` answers asynchronously. */
  run(argv: string[]): number | Promise<number> {
    // The config's own store drivers are installed before anything renders: a store they keep reads as usable in `get` and `md` too.
    if (this.build.drivers?.length && !this.driversInstalled) {
      this.driversInstalled = true;
      return installRecorded(this).then(() => this.run(argv));
    }
    const [verb = 'start', ...args] = argv;
    if (verb === '-h' || verb === '--help') return this.help();
    if (Object.hasOwn(this.verbs, verb)) return this.verbs[verb as ApxVerb](args);
    const service = serviceOf(verb, this.doc);
    if (service) return service.serve(this, args[0], args.slice(1));
    if (verb === OLD_DELEGATE_KIND) return this.fail(2, `'${verb}' is now 'delegate' — ${this.cmd} delegate ${args.join(' ')}`.trimEnd());
    return this.fail(2, `unknown verb '${verb}' — the verbs: ${this.cmd} help`);
  }

  // ------------------------------------------------------------------ verbs

  private start(args: string[]): number {
    this.out(this.headLine(this.root));
    const whole = renderMd(this.doc);
    if (whole.length <= this.budget.whole) {
      this.out(`# your whole definition — small enough to read at once; still served here: ${this.cmd} help`);
      return this.print(whole);
    }
    const quiz = this.quiz();
    if (quiz.length === 0) return this.opening();
    if (args.length === 0) {
      const form = quiz.map((question, index) => `${index + 1}=<${letters(question.options).join('|')}>`).join(' ');
      this.out(`# quiz — answer with: ${this.cmd} start ${form}`);
      this.out(`# '?' = don't know: it costs nothing and gets you that kind's introduction. a guess costs you a wrong prompt.`);
      quiz.forEach((question, index) => {
        this.out(`${index + 1}. [${question.kind}] ${question.ask}`);
        this.out(`   ${question.options.map((option, optionIndex) => `${letters(question.options)[optionIndex]}) ${option}`).join('   ')}`);
      });
      return 0;
    }
    const given = new Map<number, string>();
    for (const arg of args) {
      const match = ANSWER_RE.exec(arg);
      const questionNumber = match ? Number(match[1]) : 0;
      if (!match || questionNumber < 1 || questionNumber > quiz.length) {
        return this.fail(2, `bad answer '${arg}': expected <n>=<letter> with n in 1..${quiz.length} — the quiz: ${this.cmd} start`);
      }
      given.set(questionNumber, match[2].trim().toLowerCase());
    }
    const missed = [...new Set(quiz.filter((question, index) => given.get(index + 1) !== question.right).map(question => question.kind))];
    if (missed.length === 0) {
      this.out(`# all ${quiz.length} correct — your scope:`);
    } else {
      this.out(`# missed: ${missed.join(', ')} — read how each works, then your scope:`);
      const intros = this.doc.mdSource?.intros ?? {};
      for (const kind of missed) this.print(`\n## ${kind}\n\n${intros[kind] ?? ''}\n`);
    }
    return this.opening();
  }

  /** The scope, then the agent's definition with every block it always needs or that costs less than a `get`. */
  private opening(): number {
    this.scope();
    const opened = this.opened();
    this.out(`\n# opened for you — the rest, when a step needs it: ${this.cmd} get <id>`);
    this.print(this.text(this.root));
    for (const block of opened) this.print(`\n${this.text(block)}`);
    return 0;
  }

  /**
   * The blocks that open with the agent: its role, the policies, the templates
   * its requests and answers take (and those they nest), and every block small
   * enough that reading it costs less than the call to fetch it.
   */
  private opened(): ApBlock[] {
    const always = new Set<ApBlock>();
    const add = (block: ApBlock | null | undefined) => {
      if (!block || always.has(block)) return;
      always.add(block);
      if (block.kind === 'template') for (const ref of uniqueRefs(block.toJSON())) add(this.doc.resolve(ref));
    };
    for (const role of this.agent?.roles ?? []) add(this.doc.resolve(role));
    this.doc.byKind('policy').forEach(add);
    if (this.root.lensIn) add(this.doc.resolve(this.root.lensIn.ref));
    if (this.agent?.lensOut) add(this.doc.resolve(this.agent.lensOut.ref));
    // A variable is runtime state, served by `get <name>` — never opened.
    return this.doc.all().filter(block => block !== this.root && block.kind !== 'var' && (always.has(block) || this.text(block).length <= this.budget.block));
  }

  private scope(): number {
    const root = this.root;
    this.out(this.headLine(root));
    this.out(`you:  ${this.label(root)}  — your definition, complete`);
    if (this.agent?.mandate) this.out(`mandate: ${this.agent.mandate}`);
    const perimeter = this.doc.perimeter();
    if (perimeter) {
      this.out(`perimeter: you write only ${perimeter.writes.join(', ') || 'nothing'} — ${perimeter.reads ? `you read only ${perimeter.reads.join(', ')}` : 'read whatever you need'}`);
      const uncertain = { ...perimeter.judged?.reads.uncertain, ...perimeter.judged?.writes.uncertain };
      if (Object.keys(uncertain).length) this.out(`uncertain: a judge could not tell whether these belong — decide each in context: ${Object.entries(uncertain).map(([file, probability]) => `${file} (p=${probability.toFixed(2)})`).join(', ')}`);
    }
    const roles = (this.agent?.roles ?? []).map(ref => this.doc.resolve(ref)).filter((block): block is ApBlock => block !== null);
    for (const role of roles) this.out(`role: ${this.label(role)}`);
    // Its team, by reference: the team's block — its members, its routing — is the team's own document's.
    if (this.agent?.team) this.out(`team: ${this.refLabel(this.agent.team)}`);
    const policies = this.doc.byKind('policy');
    if (policies.length > 0) {
      this.out('respect:');
      for (const policy of policies) this.out(`  ${this.label(policy)}${policy.about ? `  — ${policy.about}` : ''}`);
    }
    // Every WHEN and hook of the agent and of its roles: what it does, and when.
    const own = [root, ...roles].flatMap(block => block.toJSON().body as ApNode[]);
    const whens = own.filter((node): node is ApWhenNode => node.type === 'when');
    if (whens.length > 0) {
      this.out(`when:  — the steps: ${this.cmd} get ${root.id}`);
      for (const when of whens) {
        const runs = when.body.filter((child): child is ApRunNode => child.type === 'run').map(run => this.refLabel(run.ref));
        this.out(`  WHEN ${when.condition}${runs.length ? `  -> ${runs.join(', ')}` : ''}${when.shape ? `  — as ${this.refLabel(when.shape.ref)}` : ''}`);
      }
    }
    const memories = own.filter((node): node is ApDirectiveNode => node.type === 'directive' && node.keyword === 'MEM' && (node.force ?? 0) >= 0);
    if (memories.length > 0) {
      this.out('remember:');
      for (const memory of memories) this.out(`  ${memory.text}${memory.shape ? `  — as ${this.refLabel(memory.shape.ref)}` : ''}`);
    }
    this.out('write to:');
    const stores = this.doc.agentStores();
    if (stores.length === 0) this.out('  (no stores declared)');
    for (const store of stores) this.out(`  ${this.label(store)}  — use: ${this.cmd} store <op> ${store.id} …`);
    const dimensions = this.doc.byKind('dimension') as DimensionBlock[];
    if (dimensions.length > 0) {
      this.out(`dimensions:  — answers about the code, kept by the apx; read one before reasoning about a file it covers: ${this.cmd} dimension read <dim-id> <file>`);
      for (const dimension of dimensions) this.out(`  ${this.label(dimension)}  — files: ${dimension.globs.join(', ')}`);
    }
    const variables = this.doc.byKind('var');
    if (variables.length > 0) {
      this.out(`variables:  — read: ${this.cmd} get <name>, store: ${this.cmd} set <name> -`);
      for (const variable of variables) this.out(`  ${variable.name}  — ${variable.about}`);
    }
    const checks = Object.entries(this.doc.meta.checks ?? {});
    if (checks.length > 0) {
      this.out(`checks:  — a judge decides each: ${this.cmd} check <id>`);
      for (const [id, check] of checks) this.out(`  ${id}  ${checkedKeyword(check.kind, check.level)}${check.level === 2 ? '  (sealed)' : `  — the question: ${this.cmd} get ${id}`}`);
    }
    const executors = Object.entries(this.doc.meta.executors ?? {});
    if (executors.length > 0) {
      this.out(`executors:  — a delegate or a program carries each out; its contract: ${this.cmd} get <id>`);
      for (const [id, executor] of executors) {
        const state = executor.program ? (this.programFiles(executor.program) ? '  (program ready)' : '  (no program yet)') : '';
        this.out(`  ${id}  ${FORMULAS.keywords.EXECUTOR.who[executorKey(executor.executor)]}${executor.by ? ` \`${executor.by}\`` : ''}  ${executor.site}: ${executor.text}${state}`);
      }
    }
    if (root.lensIn) this.out(`requests arrive as: ${this.refLabel(root.lensIn.ref)}`);
    if (this.agent?.lensOut) this.out(`answer as: ${this.refLabel(this.agent.lensOut.ref)}  — your own rules apply in addition to the shape`);
    const counts = this.groups(this.doc.all()).map(([kind, blocks]) => `${blocks.length} ${kind}`);
    this.out(`contains: ${counts.join(', ')}  — list them: ${this.cmd} ls`);
    return 0;
  }

  private ls(args: string[]): number {
    const terms: { key: string; op: string; val: string }[] = [];
    let count = false;
    for (const arg of args) {
      if (arg === 'count') { count = true; continue; }
      const match = FILTER_RE.exec(arg);
      if (!match) return this.fail(2, `bad filter '${arg}' — filters look like: ${this.cmd} ls kind=template tag=planning name~idea about~plan`);
      terms.push({ key: match[1], op: match[2], val: match[3] });
    }
    const hits = this.doc.all().filter(block => terms.every(term => matches(block, term.key, term.op, term.val)));
    for (const [kind, blocks] of this.groups(hits)) {
      this.out(`${kind} (${blocks.length})`);
      if (!count) for (const block of blocks) this.out(`  ${this.lsLine(block)}`);
    }
    this.out(`# ${countOf(hits.length, 'block', 'blocks')}${hits.length === 0 && terms.length > 0 ? ' match' : ''}`);
    return 0;
  }

  private get(args: string[]): number {
    if (args[0] && !BLOCK_ID_RE.test(args[0])) return this.getVariable(args[0]);
    const check = args[0] ? this.doc.meta.checks?.[args[0]] : undefined;
    if (check) return this.getCheck(args[0], check);
    const executor = args[0] ? this.doc.meta.executors?.[args[0]] : undefined;
    if (executor) return this.getExecutor(args[0], executor);
    const block = this.blockArg('get', args);
    if (!block) return this.lastCode;
    if (args[1] === 'json') return this.print(JSON.stringify(block.toJSON(), null, 1));
    this.print(this.text(block));
    const tags = block.tags.length > 0 ? `  ${block.tags.map(tag => `#${tag}`).join(' ')}` : '';
    this.out(`# ${block.kind} ${block.name}  ${block.id}  ${block.chars}ch${tags}`);
    this.links(block);
    return 0;
  }

  private refs(args: string[]): number {
    const block = this.blockArg('refs', args);
    if (!block) return this.lastCode;
    this.links(block);
    return 0;
  }

  private find(args: string[]): number {
    if (args.length === 0) return this.fail(2, `find needs text — example: ${this.cmd} find plan`);
    const needle = args.join(' ').toLowerCase();
    let matched = 0;
    for (const block of this.doc.all()) {
      const lines = this.text(block).split('\n').filter(line => line.toLowerCase().includes(needle));
      if (lines.length === 0) continue;
      matched++;
      this.out(this.lsLine(block));
      for (const line of lines) this.out(`  > ${line.trim()}`);
    }
    this.out(`# ${countOf(matched, 'block', 'blocks')}${matched === 0 ? ' match' : ''}`);
    return 0;
  }

  /**
   * `flow <flw-id>` — how this harness runs a flow: from the script the adapter
   * compiled for it, when there is one for this very version of the flow;
   * otherwise its steps, to carry out in order.
   */
  private flow(args: string[]): number {
    const block = this.blockArg('flow', args);
    if (!block) return this.lastCode;
    if (block.kind !== 'flow') return this.fail(2, `${block.id} is a ${block.kind}, not a flow — the flows: ${this.cmd} ls kind=flow`);
    const script = this.flowScript(block);
    const run = this.doc.meta.flowRun;
    if (script && run) return this.print(fill(run, { script, steps: `${this.cmd} get ${block.id}` }));
    this.out(`# flow ${block.name} — carry out its steps in order:`);
    return this.print(this.text(block));
  }

  /** A contract of this agent by id, or null after telling where its contracts are. */
  executorArg(verb: string, id: string | undefined): ApExecutorSpec | null {
    const spec = id ? this.doc.meta.executors?.[id] : undefined;
    if (!spec) this.lastCode = this.fail(2, `${verb} needs a contract id of this agent (exe-…) — the line that asks for it names it; all of them: ${this.cmd} scope`);
    return spec ?? null;
  }

  /**
   * What a contract receives: one key per variable it reads — its value as this
   * session stores it, parsed when it is JSON — and per constant, with its
   * value. An empty variable fails: the piece cannot be carried out yet.
   */
  inputJson(spec: ApExecutorSpec, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
    const input: Record<string, unknown> = {};
    const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };
    for (const [name, value] of Object.entries(spec.input.constants)) input[name] = parsed(value);
    if (spec.input.vars.length > 0) {
      const vars = this.sessionVars();
      if (!vars) return null;
      const read = this.readVariables(vars, spec.input.vars);
      if ('empty' in read) {
        this.lastCode = this.fail(1, `${emptyVariable(read.empty)}: fill it before this piece is carried out`);
        return null;
      }
      for (const { name, value } of read.values) input[name] = parsed(value);
    }
    return { ...input, ...extra };
  }

  /**
   * A procedure's contract with the variable its call site fills (`RUN p INTO x`,
   * `--into x`): the result is stored in it, as an INTO line's. The arguments
   * without the option; null after telling what is wrong.
   */
  intoArg(spec: ApExecutorSpec, id: string, args: string[]): { spec: ApExecutorSpec; args: string[] } | null {
    const at = args.indexOf('--into');
    if (at < 0) return { spec, args };
    const name = args[at + 1];
    const rest = [...args.slice(0, at), ...args.slice(at + 2)];
    if (spec.site !== 'procedure') { this.lastCode = this.fail(2, `--into stores a procedure's result — ${id} is a ${spec.site}${spec.output.into ? `, stored in \`${spec.output.into}\` already` : ''}`); return null; }
    if (!name || !this.variable(name)) { this.lastCode = this.fail(2, `--into needs a variable of this agent${name ? ` — \`${name}\` is none` : ''}: ${this.cmd} scope`); return null; }
    return { spec: { ...spec, output: { ...spec.output, into: name } }, args: rest };
  }

  /** The template a contract's answer is shaped as: its INTO variable's type, or its procedure's AS — null when none. */
  answerShape(spec: ApExecutorSpec): ApRef | null {
    if (spec.output.into) return this.variable(spec.output.into)?.type ?? null;
    const template = spec.output.template ? this.doc.byKind('template').find(block => block.name === spec.output.template) : undefined;
    return template ? ({ id: template.id, target: template.address, kind: 'template' } as ApRef) : null;
  }

  /**
   * A contract's answer: checked against its output — `{"holds": …}` for a
   * condition, its INTO variable's template (then stored in it), its procedure's
   * AS template — and recorded in the session. Null when it breaks the contract.
   */
  deliver(id: string, spec: ApExecutorSpec, text: string, outcome: ExecutorRecord['outcome'], fingerprint: string): string | null {
    // Only a condition or a shaped answer is JSON; any other answer is text — stored as is, or only recorded.
    const shape = this.answerShape(spec);
    let value: unknown;
    if (spec.output.holds || shape) {
      try { value = JSON.parse(text); } catch { return 'the answer is not JSON'; }
    }
    if (spec.output.holds) {
      if (typeof value !== 'object' || value === null || typeof (value as { holds?: unknown }).holds !== 'boolean') return 'a condition answers {"holds": true | false}';
    } else if (spec.output.into) {
      const block = this.variable(spec.output.into);
      if (!block) return `no variable \`${spec.output.into}\` in this agent`;
      const failed = this.storeVariable(block, text.trim());
      if (failed) return failed.reason;
    } else if (shape) {
      const issues = this.contractIssues(text, shape);
      if (issues) return `not shaped as \`${refName(shape)}\`: ${issues}`;
    }
    this.recordExecution(id, spec, fingerprint, outcome, spec.output.holds ? (value as { holds: boolean }).holds : undefined);
    return null;
  }

  /** One delegation or program run, in the session's record — who carried it out, on what input, how it ended. */
  private recordExecution(id: string, spec: ApExecutorSpec, fingerprint: string, outcome: ExecutorRecord['outcome'], holds?: boolean): void {
    const session = this.openSession();
    if (typeof session === 'string') return;
    const who = spec.executor === PROGRAM ? 'program' : spec.by ?? this.doc.meta.delegate ?? 'delegate';
    session.executed({ exe: id, executor: spec.executor, who, fingerprint, outcome, ...(holds === undefined ? {} : { holds }), at: new Date().toISOString() });
  }

  /**
   * What a contract tells the agent once its answer is in: the condition's
   * outcome — and, for an UNTIL's, the round its loop is at, or the limit —
   * or where the answer went.
   */
  delivered(id: string, spec: ApExecutorSpec, text: string): number {
    if (spec.output.into) {
      this.out(`# stored as \`${spec.output.into}\` for this session — read it: ${this.cmd} get ${spec.output.into}`);
      return 0;
    }
    const code = this.print(text.trim());
    const session = spec.rounds ? this.openSession() : null;
    if (!session || typeof session === 'string') return code;
    const answers = session.answers(id);
    if (answers.at(-1) !== false) return code;
    const round = roundOf(answers, spec.rounds);
    this.out(`# ${roundLine(round, spec.rounds!, FORMULAS.keywords.EXECUTOR.loop)}`);
    // At the limit the loop ends: an exit of its own, so no command chained after it runs another round.
    return round >= spec.rounds! ? ROUND_LIMIT : code;
  }

  /** A program's files: its folder, its manifest and its script — or null while it has none. */
  private programFiles(program: string): { dir: string; manifest: ProgramManifest; script: string } | null {
    const dir = resolve(projectRootOf(this.exe), programDir(program));
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    const script = readdirSync(dir).find(file => /^script(\.|$)/.test(file));
    if (!script) return null;
    let manifest: ProgramManifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { return null; }
    return { dir, manifest, script: join(dir, script) };
  }

  /** The program folder a new version starts from: the one whose manifest names the same lineage — or null. */
  private previousProgram(spec: ApExecutorSpec): string | null {
    if (!spec.lineage) return null;
    const project = resolve(projectRootOf(this.exe));
    for (const folder of programFolders(project)) {
      if (folder === spec.program) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(project, programDir(folder), 'manifest.json'), 'utf-8')) as ProgramManifest;
        if (manifest.lineage === spec.lineage) return folder;
      } catch { /* not a program folder */ }
    }
    return null;
  }

  /** Run a program on one input: its stdout, or why it gave none — refused (exit ≠ 0), timed out, or could not start. */
  private execute(script: string, input: string, timeout: number): { out: string } | { refused: string } | { timeout: true } | { error: string } {
    // Its own process group, so a timeout stops whatever the program started too.
    const run = spawnSync(script, [], { input, encoding: 'utf-8', timeout, detached: true } as SpawnSyncOptionsWithStringEncoding);
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') {
      try { process.kill(-run.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      return { timeout: true };
    }
    if (run.error) return { error: `${script} could not start (${code}) — make it executable (chmod +x) with a #! line` };
    if (run.status !== 0) return { refused: `exit ${run.status}${stderrCause(run.stderr ?? '') ? `: ${stderrCause(run.stderr ?? '')}` : ''}` };
    return { out: run.stdout };
  }

  /**
   * `run <exe-id> [in-json]` — a program carries the piece out. With no program
   * yet, the agent is told to write it (and where the version before it is).
   * A new or changed program runs its own tests first. Then it runs on its
   * input: a refusal (exit ≠ 0) stops the procedure — the agent never carries
   * the piece out itself; a timeout hands this one run to the agent.
   */
  private runProgram(argv: string[]): number {
    const id = argv[0];
    const found = this.executorArg('run', id);
    const into = found && this.intoArg(found, id, argv);
    if (!into) return this.lastCode;
    const { spec } = into;
    const inArg = into.args[1];
    const again = `${this.cmd} run ${id}${spec.output.into && spec.site === 'procedure' ? ` --into ${spec.output.into}` : ''}`;
    if (spec.executor !== 2 || !spec.program) return this.fail(1, `a delegate carries out ${id}, not a program: hand it over with \`${this.cmd} input ${id}\`, then \`${this.cmd} answer ${id} -\``);
    const files = this.programFiles(spec.program);
    if (!files) {
      const previous = this.previousProgram(spec);
      const writer = this.doc.byKind('procedure').find(block => block.name === WRITE_PROGRAM);
      return this.fail(10, [
        `no program yet for ${id} — write it now, in ${programDir(spec.program)}/ at the project root (beside .agent-pack/): manifest.json, the script, tests.json`,
        writer ? `how: ${this.cmd} get ${writer.id}` : `its contract: ${this.cmd} get ${id}`,
        `manifest.json: {"version": 1, "timeout_ms": <n>${spec.lineage ? `, "lineage": "${spec.lineage}"` : ''}} — the script: script.<ext>, executable, JSON in on stdin, JSON out on stdout, exit 1 with the reason on stderr to refuse`,
        `tests.json: [{"why": "…", "input": {…}, "output": <the JSON it must answer>}, {"why": "…", "input": {…}, "exit": 1}] — a "why" starting with CHOICE: for each decision the block left open`,
        ...(previous ? [`its previous version is ${programDir(previous)}/ — start from it: version + 1, "previous": "${previous}", then delete that folder`] : []),
        `then run it again: ${again}`,
      ].join('\n'));
    }
    const { dir, manifest, script } = files;
    if (!(manifest.timeout_ms > 0)) return this.fail(6, `${programDir(spec.program)}/manifest.json sets no timeout_ms — set one`);
    // A new or changed program proves itself on its own tests first.
    const testsPath = join(dir, 'tests.json');
    const proof = sha256Hex(readFileSync(script, 'utf-8') + (existsSync(testsPath) ? readFileSync(testsPath, 'utf-8') : ''));
    if (manifest.tested !== proof) {
      let tests: ProgramTest[];
      try { tests = JSON.parse(readFileSync(testsPath, 'utf-8')); } catch { return this.fail(6, `${programDir(spec.program)}/tests.json is missing or not JSON — a program comes with its tests`); }
      if (!Array.isArray(tests) || tests.length === 0) return this.fail(6, `${programDir(spec.program)}/tests.json holds no case — a program comes with its tests`);
      for (const test of tests) {
        const ran = this.execute(script, JSON.stringify(test.input), manifest.timeout_ms);
        // Too slow is no wrong answer: the timeout or the speed is to fix, not the logic.
        if ('timeout' in ran) return this.fail(6, `the program of ${id} did not answer its test "${test.why}" within ${manifest.timeout_ms} ms — raise timeout_ms in ${programDir(spec.program)}/manifest.json, or make the program faster`);
        const failed = 'exit' in test
          ? ('refused' in ran ? null : `it should refuse (exit ${test.exit})`)
          : 'out' in ran ? (sameJson(ran.out, test.output) ? null : `it answered ${ran.out.trim()}`) : `it gave no answer (${'refused' in ran ? ran.refused : 'timeout' in ran ? 'timeout' : ran.error})`;
        if (failed) return this.fail(6, `the program of ${id} fails its own test "${test.why}": ${failed} — fix the program or the test, then run again`);
      }
      writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ ...manifest, tested: proof }, null, 2)}\n`);
    }
    let extra: Record<string, unknown> = {};
    if (spec.input.in) {
      if (!inArg) return this.fail(2, `${id} takes its input shaped as \`${spec.input.in}\`: ${this.cmd} run ${id} '<json>'`);
      try { extra = { in: JSON.parse(inArg) }; } catch { return this.fail(2, `the input of ${id} is not JSON`); }
    }
    const input = this.inputJson(spec, extra);
    if (!input) return this.lastCode;
    const json = JSON.stringify(input);
    const fingerprint = sha256Hex(json);
    const record = (outcome: ExecutorRecord['outcome']) => this.recordExecution(id!, spec, fingerprint, outcome);
    const ran = this.execute(script, json, manifest.timeout_ms);
    if ('timeout' in ran) { record('timeout'); return this.fail(4, `the program of ${id} did not answer within ${manifest.timeout_ms} ms — carry this one out yourself, and say so`); }
    if ('error' in ran) return this.fail(6, ran.error);
    if ('refused' in ran) { record('refused'); return this.fail(3, `the program of ${id} refused its input (${ran.refused}) — stop the procedure and report it; never carry this piece out yourself`); }
    const broken = this.deliver(id!, spec, ran.out, 'ran', fingerprint);
    if (broken) { record('broken'); return this.fail(6, `the program of ${id} answered outside its contract: ${broken} — fix the program, then run again`); }
    return this.delivered(id!, spec, ran.out);
  }

  /**
   * `check <cnd-id>` — a checked condition put to the judge: the state is built
   * from this session's variables, exactly as stored (`### <name>` and the
   * value, each variable the condition reads); the question is the compiler's.
   * Open at or above the threshold; closed below it, and closed when in doubt —
   * an empty variable, a state too large, a judge that cannot answer. A checked
   * UNTIL counts its closed answers in a row: at the round limit, the agent is
   * told to stop. Every check is recorded in the session. A sealed condition's
   * answer never says what it checks.
   */
  private async check(args: string[]): Promise<number> {
    const answer = (outcome: 'open' | 'closed', ...lines: string[]): void => { this.out(outcome); lines.forEach(line => this.out(line)); };
    const refused = (message: string): number => { answer('closed', `# error: ${message}`); return 2; };
    const [id] = args;
    if (!id) return refused(`check needs a condition id — the line that asks for the check names it: ${this.cmd} check cnd-…`);
    const spec = this.doc.meta.checks?.[id];
    if (!spec) return refused(`no checked condition with id '${id}' in this agent — its checks: ${this.cmd} scope`);
    const config = this.build.checks;
    if (!config) return refused(`this apx records no judge for its checks — add checks: { adapter: 'jev' } to agent-pack.config.mjs, then run agent-pack bundle all`);
    const session = this.openSession();
    if (typeof session === 'string') return refused(`${session} — the gate stays closed`);
    let judge: JudgePlugin;
    try { judge = this.judgeNamed(config.adapter); } catch (error) { return refused(`the judge \`${config.adapter}\` cannot be loaded by the apx (${error instanceof Error ? error.message : error})`); }
    try {
      const verdict = await this.verdict(spec, id, session, judge, config.model);
      const prior = spec.kind === 'UNTIL' ? session.checks(id) : [];
      // This answer's round, counted as closed: it is recorded before the verdict is known.
      const round = roundOf([...prior.map(check => check.outcome === 'open'), false], spec.kind === 'UNTIL' ? spec.rounds : undefined);
      session.record({ ...verdict.record, cnd: id, level: spec.level, round, threshold: config.threshold, at: new Date().toISOString() });
      if (verdict.open) { answer('open', verdict.why); return 0; }
      const rounds = spec.kind !== 'UNTIL' || !spec.rounds ? []
        : [roundLine(round, spec.rounds, FORMULAS.keywords.CHECK.loop)];
      answer('closed', verdict.why, ...rounds);
      return 1;
    } catch (error) {
      return refused(`the check could not be run or recorded: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * The judge's verdict on one checked condition — what the agent is told, and
   * what the session records of it. Closed when in doubt; a sealed condition's
   * reason never quotes what it checks.
   */
  private async verdict(spec: ApCheckSpec, id: string, session: SessionVars, judge: JudgePlugin, model: string | undefined):
    Promise<{ open: boolean; why: string; record: Pick<CheckRecord, 'fingerprint' | 'model' | 'p' | 'outcome'> }> {
    const sealed = spec.level === 2;
    const threshold = this.build.checks!.threshold;
    const closed = (plain: string, gate: string, record: Partial<CheckRecord> = {}) =>
      ({ open: false, why: sealed ? `the gate stayed closed — ${gate}` : plain, record: { fingerprint: '', model: '', p: '', ...record, outcome: 'closed' as const } });
    const read = this.readVariables(session, spec.vars);
    if ('empty' in read) return closed(`${emptyVariable(read.empty)}: the condition cannot hold`, 'a variable it reads is empty');
    const state = stateOf(read.values);
    const fingerprint = sha256Hex(state);
    const limit = judge.maxStateChars;
    if (limit !== undefined && state.length > limit) {
      return closed(`the state is too large for the judge (${state.length} characters, at most ${limit}) — it was not sent`, 'its state is too large for the judge', { fingerprint });
    }
    let answered: Awaited<ReturnType<JudgePlugin['ask']>>;
    try {
      answered = await judge.ask(state, [{ id, question: spec.question }], model);
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).split(spec.question).join('…');
      return closed(`the judge could not answer (${why})`, `the judge could not answer (${why})`, { fingerprint });
    }
    const probability = answered.answers[id];
    if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) return closed('the judge gave no probability', 'the judge gave no probability', { fingerprint, model: answered.model });
    const record = { fingerprint, model: answered.model, p: String(probability) };
    if (probability >= threshold) {
      return { open: true, why: sealed ? `the gate opened (p=${probability})` : `the judge answered p=${probability}, at or above ${threshold} — the condition holds`, record: { ...record, outcome: 'open' } };
    }
    return closed(`the judge answered p=${probability}, below ${threshold} — the condition does not hold`, `p=${probability}, below ${threshold}`, record);
  }

  /** A delegate's or a program's contract: what it carries out, what it receives, what it answers. */
  private getExecutor(id: string, spec: ApExecutorSpec): number {
    this.out(`# ${spec.site} ${id}  — ${FORMULAS.keywords.EXECUTOR.who[executorKey(spec.executor)]}${spec.by ? ` \`${spec.by}\`` : ''} carries it out, never you`);
    this.out(`${spec.site}: ${spec.text}`);
    const keys = [...spec.input.vars.map(name => `${name} (as stored in this session)`), ...Object.entries(spec.input.constants).map(([key, value]) => `${key} = ${value}`), ...(spec.input.in ? [`in (shaped as ${spec.input.in})`] : [])];
    this.out(`input: ${keys.length ? keys.join(', ') : 'nothing'}  — one key each, nothing else`);
    const out = spec.output.holds ? '{"holds": true | false}'
      : spec.output.into ? `the value of \`${spec.output.into}\`${spec.output.template ? `, shaped as ${spec.output.template}` : ''}`
      : spec.output.template ? `shaped as ${spec.output.template}` : 'its result';
    this.out(`output: ${out}`);
    return 0;
  }

  /** `get <cnd-id>`: a checked condition — its question, unless it is sealed. */
  private getCheck(id: string, spec: ApCheckSpec): number {
    this.out(`# check ${id}  ${checkedKeyword(spec.kind, spec.level)}  — a judge decides it: ${this.cmd} check ${id}`);
    if (spec.level === 2) {
      this.out('# sealed — what it checks is the judge\'s alone, and is not shown');
      return 0;
    }
    this.out(`question: ${spec.question}`);
    this.out(`state: ${spec.vars.join(', ')}  — each variable as stored in this session`);
    return 0;
  }

  /**
   * What is wrong with a JSON text against a contract template — or null when
   * it fits. With `list`, the text is a list of at least `min` instances,
   * reported under `name`.
   */
  contractIssues(json: string, template: ApRef, list?: { name: string; min: number }): string | null {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return 'not valid JSON'; }
    const slots = this.doc.slotsOf(template);
    if (!slots) return null;
    const issues = list
      ? validateRecord({ [list.name]: value }, [{ name: list.name, optional: false, spec: { kind: 'list', ref: refName(template), min: list.min } }], this.doc.slotResolver())
      : validateRecord(value, slots, this.doc.slotResolver());
    return issuesText(issues);
  }

  private version(): number {
    this.out(`# ${this.root.name}  ${this.root.id}`);
    this.out(`# built ${this.build.builtAt} by agent-pack ${this.build.agentPackVersion}  hash ${this.build.hash}  ${this.doc.all().length} blocks`);
    this.out(`# ${CREDIT}`);
    return 0;
  }

  private help(): number {
    const rows: [string, string][] = [...HELP, ...servicesOf(this.doc).flatMap(service => service.operations.map(operation => [`${service.kind} ${operation.op} ${operation.args}`.trim(), operation.about] as [string, string]))];
    const width = Math.max(...rows.map(([command]) => command.length));
    for (const [verb, what] of rows) this.out(`${this.cmd} ${verb.padEnd(width)}  ${what}`);
    return 0;
  }

  // ------------------------------------------------------------ block views

  /**
   * What `get` shows: the agent's whole definition (the preamble, never
   * trimmed); the team as this agent sees it; any other block as its section.
   */
  /**
   * The agent's own definition — its preamble, in the md projection's words —
   * with every reference as the command that fetches it: what `get` prints for
   * the agent, and what a harness file may carry so the agent has it up front.
   */
  definition(): string {
    return this.text(this.root);
  }

  private text(block: ApBlock): string {
    // The root of an agent's document is its definition; a team — a unit's root, or a member's team — is its view.
    if (block === this.root) return renderPreamble(this.doc, this.env);
    if (block.kind === 'team' || block.kind === 'main') return this.teamView(block as TeamBlock | MainBlock);
    return renderEntry(block, 1, this.env);
  }

  /** A unit — a team, or the main: members with the command that reaches each, the main's teams, routing, a team's shared block. */
  private teamView(team: TeamBlock | MainBlock): string {
    const section = (title: string, rows: string[]): string[] => (rows.length > 0 ? [`${title}:`, ...rows.map(row => `  ${row}`)] : []);
    const memberRow = (memberRef: ApRef): string => {
      const member = this.doc.reach(memberRef);
      return `${this.refLabel(memberRef)}${member?.about ? `  — ${member.about}` : ''}`;
    };
    return `${[
      this.headLine(team),
      ...section('members', team.members.map(memberRow)),
      ...section('teams', team.kind === 'main' ? team.teams.map(teamRef => this.refLabel(teamRef)) : []),
      ...section('routing', renderNodes(this.env, team.body)),
      ...(team.kind === 'team' && team.shared ? [`shared: ${team.shared}`] : []),
    ].join('\n')}\n`;
  }

  /** `uses:` and `used by:` of a block, each with its command. */
  private links(block: ApBlock): void {
    // Every policy in the document binds the agent — imported, not referenced by a line.
    const policies = block === this.root ? this.doc.byKind('policy') : [];
    const uses = [...uniqueRefs(block.toJSON()).map(ref => this.refLabel(ref)), ...policies.map(policy => this.label(policy))];
    this.out('uses:');
    if (uses.length === 0) this.out('  (nothing)');
    for (const use of uses) this.out(`  ${use}`);
    this.out('used by:');
    const users = this.doc.all().filter(candidate => candidate !== block && (
      uniqueRefs(candidate.toJSON()).some(ref => ref.target === block.address) || (block.kind === 'policy' && candidate === this.root)));
    if (users.length === 0) this.out('  (nothing inside this agent)');
    for (const user of users) this.out(`  ${this.label(user)}`);
  }

  // ---------------------------------------------------------------- helpers

  /** `kind name  [command]` — how a block reads in the engine's views. */
  private label(block: ApBlock): string {
    return `${block.kind} ${block.name}  [${this.cmd} ${block.kind === 'flow' ? 'flow' : 'get'} ${block.id}]`;
  }

  /** A reference as a label: here → its block; a fellow agent → its own executable; a team → its apx, whose start prints its routing and flows. */
  private refLabel(ref: ApRef): string {
    const block = this.doc.resolve(ref);
    if (block) return this.label(block);
    const name = refName(ref);
    if (ref.kind === 'agent') return `agent ${name}  [${this.sibling(name)} scope]`;
    if (ref.kind === 'team') return `team ${name}  [${this.sibling(name)} start]`;
    return `${ref.kind} ${name}  (missing from the compiled sources)`;
  }

  /** How to run a fellow agent: through the same unit, or its executable beside this one, in the same form — an apx by Node, a binary as it is. */
  private sibling(name: string): string {
    if (this.inUnit !== null) return `${runCommand(this.exe)} ${name}`;
    return runCommand(join(dirname(this.exe), isApx(this.exe) ? `${name}.apx` : name));
  }

  private headLine(block: ApBlock): string {
    return `# ${block.kind} ${block.name}${block.about ? ` — ${block.about}` : ''}`;
  }

  private lsLine(block: ApBlock): string {
    const tags = block.tags.length > 0 ? `  ${block.tags.map(tag => `#${tag}`).join(' ')}` : '';
    // A policy or a skill says where it holds: its perimeter, or only under a WITH that names it (src/withUse.ts).
    const scope = SCOPED_KINDS.includes(block.kind) ? `  [${scopeLabel(block.scopes)}]` : '';
    return `${block.id}  ${block.name}${tags}${scope}${block.about ? `  — ${block.about}` : ''}`;
  }

  /** Blocks grouped by kind, in reading order. */
  private groups(blocks: ApBlock[]): [string, ApBlock[]][] {
    const kinds = [...new Set(blocks.map(block => block.kind))].sort((left, right) => kindRank(left) - kindRank(right));
    return kinds.map(kind => [kind, blocks.filter(block => block.kind === kind)]);
  }

  /** The compiled script of this version of a flow — or null. */
  private flowScript(flow: ApBlock): string | null {
    const stem = flowScriptStem(flow.id, flow.contentHash);
    return this.findIn(FLOWS_DIR, file => file.startsWith(`${stem}.`));
  }

  /** The first file of a project folder that matches — its path, or null. */
  private findIn(folder: string, match: (file: string) => boolean): string | null {
    const dir = resolve(projectRootOf(this.exe), folder);
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find(match);
    return file ? join(dir, file) : null;
  }

  /** The quiz: the questions of every kind this agent holds, in reading order. */
  /** Questions on the kinds the agent still reads on demand — an opened block needs no quiz. */
  private quiz(): (QuizQuestion & { kind: string })[] {
    const guides = FORMULAS.blocks as unknown as Record<string, { quiz?: QuizQuestion[] }>;
    const opened = new Set(this.opened());
    const pending = this.doc.all().filter(block => block !== this.root && !opened.has(block));
    if (pending.length === 0) return [];
    return this.groups([this.root, ...pending]).flatMap(([kind]) => (guides[kind]?.quiz ?? []).map(question => ({ ...question, kind })));
  }

  /** The block named by a verb's id argument, or null after printing the error. */
  lastCode = 0;
  private blockArg(verb: string, args: string[]): ApBlock | null {
    const id = args[0];
    if (!id) {
      this.lastCode = this.fail(2, `${verb} needs a block id — example: ${this.cmd} ${verb} ${this.root.id}`);
      return null;
    }
    const block = this.byId.get(id);
    if (block) return block;
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    const fellow = team?.members.find(member => member.id === id && !this.doc.resolve(member));
    this.lastCode = fellow
      ? this.fail(1, `${id} is an agent defined in its own executable — run: ${this.sibling(addressName(fellow.target))} scope`)
      : this.notFound(id);
    return null;
  }

  /** Neither a block nor a variable answers to this name. */
  private notFound(name: string): number {
    return this.fail(1, `no block with id '${name}' and no variable named so — list them: ${this.cmd} ls`);
  }

  out(line: string): void {
    this.write(line);
  }

  /** Print a multi-line text as it is (one trailing newline trimmed). */
  print(text: string): number {
    this.write(text.replace(/\n$/, ''));
    return 0;
  }

  fail(code: number, message: string): number {
    this.write(`# error: ${message}`);
    return code;
  }

  // -------------------------------------------------------------- variables

  /**
   * `get <name>`: a constant's value, or a variable (private or SESSION) — its definition,
   * who stores it and who reads it, then its value in this session (or that it
   * is still empty). The value is printed last, as stored, byte for byte.
   */
  private getVariable(name: string): number {
    const constant = constantOf(this.doc.mdSource?.vars, name);
    if (constant !== undefined) {
      this.out(`# constant ${name} = ${constant}  — fixed at compile time: its value is written where it is read`);
      return 0;
    }
    const block = this.variable(name);
    if (!block) return this.notFound(name);
    const vars = this.sessionVars();
    if (!vars) return this.lastCode;
    let stored: string | null;
    try { stored = vars.read(name, block.scope); } catch (error) { return this.fail(2, `reading ${name}: ${error instanceof Error ? error.message : error}`); }
    this.print(this.text(block));
    this.out(`# var ${name}  ${block.id}`);
    this.links(block);
    this.out('read by:');
    const readers = this.doc.all().filter(candidate => readsOf(JSON.stringify(candidate.body)).some(read => read.name === name && !read.field));
    if (readers.length === 0) this.out('  (nothing inside this agent)');
    for (const reader of readers) this.out(`  ${this.label(reader)}`);
    if (stored === null) {
      this.out('# value: (empty — nothing stored in this session yet)');
    } else {
      this.out('# value:');
      this.write(stored);
    }
    return 0;
  }

  /**
   * `set <name> -|<value>`: store a variable's value for this session —
   * the last write wins. A constant is never set; a typed variable takes only
   * JSON its template accepts. A refused value writes nothing.
   */
  private set(args: string[]): number {
    const [name, ...rest] = args;
    if (!name || rest.length === 0) {
      return this.fail(2, `set needs a variable and its value — ${this.cmd} set <name> <value>, or ${this.cmd} set <name> - with the value on stdin`);
    }
    if (constantOf(this.doc.mdSource?.vars, name) !== undefined) {
      return this.fail(1, `\`${name}\` is a constant, fixed at compile time — only a variable is set; nothing was written`);
    }
    const block = this.variable(name);
    if (!block) return this.fail(1, `no variable \`${name}\` in this agent — the variables: ${this.cmd} ls kind=var; nothing was written`);
    const value = rest.length === 1 && rest[0] === '-' ? readFileSync(0, 'utf-8') : rest.join(' ');
    const failed = this.storeVariable(block, value);
    if (failed) {
      // A typed value refused: the shape it takes, spelled out, so the next try is the right one.
      const slots = block.type ? this.doc.slotsOf(block.type) : null;
      if (slots && failed.code === 2) this.out(`# the JSON \`${refName(block.type!)}\` takes: ${JSON.stringify(jsonExample(slots, this.doc.slotResolver()))}`);
      return this.fail(failed.code, `${failed.reason} — nothing was written`);
    }
    this.out(`# ${name} stored for this session — read it: ${this.cmd} get ${name}`);
    return 0;
  }

  /**
   * The one write of a variable: a typed one takes only JSON its template
   * (compiled into this agent) accepts. Null once stored; else why not, and the
   * exit code to fail with — `set`, and an answer or a run stored `INTO` it.
   */
  storeVariable(block: VarBlock, value: string): { code: number; reason: string } | null {
    const type = block.type ? refName(block.type) : '';
    if (block.type) {
      if (!this.doc.slotsOf(block.type)) return { code: 1, reason: notCompiled(block.name, type) };
      const issues = this.contractIssues(value, block.type);
      if (issues) return { code: 2, reason: `the value is not shaped as \`${type}\`: ${issues}` };
    }
    const session = this.openSession();
    if (typeof session === 'string') return { code: 2, reason: session };
    try { session.write(block.name, block.scope, { value, type, by: this.root.name }); } catch (error) { return { code: 2, reason: `storing ${block.name}: ${error instanceof Error ? error.message : error}` }; }
    return null;
  }

  /** The values this session stores for `names`, in order — or the first one that is empty. */
  private readVariables(session: SessionVars, names: string[]): { values: { name: string; value: string }[] } | { empty: string } {
    const values: { name: string; value: string }[] = [];
    for (const name of names) {
      const block = this.variable(name);
      const value = block ? session.read(name, block.scope) : null;
      if (value === null || value.trim() === '') return { empty: name };
      values.push({ name, value });
    }
    return { values };
  }

  /** A variable of this agent, by name. */
  variable(name: string): VarBlock | null {
    return (this.doc.byKind('var') as VarBlock[]).find(variable => variable.name === name) ?? null;
  }

  /**
   * This session's variables, from the session id the harness puts in the
   * variable its adapter names. Fails closed — no adapter naming one, no id, an
   * id that is no folder name, or storage that cannot keep them: null after
   * the error, nothing read or written.
   */
  private sessionVars(): SessionVars | null {
    const session = this.openSession();
    if (typeof session !== 'string') return session;
    this.lastCode = this.fail(2, `${session} — nothing was read or written`);
    return null;
  }

  /** This session's variables — or why there are none. */
  openSession(): SessionVars | string {
    const env = this.doc.meta.sessionEnv;
    const id = env ? process.env[env] : undefined;
    const refused = !env
      ? 'variables need the harness session id, and this agent was compiled without an adapter that names where it is'
      : !id ? `variables need the harness session id, and ${env} is not set`
        : !SESSION_ID_RE.test(id) ? `${env} holds no usable session id (letters, digits, . _ - only)` : null;
    return refused ?? openSessionVars(resolve(projectRootOf(this.exe)), id!, this.root.name);
  }

  // -------------------------------------------------------------- contracts

  /** The session id the harness gives — or why there is none (the same rule the variables follow). */
  sessionIdOrReason(needs = 'contracts need'): { id: string } | { reason: string } {
    const env = this.doc.meta.sessionEnv;
    const id = env ? process.env[env] : undefined;
    if (!env) return { reason: `${needs} the harness session id, and this agent was compiled without an adapter that names where it is` };
    if (!id) return { reason: `${needs} the harness session id, and ${env} is not set` };
    if (!SESSION_ID_RE.test(id)) return { reason: `${env} holds no usable session id (letters, digits, . _ - only)` };
    return { id };
  }

  /** The session's registry and copies — or null after saying why there are none. */
  private contractCx(): ContractCx | null {
    const session = this.sessionIdOrReason();
    if ('reason' in session) { this.lastCode = this.fail(2, `${session.reason} — nothing was read or written`); return null; }
    const root = resolve(projectRootOf(this.exe));
    const table = DelegationTable.open(root, session.id);
    let ws: WorkspaceSession | null = null;
    // The copies: opened on the first verb that needs them — a project outside git fails there, with the way out.
    return { table, root, session: session.id, ws: () => ws ??= resolveWorkspace(CONTRACT_WORKSPACE).session(root, session.id) };
  }

  /**
   * `contract <verb> …` — the contracts a flow's MARKs bind (D16–18): `mark`
   * one, `start` a MARK's, `get` one's spec, `within` for the hook, `merge` and
   * `land` after a conflict, `list`. Delivering, blocking, taking over — the
   * life of any piece handed out — is `delegate`'s, on the same registry.
   */
  private async contract(args: string[]): Promise<number> {
    const [verb, ...rest] = args;
    const verbs = 'mark|start|get|within|merge|land|list';
    if (!verb || !verbs.split('|').includes(verb)) return this.fail(2, `${verb ? `'${verb}' is no verb of contract` : 'contract takes a verb'} — ${this.cmd} contract ${verbs}`);
    const cx = this.contractCx();
    if (!cx) return this.lastCode;
    try {
      switch (verb) {
        case 'mark': return this.contractMark(cx, rest);
        case 'start': return this.contractStart(cx, rest);
        case 'get': return this.contractGet(cx, rest);
        case 'within': return this.contractWithin(cx, rest);
        case 'merge': return this.contractMerge(cx, rest);
        case 'land': return this.contractLand(cx);
        default: return this.contractList(cx, rest);
      }
    } catch (error) {
      return this.fail(2, `the contracts could not be read or written: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** An agent's own perimeter — this one's, or a fellow member's from its apx beside this one; null when it has none or no apx. */
  private agentPerimeter(agent: string): PerimeterGlobs | null {
    if (agent === this.root.name) return this.doc.perimeter();
    const file = resolve(this.projectRoot, apxPath(agent));
    if (!existsSync(file)) return null;
    try {
      return ApDocumentClass.fromJson(parsePayload(readFileSync(file, 'utf-8')).document).perimeter();
    } catch {
      return null;
    }
  }

  /** The perimeter a piece is handed under (D65) — see ApxHost.workPerimeter. */
  workPerimeter(within: readonly string[], assignee: string): string {
    const sets: string[][] = [];
    if (within.length > 0) sets.push([...new Set(within.flatMap(name => this.domainGlobs(name)))]);
    const own = assignee ? this.agentPerimeter(assignee) : null;
    if (own) sets.push(own.writes);
    return sets.length > 0 ? JSON.stringify(sets) : '';
  }

  /**
   * `guard <path> [--agent <name>] [--subagent] [--after]` — whether a write
   * stays within the perimeter of the work in progress (D65): exit 0, or 3 with
   * who, which file, which perimeter, and what to do. What a harness hook asks
   * before every write (adapters/claude-code).
   *
   * Which work a write belongs to: the harness says only who writes — the main
   * conversation, or a subagent of a given name. A subagent named as the
   * assignee of pieces in progress is held to theirs; one it cannot tell apart
   * (a fork, an agent no piece names) to every piece in progress that has a
   * perimeter — the narrowest reading, never the widest. The main conversation
   * — whoever runs the flow — is held to none. Every agent is held to its own
   * `@WITHIN` as well. A contract's work goes in its copy: `--after`, there,
   * says whether the file stays within the contract.
   */
  private guard(args: string[]): number {
    const at = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] ?? '' : null; };
    const agent = at('--agent') || '';
    const subagent = args.includes('--subagent');
    const path = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--agent');
    if (!path) return this.fail(2, `a path is needed, from the project root — ${this.cmd} guard <path> [--agent <name>] [--subagent]`);
    const copy = new RegExp(`^${WORK_DIR}/(ctr-[0-9a-f]{8})/(.+)$`).exec(path);
    if (args.includes('--after')) {
      if (!copy) return 0;
      const cx = this.contractCx();
      if (!cx) return this.lastCode;
      return this.contractWithin(cx, [copy[1], copy[2]]);
    }
    const blocked = (why: string) => { this.out(`${path}: ${why} — do not write it; if the work needs it, say so in your delivery`); return 3; };
    if (agent) {
      // A contract's copy mirrors the project root: its files are judged by their path inside it.
      const own = this.agentPerimeter(agent);
      if (own && !matchesAnyGlob(copy ? copy[2] : path, own.writes)) return blocked(`outside ${agent}'s own perimeter (${own.writes.join(', ') || 'it writes nothing'})`);
    }
    if (!subagent) return 0;
    const session = this.sessionIdOrReason('guard needs');
    if ('reason' in session) return 0;   // no session, no work recorded in it
    const table = DelegationTable.open(this.projectRoot, session.id);
    const running = table.all().filter(record => record.state === 'running');
    const mine = agent ? running.filter(record => record.assignee === agent) : [];
    // A write in a contract's copy is that contract's: its zones are checked once written (--after).
    if (copy && running.some(record => record.dlg === copy[1])) return 0;
    const held = mine.length > 0 ? mine : running;
    for (const record of held) {
      if (CONTRACT_ID_RE.test(record.dlg)) {
        // Its assignee works in its copy, never in the project folder; whoever else writes is not bound by it.
        if (mine.length > 0) return blocked(`${agent} carries out ${record.dlg} in its copy, ${WORK_DIR}/${record.dlg}/ — not in the project folder`);
        continue;
      }
      if (!record.perimeter) continue;
      const sets = JSON.parse(record.perimeter) as string[][];
      const miss = sets.find(globs => !matchesAnyGlob(path, globs));
      if (miss) {
        const who = mine.length > 0 ? `${agent}, carrying out ${record.dlg} (${record.step})` : `the work in progress ${record.dlg} (${record.step}${record.assignee ? `, ${record.assignee}` : ''}) — this write could not be told apart from it`;
        return blocked(`outside the perimeter of ${who}: ${miss.join(', ') || 'it writes nothing'}`);
      }
    }
    return 0;
  }

  /** A MARK of this agent's flows by id — or null after saying why. */
  private markArg(id: string | undefined, usage: string): (ApMark & { id: string }) | null {
    const mark = id ? this.doc.meta.marks?.[id] : undefined;
    if (!id || !MARK_ID_RE.test(id) || !mark) {
      this.lastCode = this.fail(2, `${id ? `${id} is no MARK of this agent's flows` : 'a MARK id is needed (mrk-…)'} — ${this.cmd} contract ${usage}; the compiled flow names it`);
      return null;
    }
    return { ...mark, id };
  }

  /** A contract by its id — or null after saying why. */
  private contractArg(cx: ContractCx, id: string | undefined, usage: string): DelegationRecord | null {
    if (!id || !CONTRACT_ID_RE.test(id)) { this.lastCode = this.fail(2, `a contract id is needed (ctr-…) — ${this.cmd} contract ${usage}`); return null; }
    const record = cx.table.get(id);
    if (!record) { this.lastCode = this.fail(1, `no contract ${id} in this session — ${this.cmd} contract list`); return null; }
    return record;
  }

  /** The template a MARK's spec is shaped as, as a reference — null when this agent was compiled without it. */
  private specRef(mark: ApMark): ApRef | null {
    const template = this.doc.byKind('template').find(block => block.name === mark.spec);
    return template ? { id: template.id, target: template.address, kind: 'template' } : null;
  }

  /** The globs a domain of this document writes — what a MARK's WITHIN lets its contracts write beyond their zones. */
  private domainGlobs(name: string | null): string[] {
    const domain = name ? (this.doc.byKind('domain') as DomainBlock[]).find(block => block.name === name) : undefined;
    if (!domain) return [];
    const side = domain.side('WRITES');
    return [...side.globs, ...[...side.within, ...Object.keys(side.uncertain)].map(literalGlob)];
  }

  /** What a contract's delivery may keep: its zones, the files it created, and its MARK's WITHIN domain (D49). */
  private allowedOf(record: DelegationRecord): Allowed {
    const files = [...new Set(parseZones(record.zone).map(zone => zone.file))];
    return {
      globs: [...files, ...record.writes.split(',').filter(Boolean)],
      ...(files.length ? { marks: { ...zoneMarks(record.dlg), files, only: true } } : {}),
      created: true,
    };
  }

  /**
   * `mark <mrk-id> -` — whoever runs the flow binds a zone to a contract: the
   * spec on stdin, checked against the MARK's AS; the contract waits, marked,
   * until a DELEGATE of its list starts it. Its id joins the list's variable.
   */
  private contractMark(cx: ContractCx, args: string[]): number {
    const usage = 'mark <mrk-id> - < spec.json';
    const mark = this.markArg(args[0], usage);
    if (!mark) return this.lastCode;
    if (args[1] !== '-') return this.fail(2, `the spec comes on stdin — ${this.cmd} contract ${usage}`);
    const waiting = cx.table.all().filter(record => record.mark === mark.id && record.state === 'marked');
    const max = mark.max || this.build.markMax || DEFAULT_MARK_MAX;
    if (waiting.length >= max) return this.fail(3, `${mark.list} holds ${max} zones already — the MARK's limit; nothing was written`);
    const ref = this.specRef(mark);
    if (!ref) return this.fail(2, notCompiled(mark.list, mark.spec));
    const text = readFileSync(0, 'utf-8').trim();
    const issues = this.contractIssues(text, ref);
    if (issues) {
      const slots = this.doc.slotsOf(ref);
      const example = slots ? ` — a spec is JSON shaped like ${JSON.stringify(jsonExample(slots, this.doc.slotResolver()))}` : '';
      return this.fail(6, `the spec breaks the form of ${mark.spec}: ${issues}${example}; nothing was written`);
    }
    const spec = JSON.stringify(JSON.parse(text));
    const ctr = shortId('ctr', JSON.stringify([cx.session, mark.id, cx.table.all().filter(record => record.mark === mark.id).length, spec]));
    // The list's variable holds its contracts' ids — what `{{<list>}}` reads.
    const list = this.variable(mark.list);
    if (list) {
      const ids = [...waiting.map(record => record.dlg), ctr];
      const failed = this.storeVariable(list, JSON.stringify(ids));
      if (failed) return this.fail(6, `\`${mark.list}\` holds the ids of its contracts: ${failed.reason} — declare it as a plain variable; nothing was written`);
    }
    cx.table.add(pieceRecord({ dlg: ctr, state: 'marked', flow: mark.flow, step: mark.step, into: mark.list, mark: mark.id, spec, author: this.root.name }));
    const marks = zoneMarks(ctr);
    this.out(`${ctr}  ${mark.list}  marked`);
    return this.print(`# write \`${marks.open}\` where its zone starts and \`${marks.close}\` where it ends, each inside a comment — in any files; the marks stay`);
  }

  /**
   * `start <mrk-id> --by <agent>` — a DELEGATE of a list starts every contract
   * its MARK left waiting: each one's zones are found by their marks, what was
   * merged since the last round lands, and each one gets its copy (D64: one
   * agent for the whole list). None waiting: nothing to start, and it says so.
   * `--by <harness>:<agent>`: each one is launched on another harness (D66) —
   * its prompt written beside its copy, its command printed, filled from the
   * harness's recipe, for the caller to run.
   */
  private contractStart(cx: ContractCx, args: string[]): number {
    const usage = 'start <mrk-id> --by <agent | harness:agent>';
    const mark = this.markArg(args[0], usage);
    if (!mark) return this.lastCode;
    const by = flagValue(args.slice(1), '--by');
    if (!by) return this.fail(2, `say who carries the contracts out — ${this.cmd} contract ${usage}`);
    const other = splitHarness(by);
    const inv = other ? this.doc.meta.harnesses?.[other.harness] : undefined;
    if (other && !inv) {
      return this.fail(2, `${other.harness}'s recipe was not compiled into ${this.root.name} — write \`DELEGATE ${mark.list} BY ${by}\` in its flow and bundle again; nothing was started`);
    }
    const agent = other?.agent ?? by;
    const pending = cx.table.all().filter(record => record.mark === mark.id && record.state === 'marked');
    if (pending.length === 0) return this.print(`# ${mark.list}: no zone was marked — nothing to start`);
    const scope = this.doc.perimeter()?.writes;
    const files = perimeterFiles(cx.root, scope && scope.length ? scope : ['**']);
    const { zones, problems } = scanZones(cx.root, files, pending.map(record => record.dlg));
    const refusals = [...problems].map(([ctr, why]) => `${ctr}: ${why}`);
    const within = this.domainGlobs(mark.within);
    for (const record of pending) {
      if (!zones.get(record.dlg) && !problems.has(record.dlg) && within.length === 0) {
        refusals.push(`${record.dlg}: no zone is marked — write \`${zoneMarks(record.dlg).open}\` … \`${zoneMarks(record.dlg).close}\` inside comments, or give its MARK a WITHIN domain`);
      }
    }
    if (refusals.length) {
      for (const line of refusals) this.out(`refused: ${line}`);
      return this.fail(3, `nothing was started — fix the ${countOf(refusals.length, 'contract', 'contracts')} above and start again`);
    }
    const landing = cx.ws().land();
    if ('conflicts' in landing) return this.fail(3, `what was merged conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then start again`);
    if (landing.landed.length) this.out(`# landed in the working folder: ${landing.landed.join(', ')}`);
    const at = new Date().toISOString();
    for (const record of pending) {
      const zs = zones.get(record.dlg) ?? [];
      const writes = [...new Set([...zs.map(zone => zone.file), ...within])];
      let command: string | null = null;
      if (inv) command = this.openElsewhere(cx, record.dlg, inv, agent, writes, this.contractPrompt(record, mark, zs, within), null);
      else cx.ws().open(record.dlg, { reads: null, writes });
      const fields = { assignee: agent, zone: zonesText(zs), writes: within.join(','), started_at: at, ...(other ? { harness: other.harness } : {}) };
      if (!cx.table.transition(record.dlg, 'marked', 'running', fields)) return this.fail(4, `${record.dlg} changed meanwhile — ${this.cmd} contract list ${mark.id}`);
      this.out(`${record.dlg}  → ${agent}${other ? ` on ${other.harness}` : ''}${zs.length ? `  ${zonesText(zs)}` : ''}  copy: ${cx.ws().path(record.dlg)}`);
      if (command) this.out(command);
    }
    const started = countOf(pending.length, 'contract', 'contracts');
    if (!other || !inv) return this.print(`# ${started} started — hand each one to ${by} with its id; ${this.cmd} wait ${mark.id} takes them back`);
    this.out(`# ${started} started on ${other.harness} — run each command above with your shell, all at once`);
    return this.elsewhereTail(inv, agent, other.harness, { id: '<ctr-id>', many: true, flags: ' [--why "<reason>"]', then: `; ${this.cmd} wait ${mark.id} takes them back` });
  }

  /** What a contract launched on another harness is handed: its spec, its zones, what else it may write — never the conversation (D66). */
  private contractPrompt(record: DelegationRecord, mark: ApMark, zones: Parameters<typeof zonesText>[0], within: string[]): string[] {
    const marks = zoneMarks(record.dlg);
    return [
      `Carry out the contract ${record.dlg}: its spec, shaped as \`${mark.spec}\`, is`,
      '```json', JSON.stringify(JSON.parse(record.spec || '{}'), null, 2), '```',
      ...(zones.length ? ['', `Its zones: ${zonesText(zones).split(';').join(', ')} — write inside them, between the lines that hold \`${marks.open}\` and \`${marks.close}\`, and leave those marks where they are.`] : []),
      '', `You may also create files${within.length ? `, and write ${within.join(', ')}` : ''}; anything else you change is left out of the delivery.`,
      'When the contract cannot be honoured as written, change nothing and say why.',
    ];
  }

  private contractList(cx: ContractCx, args: string[]): number {
    const mark = args[0] ? this.markArg(args[0], 'list [mrk-id]') : null;
    if (args[0] && !mark) return this.lastCode;
    const all = cx.table.all().filter(record => CONTRACT_ID_RE.test(record.dlg) && (!mark || record.mark === mark.id));
    for (const record of all) {
      this.out(`${record.dlg}  ${record.into}  ${record.state === 'ended' ? 'ended without delivery' : record.state}${record.assignee ? `  → ${record.assignee}` : ''}${record.zone ? `  ${record.zone}` : ''}${record.left_out ? `  left out: ${record.left_out}` : ''}${record.reason ? `  — ${record.reason}` : ''}`);
    }
    return this.print(`# ${countOf(all.length, 'contract', 'contracts')} in this session — one: ${this.cmd} contract get <ctr-id>`);
  }

  private contractGet(cx: ContractCx, args: string[]): number {
    const record = this.contractArg(cx, args[0], 'get <ctr-id>');
    if (!record) return this.lastCode;
    this.out(`contract ${record.dlg} — of ${record.into} — ${record.state}${record.assignee ? ` — carried out by ${record.assignee}` : ''}`);
    this.out(`zones: ${record.zone ? record.zone.split(';').join(', ') : record.state === 'marked' ? '(not started yet)' : 'none'}`);
    this.out(`may write: its zones, the files it creates${record.writes ? `, ${record.writes.split(',').join(', ')}` : ''}`);
    if (record.state !== 'marked') this.out(`copy: ${cx.ws().path(record.dlg)}`);
    if (record.reason) this.out(`blocked: ${record.reason}`);
    if (record.left_out) this.out(`left out: ${record.left_out} — why: ${record.why}`);
    this.out('spec:');
    this.print(JSON.stringify(JSON.parse(record.spec || '{}'), null, 2));
    if (record.state === 'running') {
      this.out(`# work in your copy: cd ${cx.ws().path(record.dlg)} — read and write only there; write inside its zones, leave the marks where they are`);
      this.out(`# when done: ${this.cmd} delegate deliver ${record.dlg}`);
      this.out(`# if it cannot be honoured as written: ${this.cmd} delegate block ${record.dlg} "<why>"`);
    }
    return 0;
  }

  /**
   * `within <ctr> <path>` — whether a file the contract's copy changed stays
   * within it: exit 0, or 3 with the warning. What a harness hook calls as
   * soon as the file is written (adapters/claude-code).
   */
  private contractWithin(cx: ContractCx, args: string[]): number {
    const record = this.contractArg(cx, args[0], 'within <ctr-id> <path>');
    if (!record) return this.lastCode;
    const path = args[1];
    if (!path) return this.fail(2, `a path is needed — ${this.cmd} contract within ${record.dlg} <path>`);
    if (record.state === 'marked') return this.fail(2, `${record.dlg} has no copy yet — it was not started`);
    const delivery = cx.ws().deliver(record.dlg, this.allowedOf(record), { dryRun: true });
    const hit = (entry: string) => entry === path || entry.startsWith(`${path} (`);
    const lost = delivery.lostZones.filter(hit);
    if (lost.length) { this.out(`${lost.join(', ')}: the marks of ${record.dlg}'s zones are lost — put them back around your work, as they were written`); return 3; }
    const out = delivery.leftOut.filter(hit);
    if (out.length === 0) return 0;
    this.out(`${out.join(', ')} is outside ${record.dlg} — its zones, the files it creates${record.writes ? ` and ${record.writes}` : ''}: it will be left out of the delivery — keep it only with a good reason, you will be asked for it at deliver`);
    return 3;
  }

  /**
   * A contract delivered from its copy (`delegate deliver <ctr-id>`): it keeps
   * its zones, the files it created and its WITHIN domain; anything else is
   * left out, and only with a reason (`--why`).
   */
  private deliverContract(table: DelegationTable, record: DelegationRecord, words: string[]): number {
    const cx = this.contractCx();
    if (!cx) return this.lastCode;
    const piece = new Piece(record);
    const args = new ApxArgs(words);
    const refused = FORMULAS.apx.deliver.refused;
    const done = FORMULAS.apx.deliver.done;
    if (!piece.isRunning()) return this.fail(1, fill(refused.notRunning, { id: piece.id, state: piece.state }));
    // On another harness (D66): its answer is the file its command wrote; what was carried into its copy is never delivered.
    if (piece.isElsewhere() && !args.hasAnswer()) return this.fail(2, answerFlag(record, this.cmd));
    const answer = piece.isElsewhere() ? this.elsewhereAnswer(cx, record) : null;
    if (piece.isElsewhere() && answer === null) return this.lastCode;
    const allowed: Allowed = { ...this.allowedOf(record), ...(piece.isElsewhere() ? { exclude: [...this.carriedOf(record)] } : {}) };
    const delivery = cx.ws().deliver(piece.id, allowed, { dryRun: true });
    const why = args.why();
    switch (deliveryRefusal(delivery, why)) {
      case 'lostZones':
        return this.fail(3, fill(refused.lostZones, { id: piece.id, files: delivery.lostZones.join(', ') }));
      case 'strayed':
        return this.fail(3, fill(refused.strayed, { id: piece.id, files: delivery.strayed.join(', '), copy: cx.ws().path(piece.id) }));
      case 'leftOut':
        for (const entry of delivery.leftOut) this.out(fill(done.leftOutLine, { entry }));
        return this.fail(3, fill(refused.leftOut, { id: piece.id, cmd: this.cmd }));
      case null:
        break;
    }
    cx.ws().deliver(piece.id, allowed);
    const fields = { left_out: delivery.leftOut.join('; '), why: delivery.leftOut.length ? (why ?? '').replace(/\s+/g, ' ') : '', ...(answer !== null ? { result: JSON.stringify(answer) } : {}) };
    if (!table.transition(piece.id, STATE.running, STATE.delivered, fields)) return this.fail(1, fill(refused.moved, { id: piece.id, cmd: this.cmd }));
    this.out(fill(done.delivered, { id: piece.id, files: delivery.committed.length ? delivery.committed.join(', ') : done.nothing }));
    if (delivery.leftOut.length) this.out(fill(done.leftOut, { files: delivery.leftOut.join(', '), why: why ?? '' }));
    if (answer) this.out(fill(done.answer, { answer }));
    return 0;
  }

  /** The answer of a piece that ran on another harness, from the file its command wrote — null after saying why there is none. */
  private elsewhereAnswer(cx: ContractCx, record: DelegationRecord): string | null {
    const files = this.elsewhereFiles(cx, record.dlg);
    if (!existsSync(files.answer)) {
      this.lastCode = this.fail(1, `${record.dlg} wrote no answer (${files.answer}) — run its command again, or ${this.cmd} delegate block ${record.dlg} "<why>"`);
      return null;
    }
    return readFileSync(files.answer, 'utf-8').trim();
  }

  /** The files carried into the copy of a piece on another harness — its agent's definition — never delivered back. */
  private carriedOf(record: DelegationRecord): Set<string> {
    const inv = record.harness ? this.doc.meta.harnesses?.[record.harness] : undefined;
    return new Set((inv?.carry ?? []).map(pattern => pattern.replace(/\{agent\}/g, record.assignee)));
  }

  /** The files a delegation to another harness keeps beside its copy: the prompt it is handed, the answer it writes, the schema of an AS. */
  private elsewhereFiles(cx: ContractCx, dlg: string): { copy: string; prompt: string; answer: string; schema: string } {
    const copy = resolve(cx.root, cx.ws().path(dlg));
    return { copy, prompt: `${copy}.prompt.md`, answer: `${copy}.answer.txt`, schema: `${copy}.schema.json` };
  }

  /**
   * A delegation to another harness, started (D66): its copy is opened, the
   * files its harness needs and the copy may not hold are carried in, its
   * prompt is written — the task, what it reads, the form of its AS — and the
   * harness's recipe is printed, filled, with the rules to run it by. The
   * command is the caller's to run: nothing is launched here.
   */
  private launchElsewhere(record: DelegationRecord): number {
    const work = this.doc.meta.background?.[pieceOf(record.dlg).work];
    const inv = work?.harness ? this.doc.meta.harnesses?.[work.harness] : undefined;
    if (!work?.harness || !inv) return this.fail(2, `${record.dlg} goes to another harness, but its recipe was not compiled into ${this.root.name} — bundle again`);
    const agent = work.by ?? '';
    const cx = this.contractCx();
    if (!cx) return this.lastCode;
    const landing = cx.ws().land();
    if ('conflicts' in landing) return this.fail(3, `what was merged conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then start again`);
    // What it is handed: the task, the variables and constants it reads — never the conversation (D66).
    const names = [...new Set(readsOf(work.task).map(reference => reference.name))];
    const vars = this.sessionVars();
    const read = vars ? this.readVariables(vars, names.filter(name => constantOf(this.doc.mdSource?.vars, name) === undefined)) : { values: [] };
    if ('empty' in read) return this.fail(1, `${emptyVariable(read.empty)}: fill it before ${record.dlg} is handed over`);
    const handed = [...names.flatMap(name => { const constant = constantOf(this.doc.mdSource?.vars, name); return constant === undefined ? [] : [{ name: name, value: constant }]; }), ...read.values];
    const shape = this.elsewhereShape(record.dlg);
    const prompt = [
      work.task,
      ...(handed.length ? ['', 'What you are handed:', '```json', JSON.stringify(Object.fromEntries(handed.map(entry => [entry.name, entry.value])), null, 2), '```'] : []),
      ...(shape ? ['', `Answer with JSON shaped as \`${refName(shape)}\`, like: ${JSON.stringify(jsonExample(this.doc.slotsOf(shape)!, this.doc.slotResolver()))}`] : []),
    ];
    const command = this.openElsewhere(cx, record.dlg, inv, agent, ['**'], prompt, shape);
    if (!cx.table.transition(record.dlg, 'running', 'running', { harness: work.harness })) return this.fail(4, `${record.dlg} changed meanwhile — ${this.cmd} delegate list`);
    this.out(`${record.dlg}  → ${agent} on ${work.harness}  copy: ${cx.ws().path(record.dlg)}`);
    this.out('# run, with your shell:');
    this.out(command);
    return this.elsewhereTail(inv, agent, work.harness, { id: record.dlg });
  }

  /** What follows the commands of pieces on another harness: the model, the recipe's rules, and how each one ends — `id` its id, or a placeholder when `many`. */
  private elsewhereTail(inv: HarnessInvocation, agent: string, harness: string, end: { id: string; many?: boolean; flags?: string; then?: string }): number {
    if (inv.model) {
      const model = this.modelOf(inv, agent);
      this.out(model ? `# model: ${model} — the one ${agent}'s BUDGET tier maps to on ${harness}` : `# model: ${harness}'s own default — ${agent}'s BUDGET tier maps to none on ${harness}`);
    }
    for (const rule of inv.rules) this.out(`# ${rule}`);
    return this.print(`# when ${end.many ? 'one' : 'it'} ends: ${this.cmd} delegate deliver ${end.id} --answer${end.flags ?? ''} — or: ${this.cmd} delegate block ${end.id} "<why>"${end.then ?? ''}`);
  }

  /** The model an agent runs on when its harness's CLI picks one — its BUDGET tier's there; null: the harness's own default. */
  private modelOf(inv: HarnessInvocation, agent: string): string | null {
    return inv.model ? inv.models?.[agent] ?? null : null;
  }

  /**
   * A copy for a piece on another harness (D66), opened: the files its harness
   * needs carried in, its prompt written beside it — the CLI's intro, `task`,
   * then where it works — and the schema of its AS when the CLI binds one.
   * Returns the harness's command line, filled: the copy, the agent, the
   * prompt, the answer, the shape and the model its BUDGET tier maps to.
   */
  private openElsewhere(cx: ContractCx, id: string, inv: HarnessInvocation, agent: string, writes: string[], task: string[], shape: ApRef | null): string {
    cx.ws().open(id, { reads: null, writes });
    const files = this.elsewhereFiles(cx, id);
    for (const path of inv.carry.map(pattern => pattern.replace(/\{agent\}/g, agent))) {
      const from = join(cx.root, path);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(files.copy, path)), { recursive: true });
      copyFileSync(from, join(files.copy, path));
    }
    const prompt = [
      ...(inv.intro ? [inv.intro.replace(/\{agent\}/g, agent), ''] : []),
      ...task,
      '', 'Work only in this folder: it is your own copy of the project. Your last message is your answer.',
    ].join('\n');
    writeFileSync(files.prompt, `${prompt}\n`);
    const slots = shape ? this.doc.slotsOf(shape) : null;
    if (shape && inv.shape && slots) writeFileSync(files.schema, JSON.stringify(jsonSchemaOf(slots, this.doc.slotResolver()), null, 2));
    const flag = shape && inv.shape && slots ? inv.shape.replace(/\{schema\}/g, files.schema) : '';
    const model = this.modelOf(inv, agent);
    const modelFlag = model ? inv.model!.replace(/\{model\}/g, model) : '';
    return inv.command.replace(/\{project\}/g, files.copy).replace(/\{agent\}/g, agent).replace(/\{prompt\}/g, files.prompt)
      .replace(/\{answer\}/g, files.answer).replace(/\{shape\}/g, flag).replace(/\{model\}/g, modelFlag).replace(/\s{2,}/g, ' ').trim();
  }

  /** The AS of a delegation to another harness, as a reference — null when it has none, or its template was not compiled in. */
  private elsewhereShape(dlg: string): ApRef | null {
    const work = this.doc.meta.background?.[pieceOf(dlg).work];
    if (!work) return null;
    for (const { node } of this.doc.nodes()) {
      if (node.type === 'directive' && node.work === pieceOf(dlg).work && node.as) return this.doc.slotsOf(node.as.ref) ? node.as.ref : null;
    }
    return null;
  }

  /**
   * A delegation to another harness, delivered (`delegate deliver <dlg-id>
   * --answer`): its answer, from the file its command wrote, is its result —
   * stored in its INTO; what its copy changed is kept only within its
   * perimeter (every glob list the registry recorded), the files carried in
   * never — anything else is left out, and said. A WAIT merges it.
   */
  private deliverElsewhere(table: DelegationTable, record: DelegationRecord): number {
    const cx = this.contractCx();
    if (!cx) return this.lastCode;
    if (record.state !== 'running') return this.fail(1, `${record.dlg} is ${record.state} — only a running piece is delivered`);
    const text = this.elsewhereAnswer(cx, record);
    if (text === null) return this.lastCode;
    if (record.into && pieceOf(record.dlg).run === null) {
      const block = this.variable(record.into);
      const failed = block ? this.storeVariable(block, text) : null;
      if (failed) return this.fail(6, `${record.dlg} delivers into \`${record.into}\`: ${failed.reason} — run it again; nothing was stored`);
    }
    // What it changed: every file, then only those within its perimeter — a glob of each list it was handed under.
    const carried = this.carriedOf(record);
    const lists: string[][] = record.perimeter ? JSON.parse(record.perimeter) : [];
    const changed = cx.ws().deliver(record.dlg, { globs: ['**'], created: true }, { dryRun: true }).committed;
    const keep = changed.filter(file => !carried.has(file) && lists.every(globs => matchesAnyGlob(file, globs)));
    const left = changed.filter(file => !keep.includes(file) && !carried.has(file));
    cx.ws().deliver(record.dlg, { globs: keep.map(literalGlob) });
    if (!table.transition(record.dlg, 'running', 'delivered', { result: JSON.stringify(text), left_out: left.join('; '), why: left.length ? 'outside its perimeter' : '' })) {
      return this.fail(1, `${record.dlg} moved meanwhile — ${this.cmd} delegate list`);
    }
    this.out(`${record.dlg}  delivered — ${keep.length ? keep.join(', ') : 'nothing changed'}`);
    if (left.length) this.out(`left out, outside its perimeter: ${left.join(', ')}`);
    return 0;
  }

  /** A contract's copy, from the project root — where whoever carries it out works. */
  private contractCopy(ctr: string): string | null {
    return this.contractCx()?.ws().path(ctr) ?? null;
  }

  /**
   * What a WAIT does with the contracts it took back: each delivered one merged
   * into the session's result, then what was merged lands in the working
   * folder. A conflict is named, and left to the lead (`contract merge`).
   */
  private foldContracts(table: DelegationTable, pieces: DelegationRecord[]): DelegationRecord[] {
    const cx = this.contractCx();
    if (!cx) return pieces;
    const out: DelegationRecord[] = [];
    let merged = 0;
    for (const record of pieces) {
      // A contract, or a delegation to another harness: both delivered from a copy of their own.
      if (record.state !== 'delivered' || !(CONTRACT_ID_RE.test(record.dlg) || record.harness)) { out.push(record); continue; }
      const outcome = cx.ws().merge(record.dlg);
      if (!outcome.merged) { this.out(`${record.dlg}  conflicts with what is merged in ${outcome.conflicts.join(', ')} — ${this.cmd} contract merge ${record.dlg} --prefer ours|theirs`); out.push(record); continue; }
      table.transition(record.dlg, 'delivered', 'merged');
      merged++;
      out.push({ ...record, state: 'merged' });
    }
    if (merged > 0) {
      const landing = cx.ws().land();
      if ('conflicts' in landing) this.out(`# what was merged conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then ${this.cmd} contract land`);
      else if (landing.landed.length) this.out(`# landed in the working folder: ${landing.landed.join(', ')} — uncommitted, for the developer to commit`);
    }
    return out;
  }

  /** `merge <ctr> [--prefer ours|theirs]` — a delivered contract that conflicted, merged with the side that wins. */
  private contractMerge(cx: ContractCx, args: string[]): number {
    const record = this.contractArg(cx, args[0], 'merge <ctr-id> [--prefer ours|theirs]');
    if (!record) return this.lastCode;
    if (record.state !== 'delivered') return this.fail(2, `${record.dlg} is ${record.state} — only a delivered contract is merged`);
    const prefer = flagValue(args.slice(1), '--prefer');
    if (prefer !== undefined && prefer !== 'ours' && prefer !== 'theirs') return this.fail(2, `--prefer takes ours (keep what is merged) or theirs (take ${record.dlg}'s)`);
    const outcome = cx.ws().merge(record.dlg, prefer);
    if (!outcome.merged) return this.fail(3, `${record.dlg} conflicts with what is merged in ${outcome.conflicts.join(', ')} — merge again with --prefer ours (keep what is merged) or --prefer theirs (take ${record.dlg}'s)`);
    if (!cx.table.transition(record.dlg, 'delivered', 'merged')) return this.fail(4, `${record.dlg} changed meanwhile — ${this.cmd} contract get ${record.dlg}`);
    this.out(`${record.dlg}  merged`);
    if (record.left_out) this.out(`left out: ${record.left_out} — why: ${record.why}`);
    return this.print(`# then: ${this.cmd} contract land`);
  }

  /** `land` — what was merged, into the working folder, uncommitted. */
  private contractLand(cx: ContractCx): number {
    const landing = cx.ws().land();
    if ('conflicts' in landing) return this.fail(3, `what was merged conflicts with the working folder: ${landing.conflicts.join(', ')} — make them agree there, then land again`);
    return this.print(landing.landed.length ? `# landed in the working folder: ${landing.landed.join(', ')} — uncommitted, for the developer to commit` : '# nothing to land');
  }

}

/** A contract's issues on one line — null when there are none. */
function issuesText(issues: ReturnType<typeof validateRecord>): string | null {
  return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
}

/** Why a value cannot be checked: what holds it is typed with a template this agent was not compiled with. */
function notCompiled(what: string, template: string): string {
  return `\`${what}\` is shaped as \`${template}\`, a template not compiled into this agent`;
}

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
}

function letters(options: string[]): string[] {
  return options.map((_option, index) => String.fromCharCode(97 + index));
}

function matches(block: ApBlock, key: string, op: string, val: string): boolean {
  if (key === 'tag') {
    const tag = val.replace(/^#/, '');   // written `#security` in the source, stored bare
    return op === '=' ? block.tags.includes(tag) : block.tags.some(blockTag => blockTag.toLowerCase().includes(tag.toLowerCase()));
  }
  const value = key === 'kind' ? block.kind : key === 'name' ? block.name : block.about ?? '';
  return op === '=' ? value === val : value.toLowerCase().includes(val.toLowerCase());
}

/** Every reference a block's data holds — any `{ kind, target, id }` object — once per target. */
function uniqueRefs(data: unknown): ApRef[] {
  const found = new Map<string, ApRef>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.target === 'string' && typeof object.kind === 'string' && 'id' in object) {
      if (!found.has(object.target)) found.set(object.target, object as unknown as ApRef);
      return;
    }
    Object.values(object).forEach(walk);
  };
  const { args, body } = data as { args?: unknown; body?: unknown };
  walk(args);
  walk(body);
  return [...found.values()];
}
