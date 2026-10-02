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
 * one `# error:` line carrying the command that fixes it.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, basename, resolve } from 'path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import type { ApDocument } from '../apdoc/document.js';
import type { ApBlock } from '../apdoc/block.js';
import type { ApRef, ApNode, ApWhenNode, ApRunNode, ApDirectiveNode } from '../apdoc/types.js';
import { KIND_STRATEGIES, type AgentBlock, type TeamBlock, type StoreBlock, type VarBlock } from '../apdoc/blocks.js';
import { mdEnv, renderPreamble, renderEntry, renderMd } from '../../adapters/md/index.js';
import type { MdEnv } from '../../adapters/md/toolkit.js';
import { FORMULAS, fill, type QuizQuestion } from '../formulas.js';
import { DISTILLED_DIR, FLOWS_DIR, flowScriptStem, projectRootOf, projectStoreDir } from './paths.js';
import { type ApxVerb } from './verbs.js';
import { openTable, runTable, upsertBy } from './tabeli.js';
import { openSessionVars, type SessionVars } from './sessionVars.js';
import { refName } from '../../adapters/md/phrases.js';
import { CREDIT } from '../credits.js';
import { validateRecord, slotSpecsOf, formatIssues } from '../shapeSchema.js';
import { BLOCK_ID_RE } from '../apdoc/ids.js';
import { constantOf, varRefRe } from '../vars.js';

/** Build provenance sealed next to the document. */
export interface ApxBuild {
  builtAt: string;
  agentPackVersion: string;
  hash: string;
}

/** Kinds in reading order: who you are, your team, then the md chapter order. */
const KIND_ORDER = [...new Set(['agent', 'team', ...KIND_STRATEGIES.map(s => s.kind)])];

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
  ['run <dst-id> [json]', 'run a distilled script: input as JSON (argument or stdin), its JSON output back'],
  ['version', 'agent, build date, agent-pack version, hash, block count'],
  ['<store> <verb> …', 'read or write a store (tabeli verbs: q a s …)'],
  ['help', 'this list'],
];

const FILTER_RE = /^(kind|tag|name|about)(=|~)(.+)$/;

/** A session id as it may name a folder: no separator, never `.` or `..`. */
const SESSION_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

/** How long a distilled script may run before the agent works it out itself. */
const RUN_TIMEOUT_MS = 30_000;

