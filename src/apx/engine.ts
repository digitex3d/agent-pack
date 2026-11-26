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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import type { ApDocument } from '../apdoc/document.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef, ApNode, ApWhenNode, ApRunNode, ApDirectiveNode } from '../apdoc/types.js';
import { KIND_STRATEGIES, type AgentBlock, type TeamBlock, type MainBlock, type VarBlock } from '../apdoc/blocks.js';
import { mdEnv, renderPreamble, renderEntry, renderMd } from '../../adapters/md/index.js';
import { renderNodes, type MdEnv } from '../../adapters/md/toolkit.js';
import { FORMULAS, fill } from '../formulas.js';
import { FLOWS_DIR, flowScriptStem, projectRootOf } from './paths.js';
import { Session, harnessSession } from './session.js';
import { CALL_TEMPLATE, callFraming } from './call.js';
import { Intro } from './intro.js';
import { Quiz } from './quiz.js';
import { ARGUMENT, DASHBOARD_EXEMPT, DATA_FLAGS, HELP_FLAGS, JSON_FLAG, isOneOf, type ApxVerb } from './verbs.js';
import { Dashboard, callTextOf, triggerTitle, type CallText } from './dashboard.js';
import type { ApDashboard, ApReminder } from '../dashboard.js';
import { triggerKeys } from '../apdoc/nodes.js';
import type { ReceivedEnvelope } from './call.js';
import { openSessionVars, type SessionVars, type CheckRecord, type ExecutorRecord } from './sessionVars.js';
import { checkedKeyword, roundLine, roundOf, stateOf, type ApCheckSpec } from '../check.js';
import { PROGRAM, WRITE_PROGRAM, executorKey, programDir, programFolders, type ApExecutorSpec } from '../executor.js';
import { resolveJudge } from '../judge/builtins.js';
import type { JudgePlugin } from '../judge/types.js';
import { refName } from '../../adapters/md/phrases.js';
import { CREDIT } from '../credits.js';
import { validateRecord, formatIssues, jsonExample } from '../shapeSchema.js';
import { BLOCK_ID_RE, addressName, sha256Hex } from '../apdoc/ids.js';
import { announceIdentity } from '../../adapters/acp/events.js';
import { listingOf, uniqueRefs } from './listing.js';
import type { DriverEntry } from '../storeDrivers/registry.js';
import { installRecorded } from './stores.js';
import { constantOf, readsOf } from '../vars.js';
import { servicesOf, serviceOf } from './services/registry.js';
import { waitFor, OLD_DELEGATE_KIND } from './services/delegate.js';
import { NODE, countOf, emptyVariable, notCompiled, reasonOf, type NamedValue } from './service.js';
import { ContractWork } from './contractWork.js';
import { globRegExp } from '../services/glob.js';

/** The exit of an UNTIL*'s answer at its round limit: the loop ends (src/check.ts roundLine). */
const ROUND_LIMIT = 7;

/** What the apx says, by area (src/config/formulas.json). */
const WORDS = FORMULAS.apx;

/** The block kinds the engine tells apart, each by its name. */
const KIND = { agent: 'agent', team: 'team', main: 'main', flow: 'flow', template: 'template', policy: 'policy', variable: 'var' } as const;

/** Where an executor's contract was written (`ApExecutorSpec.site`). */
const SITE = { procedure: 'procedure' } as const;

/** What a `check` answers on its first line. */
const OUTCOME = { open: 'open', closed: 'closed' } as const;


/** The fields `ls` filters on. */
const FILTER_KEY = { kind: 'kind', tag: 'tag', name: 'name', about: 'about' } as const;

