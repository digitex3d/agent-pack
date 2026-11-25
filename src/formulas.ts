// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
/**
 * Formulas — THE single source of every fixed prose formulation of the md
 * projection (config/formulas.json), keyed by the construct that owns it.
 *
 * Renderers never type prose: they pick the formula of the construct they are
 * rendering and `fill` it with that construct's data. Data in config,
 * imported (so it travels inside the apx engine bundle) and validated once.
 */
import FORMULAS_JSON from './config/formulas.json' with { type: 'json' };

type Text = string;
/** What a loop's round lines say after `then` and `report that` — a checked UNTIL's, a starred one's. */
type RoundWords = { again: Text; end: Text };

/** One entry-quiz question on a block kind: multiple choice, `right` is the letter. */
export interface QuizQuestion { ask: Text; options: Text[]; right: string }

/** How a block kind is used: its introduction (`.ap` lines) and its entry quiz. */
export interface KindGuide { intro: Text[]; quiz: QuizQuestion[] }

/** How a unit's identity reads — the team's, or the main's: who it is, then what it holds. */
interface UnitWords { lead: Text; members: Text }

export interface Formulas {
  decorators: { use: Text; and: Text; intros: Record<string, Text> };
  keywords: {
    IF: { head: Text };
    ELSE: { head: Text };
    UNTIL: { head: Text };
    /** A checked condition (src/check.ts): its head per keyword and level, the judge's question and state. */
    CHECK: {
      run: Text; IF: Record<'1' | '2', Text>; UNTIL: Record<'1' | '2', Text>; nextRound: Text; limit: Text; loop: RoundWords;
      question: Text; shapedRead: Text; field: Text; fieldSeparator: Text; state: Text; stateSeparator: Text;
    };
    WHEN: { head: Text; handed: Text };
    EACH: { head: Text; waited: Text };
    IN: { head: Text; store: Text; unresolved: Text };
    STEP: { head: Text; list: Text };
    RUN: { line: Text; flow: Text; unresolved: Text; bare: Text; sequence: Text; name: Text };
    DO: { intro: Text };
    DELEGATE: { intro: Text; to: Text; full: Text; shaped: Text; background: Text; started: Text; element: Text; elements: Text; contracts: Text; contractsRun: Text; contractsWait: Text; contractsHarness: Text; contractsHarnessRun: Text; harness: Text; harnessContext: Text; harnessBackground: Text; harnessRun: Text; harnessWait: Text };
    MARK: { intro: Text; text: Text; within: Text; none: Text };
    ASK: { intro: Text; to: Text };
    FORK: { intro: Text; self: Text; agent: Text; shaped: Text };
    WAIT: { intro: Text; named: Text; all: Text; run: Text; max: Text };
    COMPUTE: { intro: Text; require: Text; return: Text; ensure: Text; rule: { require: Text; ensure: Text; never: Text } };
    EXECUTOR: Record<'1' | '2', Text> & { procedure: Record<'1' | '2', Text>; ask: Text; run: Text; who: Record<'1' | '2', Text>; answer: { holds: Text; shaped: Text; text: Text }; rounds: Text; loop: RoundWords; into: Record<'1' | '2', Text> };
    BY: { intro: Text; inline: Text };
    AS: { fallback: Text; line: Text; agent: Text; shaped: Text };
    APPLIES: { scope: Record<'universal' | 'team' | 'agent' | 'with' | 'ls', Text> };
    WRITES: { fence: Text[]; none: Text; formula: Text; uncertain: Text };
    READS: { all: Text; only: Text };
    FOR: { glob: Text };
    'LENS-IN': { line: Text; input: Text };
    'LENS-OUT': { bridge: Text };
    MANDATE: { line: Text };
    VAR: { read: Text; readShaped: Text; block: Text; store: Text; storeTyped: Text; about: Text; scopes: Record<'private' | 'session', Text>; typed: Text; entry: Text };
  };
  blocks: {
    agent: { identity: Text; role: Text; roleAbout: Text; roleExpertise: Text; roleAboutExpertise: Text; expertise: Text } & KindGuide;
    policy: { chapter: Text } & KindGuide;
    role: { chapter: Text } & KindGuide;
    template: {
      chapter: Text; scaffold: Text; layoutSlot: Text; layoutSeparator: Text; fields: Text; field: Text;
      optional: Text; description: Text; rule: Text; exampleOpen: Text; exampleClose: Text; scalar: Text;
    } & KindGuide;
    procedure: { chapter: Text } & KindGuide;
    flow: { chapter: Text } & KindGuide;
    skill: { chapter: Text; apx: Text; harness: Text } & KindGuide;
    store: {
      chapter: Text; home: Text; lasts: Record<'project' | 'session', Text>; field: Text; key: Text;
      reject: Text; create: Text; usage: Text; noType: Text; unknownType: Text;
    } & KindGuide;
    dimension: { chapter: Text; covers: Text; eachShape: Text; read: Text; write: Text; query: Text } & KindGuide;
    domain: { chapter: Text; writes: Text; reads: Text; formula: Text } & KindGuide;
    plugin: { line: Text; commands: Text; command: Text };
    team: { heading: Text; member: Text; handles: Text; fellows: Text; fellow: Text; undescribed: Text; closing: Text; unit: UnitWords & { row: Text } } & KindGuide;
    /** What AGENTS.md says of the main: its name, the command that prints it, and to run it again. */
    main: { heading: Text; boot: Text; again: Text; unit: UnitWords & { teams: Text } };
    runtime: { heading: Text };
    tool: { chapter: Text; heading: Text } & KindGuide;
  };
  types: {
    qualified: Text; text: Text; minWords: Text; maxWords: Text; regex: Text; number: Text;
    range: Text; atLeast: Text; atMost: Text; enum: Text; shape: Text; list: Text;
    storeShape: Text; storeList: Text;
  };
  /** What the apx says on its verbs (src/apx/engine.ts). */
  apx: {
    deliver: {
      refused: { notRunning: Text; lostZones: Text; strayed: Text; leftOut: Text; moved: Text };
      done: { delivered: Text; nothing: Text; leftOutLine: Text; leftOut: Text; answer: Text };
    };
    start: { whole: Text; quiz: Text; unsure: Text; badAnswer: Text; allCorrect: Text; missed: Text; opened: Text };
    /** The envelope a call may end with — the line that frames its introduction, why one is no JSON, a built-in template that did not compile (src/apx/call.ts, src/compiler/index.ts). */
    call: { intro: Text; notJson: Text; missing: Text; quiz: QuizQuestion[] };
    dashboard: { separator: Text; next: Text; current: Text; laterBand: Text; entry: Text; trigger: Text; triggerCommand: Text; triggerFooter: Text; bands: { high: { one: Text; many: Text }; medium: Text; low: Text } };
    dispatch: { renamed: Text; unknownVerb: Text };
    scope: { perimeter: Text; writesNothing: Text; readsOnly: Text; readsAnything: Text; uncertain: Text; uncertainEntry: Text; noStores: Text; dimensions: Text; checks: Text; executors: Text; requests: Text; answer: Text };
    ls: { badFilter: Text };
    find: { needsText: Text };
    flow: { notFlow: Text; steps: Text };
    executor: { needsId: Text; unfilled: Text; intoNotProcedure: Text; intoStored: Text; intoNeedsVariable: Text; intoNone: Text; stored: Text; describe: Text; input: Text };
    program: { notProgram: Text; noTimeout: Text; testsMissing: Text; testsEmpty: Text; testTimeout: Text; testFailed: Text; needsInput: Text; inputNotJson: Text; timedOut: Text; refused: Text; broken: Text };
    check: { needsId: Text; unknown: Text; noJudge: Text; gateStaysClosed: Text; judgeNotLoaded: Text; failed: Text; gateStayedClosed: Text; gateOpened: Text; empty: Text; emptyGate: Text; tooLarge: Text; tooLargeGate: Text; noAnswer: Text; noProbability: Text; holds: Text; doesNotHold: Text; belowGate: Text; heading: Text; sealed: Text; state: Text };
    lookup: { needsId: Text; fellow: Text; notFound: Text; nothingInside: Text };
    variables: { empty: Text; constant: Text; valueEmpty: Text; setNeeds: Text; setConstant: Text; setUnknown: Text; setRefused: Text; setDone: Text; nothingDone: Text; noAdapter: Text; notSet: Text; unusable: Text; needs: Text };
    contract: { verbUnknown: Text; verbMissing: Text; verbProblem: Text; failed: Text; markUnknown: Text; markMissing: Text; markProblem: Text; idMissing: Text; noContract: Text; specOnStdin: Text; zonesFull: Text; specBreaks: Text; specExample: Text; listRefused: Text; marks: Text; whoMissing: Text; recipeMissing: Text; nothingMarked: Text; zoneMissing: Text; startRefused: Text; started: Text; startedElsewhere: Text; takesBack: Text; changedList: Text; changedDelegate: Text; changedGet: Text; foldConflict: Text; needs: Text; endedWithout: Text; listed: Text; header: Text; carriedOutBy: Text; notStartedYet: Text; mayWrite: Text; workInCopy: Text; cannotHonour: Text; pathNeeded: Text; noCopy: Text; marksLost: Text; outsideContract: Text; andWrites: Text; notDelivered: Text; preferTakes: Text; mergeConflicts: Text };
    landing: { conflicts: Text; thenStart: Text; thenLand: Text; thenLandCommand: Text; landed: Text; landedUncommitted: Text; nothing: Text };
    guard: { needs: Text; pathNeeded: Text; blocked: Text; writesNothing: Text; outsideOwn: Text; inCopy: Text; outsidePerimeter: Text; carrying: Text; inProgress: Text };
    elsewhere: { noAnswer: Text; noRecipe: Text; unfilled: Text; run: Text; model: Text; modelDefault: Text; notRunning: Text; deliversInto: Text; leftOut: Text; outsidePerimeter: Text };
    registry: { answer: Text };
  };
  document: {
    ref: Text; heading: Text; entry: Text; about: Text;
    crossReferences: { chapter: Text; row: Text; entry: Text };
  };
  /** What the commands and the ACP client say (src/commands/, adapters/acp/). */
  messages: {
    dashboard: { weighFailed: Text };
    forceLevels: Record<'needsCost' | 'undeclaredCost' | 'noRuleCost', Text>;
    /** What a number must be, as a message says it: `{key} must be {rule}`. */
    numbers: Record<'count' | 'positive' | 'nonNegative', Text>;
    config: Record<'object' | 'unknownKey' | 'mustBe' | 'chatBoss' | 'dashboardBands', Text>;
    /** What the affinity engine (src/affinity/) says of an index or its inputs it refuses. */
    affinity: Record<
      | 'notEntryList' | 'notEntry' | 'duplicateKey' | 'badWeight' | 'notLexicon' | 'notLexiconItems' | 'orphanLexiconKey'
      | 'notBackground' | 'notObject' | 'missingVersion' | 'unknownVersion' | 'badKeys' | 'badWeights' | 'badUnit', Text>;
    chat: Record<'notSet' | 'noServer' | 'eventsLost' | 'bossExited' | 'cannotStart' | 'preambleSent' | 'turnFailed' | 'jumpToLatest'
      | 'joined' | 'removed' | 'removeUnknown' | 'removeFixed' | 'removeUsage' | 'participants'
      | 'inviteList' | 'inviteUnknown' | 'inviteAlready' | 'notInRoom' | 'emptyRoom' | 'sendFailed' | 'recapPrompt' | 'recapAnswer' | 'recapFailed' | 'recapSent'
      | 'aboutInvite' | 'aboutRemove' | 'aboutAll', Text>
      & { setup: Record<'step' | 'reachTitle' | 'reachHint' | 'bossTitle' | 'bossHint' | 'noneFound' | 'saved' | 'badFile', Text> };
    /** The chat screen's launcher (adapters/acp/launcher.ts): its labels, its lines, what it sends. */
    launcher: Record<
      | 'title' | 'search' | 'flow' | 'team' | 'agent' | 'skill' | 'procedure' | 'policy' | 'template' | 'var' | 'room' | 'command'
      | 'detail' | 'of' | 'uses' | 'actionsFlow' | 'actionsBlock' | 'actionsInsert' | 'nothing' | 'runLine' | 'runPrompt' | 'citeRef', Text>;
    ask: Record<'unknown' | 'configured' | 'noneConfigured' | 'noAgentFiles', Text>;
    harnesses: Record<'clash' | 'twice', Text>;
    acp: Record<
      | 'noAnswer' | 'noMessage' | 'refusedPermission' | 'modelDefault' | 'modelNotOffered' | 'modelNoWay' | 'serverExited' | 'exitCode'
      | 'timeout' | 'eventsLost' | 'noConfig' | 'noServer' | 'eventsUnwritable' | 'terminalsRefused' | 'terminalsOff' | 'notServed'
      | 'needsPath' | 'refusedOutside' | 'outside' | 'notServer' | 'noField' | 'modelsNote' | 'serversShape' | 'serverName'
      | 'version' | 'signIn' | 'offers' | 'sessionFailed' | 'noSession' | 'answered' | 'noCommand' | 'needsContent' | 'badArgs' | 'badEnv' | 'cancelled', Text>;
  };
}