/** Why a script failed, from its stderr: the last lines that say something — stack frames, carets and runtime banners left out. */
function stderrCause(stderr: string): string {
  return stderr.split(/\r?\n/)
    .filter(l => l.trim() && !/^\s+at\s/.test(l) && !/^\s*\^+\s*$/.test(l) && !/^Node\.js v\d/.test(l))
    .slice(-3)
    .map(l => l.trim())
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

export class ApxEngine {
  /** The command prefix every printed command starts with. */
  private readonly cmd: string;
  /** The md environment with references in the apx form. */
  private readonly env: MdEnv;
  private readonly root: AgentBlock;
  private readonly byId = new Map<string, ApBlock>();
  /** Every verb, by name — the table APX_VERBS lists. */
  private readonly verbs: Record<ApxVerb, (args: string[]) => number> = {
    start: args => this.start(args),
    scope: () => this.scope(),
    ls: args => this.ls(args),
    get: args => this.get(args),
    set: args => this.set(args),
    refs: args => this.refs(args),
    find: args => this.find(args),
    md: () => this.print(renderMd(this.doc)),
    flow: args => this.flow(args),
    run: args => this.runScript(args),
    version: () => this.version(),
    help: () => this.help(),
  };

  constructor(
    private readonly doc: ApDocument,
    private readonly build: ApxBuild,
    /** The path the harness invoked this file by — printed commands reuse it. */
    private readonly exe: string,
    private readonly write: (line: string) => void,
    private readonly budget: ApxBudget = APX_BUDGET,
  ) {
    this.cmd = `node ${exe}`;
    this.env = mdEnv(doc, id => ` [${this.cmd} get ${id}]`, agent => (!agent || agent === doc.root()?.name ? this.cmd : this.sibling(agent)));
    this.root = doc.root() as AgentBlock;
    for (const block of doc.all()) this.byId.set(block.id, block);
  }

  /** Dispatch one invocation: a verb, or a store name and a tabeli verb. No verb = start. */
  run(argv: string[]): number {
    const [verb = 'start', ...args] = argv;
    if (verb === '-h' || verb === '--help') return this.help();
    if (Object.hasOwn(this.verbs, verb)) return this.verbs[verb as ApxVerb](args);
    const store = this.stores().find(s => s.name === verb);
    if (store) return this.storeVerb(store, args);
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
      const form = quiz.map((q, i) => `${i + 1}=<${letters(q.options).join('|')}>`).join(' ');
      this.out(`# quiz — answer with: ${this.cmd} start ${form}`);
      this.out(`# '?' = don't know: it costs nothing and gets you that kind's introduction. a guess costs you a wrong prompt.`);
      quiz.forEach((q, i) => {
        this.out(`${i + 1}. [${q.kind}] ${q.ask}`);
        this.out(`   ${q.options.map((o, j) => `${letters(q.options)[j]}) ${o}`).join('   ')}`);
      });
      return 0;
    }
    const given = new Map<number, string>();
    for (const arg of args) {
      const m = ANSWER_RE.exec(arg);
      const n = m ? Number(m[1]) : 0;
      if (!m || n < 1 || n > quiz.length) {
        return this.fail(2, `bad answer '${arg}': expected <n>=<letter> with n in 1..${quiz.length} — the quiz: ${this.cmd} start`);
      }
      given.set(n, m[2].trim().toLowerCase());
    }
    const missed = [...new Set(quiz.filter((q, i) => given.get(i + 1) !== q.right).map(q => q.kind))];
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
    const add = (b: ApBlock | null | undefined) => {
      if (!b || always.has(b)) return;
      always.add(b);
      if (b.kind === 'template') for (const r of uniqueRefs(b.toJSON())) add(this.doc.resolve(r));
    };
    if (this.root.role) add(this.doc.resolve(this.root.role));
    this.doc.byKind('policy').forEach(add);
    if (this.root.lensIn) add(this.doc.resolve(this.root.lensIn.ref));
    if (this.root.lensOut) add(this.doc.resolve(this.root.lensOut.ref));
    // A variable is runtime state, served by `get <name>` — never opened.
    return this.doc.all().filter(b => b !== this.root && b.kind !== 'var' && (always.has(b) || this.text(b).length <= this.budget.block));
  }

  private scope(): number {
    const root = this.root;
    this.out(this.headLine(root));
    this.out(`you:  ${this.label(root)}  — your definition, complete`);
    if (root.mandate) this.out(`mandate: ${root.mandate}`);
    const owns = this.doc.owns();
    if (owns) this.out(`perimeter: you write only ${owns} — read whatever you need`);
    const role = root.role ? this.doc.resolve(root.role) : null;
    if (role) this.out(`role: ${this.label(role)}`);
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    if (team) {
      this.out(`team: ${this.label(team)}${team.about ? `  — ${team.about}` : ''}`);
      for (const r of team.routing ?? []) this.out(`  WHEN ${r.when}  -> ${this.refLabel(r.run)}`);
    }
    const policies = this.doc.byKind('policy');
    if (policies.length > 0) {
      this.out('respect:');
      for (const p of policies) this.out(`  ${this.label(p)}${p.about ? `  — ${p.about}` : ''}`);
    }
    // Every WHEN and hook of the agent and of its role: what it does, and when.
    const own = [root, ...(role ? [role] : [])].flatMap(b => b.toJSON().body as ApNode[]);
    const whens = own.filter((n): n is ApWhenNode => n.type === 'when');
    if (whens.length > 0) {
      this.out(`when:  — the steps: ${this.cmd} get ${root.id}`);
      for (const w of whens) {
        const runs = w.body.filter((c): c is ApRunNode => c.type === 'run').map(c => this.refLabel(c.ref));
        this.out(`  WHEN ${w.condition}${runs.length ? `  -> ${runs.join(', ')}` : ''}`);
      }
    }
    const memories = own.filter((n): n is ApDirectiveNode => n.type === 'directive' && n.keyword === 'MEM' && (n.force ?? 0) >= 0);
    if (memories.length > 0) {
      this.out('remember:');
      for (const m of memories) this.out(`  ${m.text}${m.shape ? `  — as ${this.refLabel(m.shape.ref)}` : ''}`);
    }
    this.out('write to:');
    const stores = this.stores();
    if (stores.length === 0) this.out('  (no stores declared)');
    for (const s of stores) this.out(`  ${this.label(s.block)}  — use: ${this.cmd} ${s.name} <verb> …`);
    const variables = this.doc.byKind('var');
    if (variables.length > 0) {
      this.out(`variables:  — read: ${this.cmd} get <name>, store: ${this.cmd} set <name> -`);
      for (const v of variables) this.out(`  ${v.name}  — ${v.about}`);
    }
    const marks = this.doc.distillMarks().filter(d => d.mark.force >= 0);
    if (marks.length > 0) {
      this.out('distilled:');
      for (const { mark, block } of marks) {
        const state = this.script(mark.id) ? 'script ready' : 'no script yet';
        this.out(`  ${mark.id}  ${block.kind} ${block.name}  (${state})  — ${this.cmd} run ${mark.id} '<json>'`);
      }
    }
    if (root.lensIn) this.out(`requests arrive as: ${this.refLabel(root.lensIn.ref)}`);
    if (root.lensOut) this.out(`answer as: ${this.refLabel(root.lensOut.ref)}  — your own rules apply in addition to the shape`);
    const counts = this.groups(this.doc.all()).map(([kind, blocks]) => `${blocks.length} ${kind}`);
    this.out(`contains: ${counts.join(', ')}  — list them: ${this.cmd} ls`);
    return 0;
  }

  private ls(args: string[]): number {
    const terms: { key: string; op: string; val: string }[] = [];
    let count = false;
    for (const arg of args) {
      if (arg === 'count') { count = true; continue; }
      const m = FILTER_RE.exec(arg);
      if (!m) return this.fail(2, `bad filter '${arg}' — filters look like: ${this.cmd} ls kind=template tag=planning name~idea about~plan`);
      terms.push({ key: m[1], op: m[2], val: m[3] });
    }
    const hits = this.doc.all().filter(b => terms.every(t => matches(b, t.key, t.op, t.val)));
    for (const [kind, blocks] of this.groups(hits)) {
      this.out(`${kind} (${blocks.length})`);
      if (!count) for (const b of blocks) this.out(`  ${this.lsLine(b)}`);
    }
    this.out(`# ${hits.length} block${hits.length === 1 ? '' : 's'}${hits.length === 0 && terms.length > 0 ? ' match' : ''}`);
    return 0;
  }

  private get(args: string[]): number {
    if (args[0] && !BLOCK_ID_RE.test(args[0])) return this.getVariable(args[0]);
    const block = this.blockArg('get', args);
    if (!block) return this.lastCode;
    if (args[1] === 'json') return this.print(JSON.stringify(block.toJSON(), null, 1));
    this.print(this.text(block));
    const tags = block.tags.length > 0 ? `  ${block.tags.map(t => `#${t}`).join(' ')}` : '';
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
    let n = 0;
    for (const block of this.doc.all()) {
      const lines = this.text(block).split('\n').filter(l => l.toLowerCase().includes(needle));
      if (lines.length === 0) continue;
      n++;
      this.out(this.lsLine(block));
      for (const line of lines) this.out(`  > ${line.trim()}`);
    }
    this.out(`# ${n} block${n === 1 ? '' : 's'}${n === 0 ? ' match' : ''}`);
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

  /**
   * `run <dst-id> [json]` — the bridge to a distilled script: the input as JSON
   * on its stdin, its JSON output back, checked against the contract template
   * when the mark has one. Any failure is exit 1 with the way on: reason.
   */
  private runScript(args: string[]): number {
    const [id, arg] = args;
    if (!id) return this.fail(2, `run needs a script id — the distilled procedures: ${this.cmd} scope`);
    const mark = this.doc.distillMarks().find(d => d.mark.id === id)?.mark;
    if (!mark) return this.fail(1, `no distilled procedure with id '${id}' in this agent — the distilled ones: ${this.cmd} scope`);
    if (mark.force < 0) return this.fail(1, `${id} is never distilled — work it out yourself`);
    const script = this.script(id);
    if (!script) return this.fail(1, `no script for ${id} yet — work it out yourself, then write ${DISTILLED_DIR}/${id}.<ext> as its instruction says`);
    const input = arg ?? (process.stdin.isTTY ? '' : readFileSync(0, 'utf-8'));
    if (mark.input) {
      const issues = this.contractIssues(input, mark.input.ref);
      if (issues) return this.fail(2, `the input is not shaped as \`${refName(mark.input.ref)}\`: ${issues}`);
    }
    // Its own process group, so a timeout stops whatever the script started too.
    const run = spawnSync(script, [], { input, encoding: 'utf-8', timeout: RUN_TIMEOUT_MS, detached: true } as SpawnSyncOptionsWithStringEncoding);
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') {
      try { process.kill(-run.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
      return this.fail(1, `${id} did not answer within ${RUN_TIMEOUT_MS / 1000} s — work it out yourself`);
    }
    if (run.error) return this.fail(1, `${script} could not start (${code}) — make it executable (chmod +x) with a #! line; meanwhile work it out yourself`);
    if (run.status !== 0) {
      const why = stderrCause(run.stderr ?? '');
      return this.fail(1, `${id} did not answer (exit ${run.status})${why ? `: ${why}` : ''} — work it out yourself`);
    }
    const issues = this.contractIssues(run.stdout, mark.shape.ref);
    if (issues) return this.fail(1, `${id} answered outside \`${refName(mark.shape.ref)}\`: ${issues} — work it out yourself`);
    return this.print(run.stdout.trimEnd());
  }

  /** What is wrong with a JSON text against a contract template — or null when it fits. */
  private contractIssues(json: string, template: ApRef): string | null {
    let value: unknown;
    try { value = JSON.parse(json); } catch { return 'not valid JSON'; }
    const slots = this.doc.slotsOf(template);
    if (!slots) return null;
    const issues = validateRecord(value, slots, this.doc.slotResolver());
    return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
  }

  private version(): number {
    this.out(`# ${this.root.name}  ${this.root.id}`);
    this.out(`# built ${this.build.builtAt} by agent-pack ${this.build.agentPackVersion}  hash ${this.build.hash}  ${this.doc.all().length} blocks`);
    this.out(`# ${CREDIT}`);
    return 0;
  }

  private help(): number {
    const width = Math.max(...HELP.map(([v]) => v.length));
    for (const [verb, what] of HELP) this.out(`${this.cmd} ${verb.padEnd(width)}  ${what}`);
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
    if (block === this.root) return renderPreamble(this.doc, this.env);
    if (block.kind === 'team') return this.teamView(block as TeamBlock);
    return renderEntry(block, 1, this.env);
  }

  /** The team — members with the command that reaches each, routing, shared block. */
  private teamView(team: TeamBlock): string {
    const out = [this.headLine(team)];
    if (team.members.length > 0) {
      out.push('members:');
      for (const m of team.members) {
        const member = this.doc.resolve(m);
        out.push(`  ${this.refLabel(m)}${member?.about ? `  — ${member.about}` : ''}`);
      }
    }
    if (team.routing?.length) {
      out.push('routing:');
      for (const r of team.routing) out.push(`  WHEN ${r.when}  -> ${this.refLabel(r.run)}`);
    }
    if (team.shared) out.push(`shared: ${team.shared}`);
    return out.join('\n') + '\n';
  }

  /** `uses:` and `used by:` of a block, each with its command. */
  private links(block: ApBlock): void {
    // Every policy in the document binds the agent — imported, not referenced by a line.
    const policies = block === this.root ? this.doc.byKind('policy') : [];
    const uses = [...uniqueRefs(block.toJSON()).map(r => this.refLabel(r)), ...policies.map(p => this.label(p))];
    this.out('uses:');
    if (uses.length === 0) this.out('  (nothing)');
    for (const use of uses) this.out(`  ${use}`);
    this.out('used by:');
    const users = this.doc.all().filter(b => b !== block && (
      uniqueRefs(b.toJSON()).some(r => r.target === block.address) || (block.kind === 'policy' && b === this.root)));
    if (users.length === 0) this.out('  (nothing inside this agent)');
    for (const user of users) this.out(`  ${this.label(user)}`);
  }

  // ---------------------------------------------------------------- helpers

  /** `kind name  [command]` — how a block reads in the engine's views. */
  private label(block: ApBlock): string {
    return `${block.kind} ${block.name}  [${this.cmd} ${block.kind === 'flow' ? 'flow' : 'get'} ${block.id}]`;
  }

  /** A reference as a label: here → its block; a fellow agent → its own executable. */
  private refLabel(ref: ApRef): string {
    const block = this.doc.resolve(ref);
    if (block) return this.label(block);
    const name = ref.target.split('/').pop() ?? ref.target;
    if (ref.kind === 'agent') return `agent ${name}  [${this.sibling(name)} scope]`;
    return `${ref.kind} ${name}  (missing from the compiled sources)`;
  }

  /** How to run a fellow agent's executable: beside this one. */
  private sibling(name: string): string {
    return `node ${join(dirname(this.exe), `${name}.apx`)}`;
  }

  private headLine(block: ApBlock): string {
    return `# ${block.kind} ${block.name}${block.about ? ` — ${block.about}` : ''}`;
  }

  private lsLine(block: ApBlock): string {
    const tags = block.tags.length > 0 ? `  ${block.tags.map(t => `#${t}`).join(' ')}` : '';
    return `${block.id}  ${block.name}${tags}${block.about ? `  — ${block.about}` : ''}`;
  }

  /** Blocks grouped by kind, in reading order. */
  private groups(blocks: ApBlock[]): [string, ApBlock[]][] {
    const kinds = [...new Set(blocks.map(b => b.kind))].sort((a, b) => kindRank(a) - kindRank(b));
    return kinds.map(kind => [kind, blocks.filter(b => b.kind === kind)]);
  }

  /** The compiled script of this version of a flow — or null. */
  private flowScript(flow: ApBlock): string | null {
    const stem = flowScriptStem(flow.id, flow.contentHash);
    return this.findIn(FLOWS_DIR, f => f.startsWith(`${stem}.`));
  }

  /** The script of a distilled construct, found by name beside the project's sources — or null. */
  private script(id: string): string | null {
    return this.findIn(DISTILLED_DIR, f => f === id || f.startsWith(`${id}.`));
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
    const pending = this.doc.all().filter(b => b !== this.root && !opened.has(b));
    if (pending.length === 0) return [];
    return this.groups([this.root, ...pending]).flatMap(([kind]) => (guides[kind]?.quiz ?? []).map(q => ({ ...q, kind })));
  }

  /** The block named by a verb's id argument, or null after printing the error. */
  private lastCode = 0;
  private blockArg(verb: string, args: string[]): ApBlock | null {
    const id = args[0];
    if (!id) {
      this.lastCode = this.fail(2, `${verb} needs a block id — example: ${this.cmd} ${verb} ${this.root.id}`);
      return null;
    }
    const block = this.byId.get(id);
    if (block) return block;
    const team = this.doc.byKind('team')[0] as TeamBlock | undefined;
    const fellow = team?.members.find(m => m.id === id && !this.doc.resolve(m));
    this.lastCode = fellow
      ? this.fail(1, `${id} is an agent defined in its own executable — run: ${this.sibling(fellow.target.split('/').pop()!)} scope`)
      : this.notFound(id);
    return null;
  }

  /** Neither a block nor a variable answers to this name. */
  private notFound(name: string): number {
    return this.fail(1, `no block with id '${name}' and no variable named so — list them: ${this.cmd} ls`);
  }

  private out(line: string): void {
    this.write(line);
  }

  /** Print a multi-line text as it is (one trailing newline trimmed). */
  private print(text: string): number {
    this.write(text.replace(/\n$/, ''));
    return 0;
  }

  private fail(code: number, message: string): number {
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
    try { stored = vars.read(name, block.scope); } catch (e) { return this.fail(2, `reading ${name}: ${e instanceof Error ? e.message : e}`); }
    this.print(this.text(block));
    this.out(`# var ${name}  ${block.id}`);
    this.links(block);
    this.out('read by:');
    const readers = this.doc.all().filter(b => [...JSON.stringify(b.body).matchAll(varRefRe())].some(([, read, field]) => read === name && !field));
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
    const type = block.type ? refName(block.type) : '';
    if (block.type) {
      if (!this.doc.slotsOf(block.type)) return this.fail(1, `\`${name}\` is shaped as \`${type}\`, a template not compiled into this agent — nothing was written`);
      const issues = this.contractIssues(value, block.type);
      if (issues) return this.fail(2, `the value is not shaped as \`${type}\`: ${issues} — nothing was written`);
    }
    const vars = this.sessionVars();
    if (!vars) return this.lastCode;
    try { vars.write(name, block.scope, { value, type, by: this.root.name }); } catch (e) { return this.fail(2, `storing ${name}: ${e instanceof Error ? e.message : e}`); }
    this.out(`# ${name} stored for this session — read it: ${this.cmd} get ${name}`);
    return 0;
  }

  /** A variable of this agent, by name. */
  private variable(name: string): VarBlock | null {
    return (this.doc.byKind('var') as VarBlock[]).find(v => v.name === name) ?? null;
  }

  /**
   * This session's variables, from the session id the harness puts in the
   * variable its adapter names. Fails closed — no adapter naming one, no id, an
   * id that is no folder name, or storage that cannot keep them: null after
   * the error, nothing read or written.
   */
  private sessionVars(): SessionVars | null {
    const env = this.doc.meta.sessionEnv;
    const id = env ? process.env[env] : undefined;
    const refused = !env
      ? 'variables need the harness session id, and this agent was compiled without an adapter that names where it is'
      : !id ? `variables need the harness session id, and ${env} is not set`
        : !SESSION_ID_RE.test(id) ? `${env} holds no usable session id (letters, digits, . _ - only)` : null;
    if (refused) {
      this.lastCode = this.fail(2, `${refused} — nothing was read or written`);
      return null;
    }
    return openSessionVars(resolve(projectRootOf(this.exe)), id!, this.root.name);
  }

  // ----------------------------------------------------------------- stores

  /** What is wrong with a write against the store's slots — or null when it fits. */
  private writeIssues(store: Store, args: string[]): string | null {
    const write = writeFields(args);
    if (!write) return null;
    const record: Record<string, unknown> = {};
    for (const pair of write.pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) return `\`${pair}\` is not a field=value pair`;
      const field = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const slot = store.block.slots.find(sl => sl.name === field);
      record[field] = slot?.type.kind === 'number' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
    }
    const slots = slotSpecsOf(store.block.slots, !write.add);
    const issues = validateRecord(record, slots);
    return issues.length > 0 ? formatIssues(issues).replace(/\n/g, '; ') : null;
  }

  /** The stores, each with the table file behind it: beside this file, in `<agent>.state/`. */
  /** The stores, each with its table file — the location is from the project root, two levels above this file. */
  private stores(): Store[] {
    const projections = this.doc.mdSource?.stores ?? {};
    const root = resolve(projectRootOf(this.exe));
    return (this.doc.byKind('store') as StoreBlock[]).map(block => {
      const location = projections[block.address]?.location ?? `${projectStoreDir(this.root.name)}/${block.name}.tbl`;
      return { block, name: block.name, key: block.storeKey, location, path: join(root, location) };
    });
  }

  /**
   * Forward `<store> [verb …]` to its tabeli table, creating it on first use.
   * KEY is agent-pack semantics: `a` with the key already present updates that
   * record instead of duplicating it, as the prompt promises.
   */
  private storeVerb(store: Store, args: string[]): number {
    const refused = this.writeIssues(store, args);
    if (refused) return this.fail(2, `${store.name}: ${refused} — nothing was written`);
    const unopened = openTable(store.path);
    if (unopened) return this.fail(2, unopened);
    const i = args[0] === 'a' && store.key ? args.findIndex((kv, j) => j > 0 && kv.startsWith(`${store.key}=`)) : -1;
    let run;
    if (i > 0) {
      let upsert;
      try {
        upsert = upsertBy(store.path, store.key!, args[i].slice(store.key!.length + 1), [...args.slice(1, i), ...args.slice(i + 1)]);
      } catch (e) {
        return this.fail(2, `${store.name}: ${e instanceof Error ? e.message : e} — nothing was written`);
      }
      if (upsert.updated !== null) this.out(`# ${args[i]} exists as id=${upsert.updated} — updated, not duplicated`);
      run = upsert.run;
    } else {
      run = runTable(store.path, args);
    }
    // errors and manuals name the .tbl — say it in this executable's own words
    const table = basename(store.path);
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
      .split(`./${table}`).join(`${this.cmd} ${store.name}`)
      .split(table).join(`${this.cmd} ${store.name}`)
      .trimEnd();
    if (text) this.out(text);
    return run.status ?? 2;
  }
}