/** Build provenance sealed next to the document. */
export interface ApxBuild {
  builtAt: string;
  agentPackVersion: string;
  hash: string;
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

/** Whether some of `globs` admits every file `glob` does — by its folders before the first wildcard (`src/actors/**` under `src/**`). */
function coversGlob(globs: string[], glob: string): boolean {
  const prefix = glob.split('/').filter((part, index, all) => !/[*?[{]/.test(part) && all.slice(0, index).every(previous => !/[*?[{]/.test(previous))).join('/');
  return globs.some(candidate => globRegExp(candidate).test(glob) || (prefix !== '' && globRegExp(candidate).test(`${prefix}/x`)));
}

const FILTER_RE = /^(kind|tag|name|about)(=|~)(.+)$/;

/** A program's manifest (`distilled/<dst-id>/manifest.json`) — written by the agent, `tested` by the apx. */
interface ProgramManifest {
  version: number;
  previous?: string;
  lineage?: string;
  timeout_ms: number;
  /** A hash of the script and its tests the last time all its tests passed. */
  tested?: string;
}




/** What `check` answers on its first line. */
type Outcome = typeof OUTCOME[keyof typeof OUTCOME];

/** A program's files: its folder, its manifest and its script. */
interface ProgramFiles { directory: string; manifest: ProgramManifest; script: string }

/** One case of a program's `tests.json`: an input and its expected output, or the refusal it must give. */
type ProgramTest = { why: string; input: unknown } & ({ output: unknown } | { exit: number });

/** How a program run on one input ended: its stdout, a refusal (exit ≠ 0), a timeout, or a failure to start. */
type ProgramRun = { out: string } | { refused: string } | { timeout: true } | { error: string };

/** Two JSON texts or values that mean the same value, key order aside. */
function sameJson(text: string, expected: unknown): boolean {
  const canon = (value: unknown): unknown => Array.isArray(value) ? value.map(canon)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as object).sort(([leftKey], [rightKey]) => leftKey < rightKey ? -1 : 1).map(([key, child]) => [key, canon(child)])) : value;
  try { return JSON.stringify(canon(JSON.parse(text))) === JSON.stringify(canon(expected)); } catch { return false; }
}

/** Why a program's run fails one of its tests — null when it passes. */
function testFailure(test: ProgramTest, ran: ProgramRun): string | null {
  if ('exit' in test) return 'refused' in ran ? null : `it should refuse (exit ${test.exit})`;
  if ('out' in ran) return sameJson(ran.out, test.output) ? null : `it answered ${ran.out.trim()}`;
  return `it gave no answer (${'refused' in ran ? ran.refused : 'timeout' in ran ? 'timeout' : ran.error})`;
}

/** Why a script failed, from its stderr: the last lines that say something — stack frames, carets and runtime banners left out. */
function stderrCause(stderr: string): string {
  return stderr.split(/\r?\n/)
    .filter(line => line.trim() && !/^\s+at\s/.test(line) && !/^\s*\^+\s*$/.test(line) && !/^Node\.js v\d/.test(line))
    .slice(-3)
    .map(line => line.trim())
    .join(' | ');
}
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
    start: args => { this.announce(); return this.start(args); },
    scope: () => { this.announce(); return this.scope(); },
    ls: args => this.ls(args),
    get: args => this.get(args),
    set: args => this.set(args),
    refs: args => this.refs(args),
    find: args => this.find(args),
    md: () => this.print(renderMd(this.doc)),
    flow: args => this.flow(args),
    run: args => this.runProgram(args),
    check: args => this.check(args),
    contract: args => this.contracts.serve(args),
    wait: args => waitFor(this, args),
    guard: args => this.contracts.guard(args),
    version: () => this.version(),
    help: () => this.help(),
  };

  /** The contracts: their verbs, the guard, and their own steps for the `delegate` service and `wait` (src/apx/contractWork.ts). */
  readonly contracts: ContractWork = new ContractWork(this);

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
    this.agent = this.root.kind === KIND.agent ? (this.root as AgentBlock) : null;
    for (const block of doc.all()) this.byId.set(block.id, block);
  }

  /** Whether the config's store drivers were installed in this run. */
  private driversInstalled = false;

  /**
   * Whether this call's answer goes without the dashboard. Read from the verb
   * table and the data flags (verbs.ts) as the call is dispatched; set where
   * the answer prints in the two cases only the printing knows: the quiz
   * `start` asks, a variable's value.
   */
  private exempt = false;

  /** Whether this call is a `start`: the agent reads its definition again, so no block counts as shown lately. */
  private restarted = false;

  /** What this call's answer printed whole — block ids, and the keys of the triggers it printed alone: its dashboard never offers them again. */
  private readonly printed = new Set<string>();

  /** Dispatch one invocation: a verb of the engine, or a served kind and its operation (`<kind> <op> [<id>] …`). No verb = start. `check` answers asynchronously. */
  run(argv: string[]): number | Promise<number> {
    // The config's own store drivers are installed before anything renders: a store they keep reads as usable in `get` and `md` too.
    if (this.build.drivers?.length && !this.driversInstalled) {
      this.driversInstalled = true;
      return installRecorded(this).then(() => this.run(argv));
    }
    const [verb = 'start', ...args] = argv;
    this.exempt = isOneOf(DASHBOARD_EXEMPT, verb) || args.some(arg => DATA_FLAGS.includes(arg));
    if (isOneOf(HELP_FLAGS, verb)) return this.help();
    if (Object.hasOwn(this.verbs, verb)) return this.verbs[verb as ApxVerb](args);
    const service = serviceOf(verb, this.doc);
    if (service) return service.serve(this, args[0], args.slice(1));
    if (verb === OLD_DELEGATE_KIND) return this.fail(2, this.phrase(WORDS.dispatch.renamed, { verb, args: args.join(' ') }).trimEnd());
    return this.refuse(2, WORDS.dispatch.unknownVerb, { verb });
  }

  /**
   * After the answer, the dashboard: the blocks the agent is likeliest to
   * forget for its next step — when the call carries an envelope and the
   * document was compiled with a dashboard. The session counts the call
   * (`start` clears what was shown), the dashboard prints unless the command
   * is exempt, and the session records the blocks it showed. Their keys, in
   * the order printed — none when it showed nothing.
   */
  remind(envelope: ReceivedEnvelope | null): string[] {
    const compiled = this.doc.meta.dashboard;
    const call = callTextOf(envelope);
    // A `start` clears what was shown, envelope or not: the agent reads its definition again.
    if (!compiled || (!call && !this.restarted)) return [];
    try {
      return this.reminded(compiled, call);
    } catch {
      // The dashboard never fails a call: one it cannot compute — an index it cannot read — is not shown.
      return [];
    }
  }

  /** The session's part, then the dashboard's: what `remind` shows, and records. */
  private reminded(compiled: ApDashboard, call: CallText | null): string[] {
    const session = Session.open(this.projectRoot, this.doc.meta.sessionEnv, this.root.name);
    if (this.restarted) session.clear();
    if (call === null) {
      session.showed([], compiled.settings.recall);
      return [];
    }
    session.count();
    const reminded = this.exempt ? null : Dashboard.of(compiled, id => this.byId.get(id), this.cmd, this.printed).show(call, key => session.ago(key));
    for (const line of reminded?.lines ?? []) this.out(line);
    const shown = reminded?.shown ?? [];
    session.showed(shown, compiled.settings.recall);
    return shown;
  }

  // ------------------------------------------------------------------ verbs