/** Every leaf must be a non-empty string (or a list of them): drift fails loud at load. */
function validate(node: unknown, path: string): void {
  if (typeof node === 'string') {
    if (node.length === 0) throw new Error(`formulas.json: ${path} is empty`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length === 0) throw new Error(`formulas.json: ${path} is an empty list`);
    node.forEach((child, index) => validate(child, `${path}[${index}]`));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) if (key !== '$comment') validate(value, path ? `${path}.${key}` : key);
    return;
  }
  throw new Error(`formulas.json: ${path} is not text`);
}

// A copy: the imported module object is shared, and `$comment` is dropped below.
const RAW = structuredClone(FORMULAS_JSON) as unknown as Formulas & { $comment?: string };
validate(RAW, '');
delete RAW.$comment;

export const FORMULAS: Formulas = RAW;

/**
 * Fill a formula: `{key}` becomes `values[key]`. A placeholder with no value
 * stays as written — that is how literal braces in prose (`{slot}`) survive.
 */
export function fill(formula: string, values: Record<string, string | number> = {}): string {
  return formula.replace(/\{([A-Za-z]+)\}/g, (placeholder, key: string) => (key in values ? String(values[key]) : placeholder));
}

/**
 * The one form a reference takes in the `.md` projection: ` (tpl-d82fd6de)` —
 * the block id — or '' when the target has none. Every reference in the md is
 * built through this function; other projections (the apx) pass their own.
 */
export function refSuffix(id: string | null | undefined): string {
  return id ? fill(FORMULAS.document.ref, { id }) : '';
}

/**
 * The introduction of a block kind — how to use that kind — as `.ap` lines
 * joined into source, or '' for a kind without one. Every projection opens a
 * kind with this text: the md chapter intro, the apx quiz remedy.
 */
export function introOf(kind: string): string {
  const guide = (FORMULAS.blocks as unknown as Record<string, Partial<KindGuide>>)[kind];
  return guide?.intro?.join('\n') ?? '';
}

/** The deepest heading level: markdown has six. Deeper requests are capped. */
export const MAX_HEADING_DEPTH = 6;

/** A heading line, as every heading of every projection reads: `## Title`. */
export function headingLine(depth: number, title: string): string {
  return fill(FORMULAS.document.heading, { hashes: '#'.repeat(Math.min(depth, MAX_HEADING_DEPTH)), title });
}

/** `{base} ({detail})` when there is a detail, the base alone otherwise. */
export function qualified(base: string, details: string[]): string {
  return details.length ? fill(FORMULAS.types.qualified, { base, detail: details.join(', ') }) : base;
}