/**
 * A write checked against the store's schema before it reaches the table: `a`
 * adds a whole record (every required slot, the KEY included), `s <id>` sets
 * some fields; either way no unknown field and no value outside its slot type.
 */
function writeFields(args: string[]): { add: boolean; pairs: string[] } | null {
  if (args[0] === 'a') return { add: true, pairs: args.slice(1) };
  if (args[0] === 's') {
    const end = args.indexOf('if');
    return { add: false, pairs: args.slice(2, end === -1 ? undefined : end) };
  }
  return null;
}

interface Store {
  block: StoreBlock;
  name: string;
  key: string | null;
  location: string;
  path: string;
}

function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i < 0 ? KIND_ORDER.length : i;
}

function letters(options: string[]): string[] {
  return options.map((_, i) => String.fromCharCode(97 + i));
}

function matches(block: ApBlock, key: string, op: string, val: string): boolean {
  if (key === 'tag') {
    const tag = val.replace(/^#/, '');   // written `#security` in the source, stored bare
    return op === '=' ? block.tags.includes(tag) : block.tags.some(t => t.toLowerCase().includes(tag.toLowerCase()));
  }
  const value = key === 'kind' ? block.kind : key === 'name' ? block.name : block.about ?? '';
  return op === '=' ? value === val : value.toLowerCase().includes(val.toLowerCase());
}

/** Every reference a block's data holds — any `{ kind, target, id }` object — once per target. */
function uniqueRefs(data: unknown): ApRef[] {
  const found = new Map<string, ApRef>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.target === 'string' && typeof o.kind === 'string' && 'id' in o) {
      if (!found.has(o.target)) found.set(o.target, o as unknown as ApRef);
      return;
    }
    Object.values(o).forEach(walk);
  };
  const { args, body } = data as { args?: unknown; body?: unknown };
  walk(args);
  walk(body);
  return [...found.values()];
}