  /** Who this apx is, told to the chat it runs in, if any — what `start` and `scope` serve. */
  private announce(): void {
    announceIdentity(this.root.name, (this.root as ApBlock).kind);
  }

  private start(args: string[]): number {
    this.restarted = true;
    this.out(this.root.heading);
    const whole = renderMd(this.doc);
    if (whole.length <= this.budget.whole) {
      for (const block of this.doc.all()) this.printed.add(block.id);
      this.say(WORDS.start.whole);
      return this.introduceCall(this.print(whole));
    }
    const quiz = this.quiz();
    if (quiz.size === 0) return this.introduceCall(this.opening());
    if (args.length === 0) {
      // The answers come with the next call: the dashboard follows them, never the questions.
      this.exempt = true;
      for (const line of quiz.asked()) this.out(line);
      return 0;
    }
    const given = quiz.answers(args);
    if ('bad' in given) return this.refuse(2, WORDS.start.badAnswer, { arg: given.bad, count: quiz.size });
    const graded = quiz.graded(given);
    this.out(graded.line);
    for (const intro of graded.missed) this.print(intro.printed);
    return this.opening();
  }

  /** The scope, then the agent's definition with every block it always needs or that costs less than a `get`. */
  private opening(): number {
    this.scope();
    const opened = this.opened();
    this.say(WORDS.start.opened);
    this.print(this.text(this.root));
    for (const block of opened) this.print(`\n${this.text(block)}`);
    for (const block of [this.root, ...opened]) this.printed.add(block.id);
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
      if (block.kind === KIND.template) for (const reference of uniqueRefs(block.toJSON())) add(this.doc.resolve(reference));
    };
    for (const role of this.agent?.roles ?? []) add(this.doc.resolve(role));
    this.doc.byKind('policy').forEach(add);
    if (this.root.lensIn) add(this.doc.resolve(this.root.lensIn.ref));
    if (this.agent?.lensOut) add(this.doc.resolve(this.agent.lensOut.ref));
    // A variable is runtime state, served by `get <name>` — never opened.
    return this.doc.all().filter(block => block !== this.root && block.kind !== KIND.variable && (always.has(block) || this.text(block).length <= this.budget.block));
  }

  private scope(): number {
    const root = this.root;
    this.out(root.heading);
    this.out(`you:  ${this.label(root)}  — your definition, complete`);
    if (this.agent?.mandate) this.out(`mandate: ${this.agent.mandate}`);
    this.scopePerimeter();
    const roles = (this.agent?.roles ?? []).map(reference => this.doc.resolve(reference)).filter((block): block is ApBlock => block !== null);
    for (const role of roles) this.out(`role: ${role.inScope(this.cmd)}`);
    // Its team, by reference: the team's block — its members, its routing — is the team's own document's.
    if (this.agent?.team) this.out(`team: ${this.refLabel(this.agent.team)}`);
    const policies = this.doc.byKind('policy');
    if (policies.length > 0) {
      this.out('respect:');
      for (const policy of policies) this.out(`  ${policy.inScope(this.cmd)}`);
    }
    this.scopeBehaviour([root, ...roles]);
    this.out('write to:');
    const stores = this.doc.agentStores();
    if (stores.length === 0) this.say(WORDS.scope.noStores);
    for (const store of stores) this.out(`  ${store.inScope(this.cmd)}`);
    const dimensions = this.doc.byKind('dimension');
    if (dimensions.length > 0) {
      this.say(WORDS.scope.dimensions);
      for (const dimension of dimensions) this.out(`  ${dimension.inScope(this.cmd)}`);
    }
    const variables = this.doc.byKind('var');
    if (variables.length > 0) {
      this.out(`variables:  — read: ${this.cmd} get <name>, store: ${this.cmd} set <name> -`);
      for (const variable of variables) this.out(`  ${variable.inScope(this.cmd)}`);
    }
    this.scopeJudgedAndDelegated();
    if (root.lensIn) this.say(WORDS.scope.requests, { shape: this.refLabel(root.lensIn.ref) });
    if (this.agent?.lensOut) this.say(WORDS.scope.answer, { shape: this.refLabel(this.agent.lensOut.ref) });
    const counts = this.groups(this.doc.all()).map(([kind, blocks]) => `${blocks.length} ${kind}`);
    this.out(`contains: ${counts.join(', ')}  — list them: ${this.cmd} ls`);
    return 0;
  }

  /** What the agent may write and read, and the files a judge could not place. */
  private scopePerimeter(): void {
    const perimeter = this.doc.perimeter();
    if (!perimeter) return;
    this.say(WORDS.scope.perimeter, {
      writes: perimeter.writes.join(', ') || WORDS.scope.writesNothing,
      reads: perimeter.reads ? fill(WORDS.scope.readsOnly, { globs: perimeter.reads.join(', ') }) : WORDS.scope.readsAnything,
    });
    const uncertain = { ...perimeter.judged?.reads.uncertain, ...perimeter.judged?.writes.uncertain };
    const entries = Object.entries(uncertain).map(([file, probability]) => fill(WORDS.scope.uncertainEntry, { file, probability: probability.toFixed(2) }));
    if (entries.length) this.say(WORDS.scope.uncertain, { entries: entries.join(', ') });
  }

  /** Every WHEN and hook of the agent and of its roles — what it does, and when — and what it must remember. */
  private scopeBehaviour(blocks: ApBlock[]): void {
    const own = blocks.flatMap(block => block.toJSON().body as ApNode[]);
    const whens = own.filter((node): node is ApWhenNode => node.type === NODE.when);
    if (whens.length > 0) {
      this.out(`when:  — the steps: ${this.root.opening(this.cmd)}`);
      for (const when of whens) {
        const runs = when.body.filter((child): child is ApRunNode => child.type === NODE.run).map(run => this.refLabel(run.ref));
        this.out(`  WHEN ${when.condition}${runs.length ? `  -> ${runs.join(', ')}` : ''}${when.shape ? `  — as ${this.refLabel(when.shape.ref)}` : ''}`);
      }
    }
    const memories = own.filter((node): node is ApDirectiveNode => node.type === NODE.directive && node.keyword === 'MEM' && (node.force ?? 0) >= 0);
    if (memories.length > 0) {
      this.out('remember:');
      for (const memory of memories) this.out(`  ${memory.text}${memory.shape ? `  — as ${this.refLabel(memory.shape.ref)}` : ''}`);
    }
  }

  /** The checked conditions a judge decides, and the delegates and programs that carry out the agent's contracts. */
  private scopeJudgedAndDelegated(): void {
    const checks = Object.entries(this.doc.meta.checks ?? {});
    if (checks.length > 0) {
      this.say(WORDS.scope.checks);
      for (const [id, check] of checks) this.out(`  ${id}  ${checkedKeyword(check.kind, check.level)}${check.level === 2 ? '  (sealed)' : `  — the question: ${this.cmd} get ${id}`}`);
    }
    const executors = Object.entries(this.doc.meta.executors ?? {});
    if (executors.length > 0) {
      this.say(WORDS.scope.executors);
      for (const [id, executor] of executors) {
        const state = executor.program ? (this.programFiles(executor.program) ? '  (program ready)' : '  (no program yet)') : '';
        this.out(`  ${id}  ${FORMULAS.keywords.EXECUTOR.who[executorKey(executor.executor)]}${executor.by ? ` \`${executor.by}\`` : ''}  ${executor.site}: ${executor.text}${state}`);
      }
    }
  }

  private ls(args: string[]): number {
    const terms: FilterTerm[] = [];
    let count = false;
    let json = false;
    for (const arg of args) {
      if (arg === ARGUMENT.count) { count = true; continue; }
      if (arg === JSON_FLAG) { json = true; continue; }
      const match = FILTER_RE.exec(arg);
      if (!match) return this.refuse(2, WORDS.ls.badFilter, { arg });
      terms.push({ key: match[1] as FilterKey, operator: match[2], value: match[3] });
    }
    const hits = this.doc.all().filter(block => terms.every(term => matches(block, term)));
    // One model, two renderings: the listing as JSON (the chat's launcher reads it), or as lines.
    if (json) return this.print(JSON.stringify(listingOf([{ doc: this.doc, holder: this.inUnit ?? '' }], null)));
    for (const [kind, blocks] of this.groups(hits)) {
      this.out(`${kind} (${blocks.length})`);
      if (!count) for (const block of blocks) this.out(`  ${block.listed()}`);
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
    const trigger = args[0] ? this.doc.meta.dashboard?.reminders.find(reminder => reminder.key === args[0] && reminder.when !== undefined) : undefined;
    if (trigger) return this.getTrigger(trigger);
    const block = this.blockArg('get', args);
    if (!block) return this.lastCode;
    this.printed.add(block.id);
    if (args[1] === ARGUMENT.json) return this.print(JSON.stringify(block.toJSON(), null, 1));
    this.print(this.text(block));
    this.out(`# ${block.title}  ${block.id}  ${block.chars}ch${block.tagged}`);
    this.links(block);
    return 0;
  }

  /** `get <whn-…>`: one trigger alone — its condition and its body, as its block holds it — then the block it is written in. */
  private getTrigger(trigger: ApReminder): number {
    const holder = this.byId.get(trigger.block);
    const node = holder ? triggerKeys(holder).get(trigger.key) : undefined;
    if (!holder || !node) return this.notFound(trigger.key);
    this.printed.add(trigger.key);
    this.print(renderNodes(this.env, [node]).join('\n'));
    this.say(WORDS.dashboard.triggerFooter, { title: triggerTitle(node.condition), key: trigger.key, holder: holder.cited(this.cmd) });
    return 0;
  }

  private refs(args: string[]): number {
    const block = this.blockArg('refs', args);
    if (!block) return this.lastCode;
    this.links(block);
    return 0;
  }

  private find(args: string[]): number {
    if (args.length === 0) return this.refuse(2, WORDS.find.needsText);
    const needle = args.join(' ').toLowerCase();
    let matched = 0;
    for (const block of this.doc.all()) {
      const lines = this.text(block).split('\n').filter(line => line.toLowerCase().includes(needle));
      if (lines.length === 0) continue;
      matched++;
      this.out(block.listed());
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
    if (block.kind !== KIND.flow) return this.refuse(2, WORDS.flow.notFlow, { id: block.id, kind: block.kind });
    const script = this.flowScript(block);
    const run = this.doc.meta.flowRun;
    if (script && run) return this.print(fill(run, { script, steps: `${this.cmd} get ${block.id}` }));
    this.say(WORDS.flow.steps, { name: block.name });
    return this.print(this.text(block));
  }

  /** A contract of this agent by id, or null after telling where its contracts are. */
  executorArg(verb: string, id: string | undefined): ApExecutorSpec | null {
    const spec = id ? this.doc.meta.executors?.[id] : undefined;
    if (!spec) this.lastCode = this.refuse(2, WORDS.executor.needsId, { verb });
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
      const variables = this.sessionVars();
      if (!variables) return null;
      const read = this.readVariables(variables, spec.input.vars);
      if ('empty' in read) {
        this.lastCode = this.refuse(1, WORDS.executor.unfilled, { empty: emptyVariable(read.empty) });
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
    const flagAt = args.indexOf('--into');
    if (flagAt < 0) return { spec, args };
    const name = args[flagAt + 1];
    const rest = [...args.slice(0, flagAt), ...args.slice(flagAt + 2)];
    if (spec.site !== SITE.procedure) {
      const stored = spec.output.into ? fill(WORDS.executor.intoStored, { into: spec.output.into }) : '';
      this.lastCode = this.refuse(2, WORDS.executor.intoNotProcedure, { id, site: spec.site, stored });
      return null;
    }
    if (!name || !this.variable(name)) {
      this.lastCode = this.refuse(2, WORDS.executor.intoNeedsVariable, { none: name ? fill(WORDS.executor.intoNone, { name }) : '' });
      return null;
    }
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
      this.say(WORDS.executor.stored, { into: spec.output.into });
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
  private programFiles(program: string): ProgramFiles | null {
    const directory = resolve(projectRootOf(this.exe), programDir(program));
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    const script = readdirSync(directory).find(file => /^script(\.|$)/.test(file));
    if (!script) return null;
    let manifest: ProgramManifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { return null; }
    return { directory, manifest, script: join(directory, script) };
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
  private execute(script: string, input: string, timeout: number): ProgramRun {
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
    const withInto = found && this.intoArg(found, id, argv);
    if (!withInto) return this.lastCode;
    const { spec } = withInto;
    const inputArgument = withInto.args[1];
    if (spec.executor !== 2 || !spec.program) return this.refuse(1, WORDS.program.notProgram, { id });
    const files = this.programFiles(spec.program);
    if (!files) return this.noProgramYet(id, spec, spec.program);
    const { manifest, script } = files;
    const folder = programDir(spec.program);
    if (!(manifest.timeout_ms > 0)) return this.refuse(6, WORDS.program.noTimeout, { folder });
    const unproven = this.proveProgram(id, folder, files);
    if (unproven !== null) return unproven;
    let extra: Record<string, unknown> = {};
    if (spec.input.in) {
      if (!inputArgument) return this.refuse(2, WORDS.program.needsInput, { id, shape: spec.input.in });
      try { extra = { in: JSON.parse(inputArgument) }; } catch { return this.refuse(2, WORDS.program.inputNotJson, { id }); }
    }
    const input = this.inputJson(spec, extra);
    if (!input) return this.lastCode;
    const json = JSON.stringify(input);
    const fingerprint = sha256Hex(json);
    const recordOutcome = (outcome: ExecutorRecord['outcome']) => this.recordExecution(id, spec, fingerprint, outcome);
    const ran = this.execute(script, json, manifest.timeout_ms);
    if ('timeout' in ran) { recordOutcome('timeout'); return this.refuse(4, WORDS.program.timedOut, { id, timeout: manifest.timeout_ms }); }
    if ('error' in ran) return this.fail(6, ran.error);
    if ('refused' in ran) { recordOutcome('refused'); return this.refuse(3, WORDS.program.refused, { id, reason: ran.refused }); }
    const broken = this.deliver(id, spec, ran.out, 'ran', fingerprint);
    if (broken) { recordOutcome('broken'); return this.refuse(6, WORDS.program.broken, { id, broken }); }
    return this.delivered(id, spec, ran.out);
  }

  /** What a contract with no program yet tells the agent: write it, where, and where the version before it is. */
  private noProgramYet(id: string, spec: ApExecutorSpec, program: string): number {
    const again = `${this.cmd} run ${id}${spec.output.into && spec.site === SITE.procedure ? ` --into ${spec.output.into}` : ''}`;
    const previous = this.previousProgram(spec);
    const writer = this.doc.byKind('procedure').find(block => block.name === WRITE_PROGRAM);
    return this.fail(10, [
      `no program yet for ${id} — write it now, in ${programDir(program)}/ at the project root (beside .agent-pack/): manifest.json, the script, tests.json`,
      writer ? `how: ${writer.opening(this.cmd)}` : `its contract: ${this.cmd} get ${id}`,
      `manifest.json: {"version": 1, "timeout_ms": <n>${spec.lineage ? `, "lineage": "${spec.lineage}"` : ''}} — the script: script.<ext>, executable, JSON in on stdin, JSON out on stdout, exit 1 with the reason on stderr to refuse`,
      `tests.json: [{"why": "…", "input": {…}, "output": <the JSON it must answer>}, {"why": "…", "input": {…}, "exit": 1}] — a "why" starting with CHOICE: for each decision the block left open`,
      ...(previous ? [`its previous version is ${programDir(previous)}/ — start from it: version + 1, "previous": "${previous}", then delete that folder`] : []),
      `then run it again: ${again}`,
    ].join('\n'));
  }

  /**
   * A new or changed program proves itself on its own tests first: the exit
   * that refuses it — or null when it passes, or had passed already.
   */
  private proveProgram(id: string, folder: string, { directory, manifest, script }: ProgramFiles): number | null {
    const testsPath = join(directory, 'tests.json');
    const proof = sha256Hex(readFileSync(script, 'utf-8') + (existsSync(testsPath) ? readFileSync(testsPath, 'utf-8') : ''));
    if (manifest.tested === proof) return null;
    let tests: ProgramTest[];
    try { tests = JSON.parse(readFileSync(testsPath, 'utf-8')); } catch { return this.refuse(6, WORDS.program.testsMissing, { folder }); }
    if (!Array.isArray(tests) || tests.length === 0) return this.refuse(6, WORDS.program.testsEmpty, { folder });
    for (const test of tests) {
      const ran = this.execute(script, JSON.stringify(test.input), manifest.timeout_ms);
      // Too slow is no wrong answer: the timeout or the speed is to fix, not the logic.
      if ('timeout' in ran) return this.refuse(6, WORDS.program.testTimeout, { id, why: test.why, timeout: manifest.timeout_ms, folder });
      const failure = testFailure(test, ran);
      if (failure) return this.refuse(6, WORDS.program.testFailed, { id, why: test.why, failure });
    }
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify({ ...manifest, tested: proof }, null, 2)}\n`);
    return null;
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
    const answer = (outcome: Outcome, ...lines: string[]): void => { this.out(outcome); lines.forEach(line => this.out(line)); };
    const refused = (message: string): number => { answer(OUTCOME.closed, `# error: ${message}`); return 2; };
    const [id] = args;
    if (!id) return refused(this.phrase(WORDS.check.needsId));
    const spec = this.doc.meta.checks?.[id];
    if (!spec) return refused(this.phrase(WORDS.check.unknown, { id }));
    const config = this.build.checks;
    if (!config) return refused(WORDS.check.noJudge);
    const session = this.openSession();
    if (typeof session === 'string') return refused(fill(WORDS.check.gateStaysClosed, { reason: session }));
    let judge: JudgePlugin;
    try { judge = this.judgeNamed(config.adapter); } catch (error) { return refused(fill(WORDS.check.judgeNotLoaded, { adapter: config.adapter, reason: reasonOf(error) })); }
    try {
      const verdict = await this.verdict(spec, id, session, judge, config.model);
      const prior = spec.kind === 'UNTIL' ? session.checks(id) : [];
      // This answer's round, counted as closed: it is recorded before the verdict is known.
      const round = roundOf([...prior.map(earlier => earlier.outcome === OUTCOME.open), false], spec.kind === 'UNTIL' ? spec.rounds : undefined);
      session.record({ ...verdict.record, cnd: id, level: spec.level, round, threshold: config.threshold, at: new Date().toISOString() });
      if (verdict.open) { answer(OUTCOME.open, verdict.why); return 0; }
      const rounds = spec.kind !== 'UNTIL' || !spec.rounds ? []
        : [roundLine(round, spec.rounds, FORMULAS.keywords.CHECK.loop)];
      answer(OUTCOME.closed, verdict.why, ...rounds);
      return 1;
    } catch (error) {
      return refused(fill(WORDS.check.failed, { reason: reasonOf(error) }));
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
      ({ open: false, why: sealed ? fill(WORDS.check.gateStayedClosed, { gate }) : plain, record: { fingerprint: '', model: '', p: '', ...record, outcome: OUTCOME.closed } });
    const read = this.readVariables(session, spec.vars);
    if ('empty' in read) return closed(fill(WORDS.check.empty, { empty: emptyVariable(read.empty) }), WORDS.check.emptyGate);
    const state = stateOf(read.values);
    const fingerprint = sha256Hex(state);
    const limit = judge.maxStateChars;
    if (limit !== undefined && state.length > limit) {
      return closed(fill(WORDS.check.tooLarge, { length: state.length, limit }), WORDS.check.tooLargeGate, { fingerprint });
    }
    let answered: Awaited<ReturnType<JudgePlugin['ask']>>;
    try {
      answered = await judge.ask(state, [{ id, question: spec.question }], model);
    } catch (error) {
      const couldNotAnswer = fill(WORDS.check.noAnswer, { why: reasonOf(error).split(spec.question).join('…') });
      return closed(couldNotAnswer, couldNotAnswer, { fingerprint });
    }
    const probability = answered.answers[id];
    if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) return closed(WORDS.check.noProbability, WORDS.check.noProbability, { fingerprint, model: answered.model });
    const record = { fingerprint, model: answered.model, p: String(probability) };
    if (probability >= threshold) {
      return { open: true, why: sealed ? fill(WORDS.check.gateOpened, { probability }) : fill(WORDS.check.holds, { probability, threshold }), record: { ...record, outcome: OUTCOME.open } };
    }
    return closed(fill(WORDS.check.doesNotHold, { probability, threshold }), fill(WORDS.check.belowGate, { probability, threshold }), record);
  }

  /** A delegate's or a program's contract: what it carries out, what it receives, what it answers. */
  private getExecutor(id: string, spec: ApExecutorSpec): number {
    this.say(WORDS.executor.describe, { site: spec.site, id, who: FORMULAS.keywords.EXECUTOR.who[executorKey(spec.executor)], by: spec.by ? ` \`${spec.by}\`` : '' });
    this.out(`${spec.site}: ${spec.text}`);
    const keys = [...spec.input.vars.map(name => `${name} (as stored in this session)`), ...Object.entries(spec.input.constants).map(([key, value]) => `${key} = ${value}`), ...(spec.input.in ? [`in (shaped as ${spec.input.in})`] : [])];
    this.say(WORDS.executor.input, { keys: keys.length ? keys.join(', ') : 'nothing' });
    const output = spec.output.holds ? '{"holds": true | false}'
      : spec.output.into ? `the value of \`${spec.output.into}\`${spec.output.template ? `, shaped as ${spec.output.template}` : ''}`
      : spec.output.template ? `shaped as ${spec.output.template}` : 'its result';
    this.out(`output: ${output}`);
    return 0;
  }

  /** `get <cnd-id>`: a checked condition — its question, unless it is sealed. */
  private getCheck(id: string, spec: ApCheckSpec): number {
    this.say(WORDS.check.heading, { id, keyword: checkedKeyword(spec.kind, spec.level) });
    if (spec.level === 2) {
      this.say(WORDS.check.sealed);
      return 0;
    }
    this.out(`question: ${spec.question}`);
    this.say(WORDS.check.state, { variables: spec.vars.join(', ') });
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
    if (this.intros([CALL_TEMPLATE]).length > 0) this.out(callFraming(this.cmd));
    return 0;
  }

  /** The introductions of `names` this document gives — a block kind's, and how to call this apx. */
  private intros(names: readonly string[]): Intro[] {
    return Intro.of(this.doc, names, this.cmd);
  }

  /** After a start that asked no question on it and ended well, how to call this apx. Its exit, as given. */
  private introduceCall(code: number): number {
    if (code === 0) for (const intro of this.intros([CALL_TEMPLATE])) this.print(intro.printed);
    return code;
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
    if (block.kind === KIND.team || block.kind === KIND.main) return this.teamView(block as TeamBlock | MainBlock);
    return renderEntry(block, 1, this.env);
  }

  /** A unit — a team, or the main: members with the command that reaches each, the main's teams, routing, a team's shared block. */
  private teamView(team: TeamBlock | MainBlock): string {
    const section = (title: string, rows: string[]): string[] => (rows.length > 0 ? [`${title}:`, ...rows.map(row => `  ${row}`)] : []);
    const memberRow = (memberRef: ApRef): string => {
      const label = this.refLabel(memberRef);
      return this.doc.reach(memberRef)?.described(label) ?? label;
    };
    return `${[
      team.heading,
      ...section('members', team.members.map(memberRow)),
      ...section('teams', team.kind === KIND.main ? team.teams.map(teamRef => this.refLabel(teamRef)) : []),
      ...section('routing', renderNodes(this.env, team.body)),
      ...(team.kind === KIND.team && team.shared ? [`shared: ${team.shared}`] : []),
    ].join('\n')}\n`;
  }

  /** `uses:` and `used by:` of a block, each with its command. */
  private links(block: ApBlock): void {
    // Every policy in the document binds the agent — imported, not referenced by a line.
    const policies = block === this.root ? this.doc.byKind('policy') : [];
    const uses = [...uniqueRefs(block.toJSON()).map(reference => this.refLabel(reference)), ...policies.map(policy => this.label(policy))];
    this.out('uses:');
    if (uses.length === 0) this.out('  (nothing)');
    for (const use of uses) this.out(`  ${use}`);
    this.out('used by:');
    const users = this.doc.all().filter(candidate => candidate !== block && (
      uniqueRefs(candidate.toJSON()).some(reference => reference.target === block.address) || (block.kind === KIND.policy && candidate === this.root)));
    if (users.length === 0) this.say(WORDS.lookup.nothingInside);
    for (const user of users) this.out(`  ${this.label(user)}`);
  }

  // ---------------------------------------------------------------- helpers

  /** `kind name  [command]` — how a block reads in the engine's views. */
  private label(block: ApBlock): string {
    return block.cited(this.cmd);
  }

  /** A reference as a label: here → its block; a fellow agent → its own executable; a team → its apx, whose start prints its routing and flows. */
  private refLabel(reference: ApRef): string {
    const block = this.doc.resolve(reference);
    if (block) return this.label(block);
    const name = refName(reference);
    if (reference.kind === KIND.agent) return `agent ${name}  [${this.sibling(name)} scope]`;
    if (reference.kind === KIND.team) return `team ${name}  [${this.sibling(name)} start]`;
    return `${reference.kind} ${name}  (missing from the compiled sources)`;
  }

  /** How to run a fellow agent: through the same unit, or its executable beside this one, in the same form — an apx by Node, a binary as it is. */
  private sibling(name: string): string {
    if (this.inUnit !== null) return `${runCommand(this.exe)} ${name}`;
    return runCommand(join(dirname(this.exe), isApx(this.exe) ? `${name}.apx` : name));
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
    const directory = resolve(projectRootOf(this.exe), folder);
    if (!existsSync(directory)) return null;
    const file = readdirSync(directory).find(match);
    return file ? join(directory, file) : null;
  }

  /** The quiz: the questions on the kinds the agent still reads on demand, in reading order — an opened block needs no quiz — then on calling this apx. */
  private quiz(): Quiz {
    const opened = new Set(this.opened());
    const pending = this.doc.all().filter(block => block !== this.root && !opened.has(block));
    if (pending.length === 0) return new Quiz([], this.cmd);
    const kinds = this.groups([this.root, ...pending]).map(([kind]) => kind);
    return new Quiz(this.intros([...kinds, CALL_TEMPLATE]), this.cmd);
  }

  /** The block named by a verb's id argument, or null after printing the error. */
  lastCode = 0;
  private blockArg(verb: string, args: string[]): ApBlock | null {
    const id = args[0];
    if (!id) {
      this.lastCode = this.refuse(2, WORDS.lookup.needsId, { verb, id: this.root.id });
      return null;
    }
    const block = this.byId.get(id);
    if (block) return block;
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    const fellow = team?.members.find(member => member.id === id && !this.doc.resolve(member));
    this.lastCode = fellow
      ? this.refuse(1, WORDS.lookup.fellow, { id, sibling: this.sibling(addressName(fellow.target)) })
      : this.notFound(id);
    return null;
  }

  /** Neither a block nor a variable answers to this name. */
  private notFound(name: string): number {
    return this.refuse(1, WORDS.lookup.notFound, { name });
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

  /** A formula filled with `values` and the command prefix every printed command starts with. */
  phrase(formula: string, values: Record<string, string | number> = {}): string {
    return fill(formula, { cmd: this.cmd, ...values });
  }

  /** Print a formula, filled. */
  say(formula: string, values: Record<string, string | number> = {}): void {
    this.out(this.phrase(formula, values));
  }

  /** Fail with a formula, filled — its exit code is returned. */
  refuse(code: number, formula: string, values: Record<string, string | number> = {}): number {
    return this.fail(code, this.phrase(formula, values));
  }

  // -------------------------------------------------------------- variables

  /**
   * `get <name>`: a constant's value, or a variable (private or SESSION) — its definition,
   * who stores it and who reads it, then its value in this session (or that it
   * is still empty). The value is printed last, as stored, byte for byte.
   */
  private getVariable(name: string): number {
    // A variable's view ends with its value, data a program may read: the dashboard never follows it.
    this.exempt = true;
    const constant = constantOf(this.doc.mdSource?.vars, name);
    if (constant !== undefined) {
      this.say(WORDS.variables.constant, { name, value: constant });
      return 0;
    }
    const block = this.variable(name);
    if (!block) return this.notFound(name);
    const variables = this.sessionVars();
    if (!variables) return this.lastCode;
    let stored: string | null;
    try { stored = variables.read(name, block.scope); } catch (error) { return this.fail(2, `reading ${name}: ${reasonOf(error)}`); }
    this.print(this.text(block));
    this.out(`# ${block.title}  ${block.id}`);
    this.links(block);
    this.out('read by:');
    const readers = this.doc.all().filter(candidate => readsOf(JSON.stringify(candidate.body)).some(read => read.name === name && !read.field));
    if (readers.length === 0) this.say(WORDS.lookup.nothingInside);
    for (const reader of readers) this.out(`  ${this.label(reader)}`);
    if (stored === null) {
      this.say(WORDS.variables.valueEmpty);
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
      return this.refuse(2, WORDS.variables.setNeeds);
    }
    if (constantOf(this.doc.mdSource?.vars, name) !== undefined) {
      return this.refuse(1, WORDS.variables.setConstant, { name });
    }
    const block = this.variable(name);
    if (!block) return this.refuse(1, WORDS.variables.setUnknown, { name });
    const value = rest.length === 1 && rest[0] === '-' ? readFileSync(0, 'utf-8') : rest.join(' ');
    const failed = this.storeVariable(block, value);
    if (failed) {
      // A typed value refused: the shape it takes, spelled out, so the next try is the right one.
      const slots = block.type ? this.doc.slotsOf(block.type) : null;
      if (slots && failed.code === 2) this.out(`# the JSON \`${refName(block.type!)}\` takes: ${JSON.stringify(jsonExample(slots, this.doc.slotResolver()))}`);
      return this.refuse(failed.code, WORDS.variables.setRefused, { reason: failed.reason });
    }
    this.say(WORDS.variables.setDone, { name });
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
    try { session.write(block.name, block.scope, { value, type, by: this.root.name }); } catch (error) { return { code: 2, reason: `storing ${block.name}: ${reasonOf(error)}` }; }
    return null;
  }

  /** The values this session stores for `names`, in order — or the first one that is empty. */
  readVariables(session: SessionVars, names: string[]): { values: NamedValue[] } | { empty: string } {
    const values: NamedValue[] = [];
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
  sessionVars(): SessionVars | null {
    const session = this.openSession();
    if (typeof session !== 'string') return session;
    this.lastCode = this.refuse(2, WORDS.variables.nothingDone, { reason: session });
    return null;
  }

  /** This session's variables — or why there are none. */
  openSession(): SessionVars | string {
    const session = this.sessionIdOrReason(WORDS.variables.needs);
    if ('reason' in session) return session.reason;
    return openSessionVars(resolve(projectRootOf(this.exe)), session.id, this.root.name);
  }

  // -------------------------------------------------------------- session

  /** The session id the harness gives — or why there is none (the same rule the variables follow). */
  sessionIdOrReason(needs: string = WORDS.contract.needs): { id: string } | { reason: string } {
    const sessionEnv = this.doc.meta.sessionEnv ?? '';
    const session = harnessSession(sessionEnv);
    if ('id' in session) return session;
    return { reason: fill(WORDS.variables[session.missing], { needs, env: sessionEnv }) };
  }
}

/** A contract's issues on one line — null when there are none. */
function issuesText(issues: ReturnType<typeof validateRecord>): string | null {
  return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
}


function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index < 0 ? KIND_ORDER.length : index;
}


/** One `ls` filter: the field it reads, how it compares (`=` exactly, `~` containing), and the text it looks for. */
interface FilterTerm { key: FilterKey; operator: string; value: string }

type FilterKey = typeof FILTER_KEY[keyof typeof FILTER_KEY];

/** Whether a block satisfies one filter. */
function matches(block: ApBlock, { key, operator, value }: FilterTerm): boolean {
  const exact = operator === '=';
  if (key === FILTER_KEY.tag) {
    const tag = value.replace(/^#/, '');   // written `#security` in the source, stored bare
    return exact ? block.tags.includes(tag) : block.tags.some(blockTag => blockTag.toLowerCase().includes(tag.toLowerCase()));
  }
  const field = fieldOf(block, key);
  return exact ? field === value : field.toLowerCase().includes(value.toLowerCase());
}

/** The text of a block a filter reads: its kind, its name, or what it is about. */
function fieldOf(block: ApBlock, key: FilterKey): string {
  switch (key) {
    case FILTER_KEY.kind: return block.kind;
    case FILTER_KEY.name: return block.name;
    default: return block.about ?? '';
  }
}

