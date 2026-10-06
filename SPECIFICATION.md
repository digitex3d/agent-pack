# Agent Pack Specification

**Version 1.2 — October 2026.** First written in May 2026 by Giuseppe Federico.

This document is the canonical reference for the Agent Pack paradigm.
It elaborates the principles, the trade-offs, and the primitive
vocabulary of the paradigm with the detail required for implementers,
contributors, and academic citation.

Agent Pack is a programming language to orchestrate agents across every
harness. Its target is the *context window of an LLM*: the compiler reads
`.ap` source and emits what an agent executes — the definition a harness
loads, and an executable (the *apx*) that serves it block by block, on
demand. This document defines the syntax-bearing primitives, the import
system, the obligation system, the runtime boundary (adapters), and the
distillation of reasoning into code.

The canonical citation form for any element of the paradigm is
`Agent Pack §<id>`, where `<id>` is one of the stable identifiers
defined below (e.g. `Agent Pack §P7`, `Agent Pack §D2`).

## 1. Principles

The seven non-negotiable foundations of the paradigm.

- **P1 — Code, not prompts.** Agent rules are code. They have structure
  (sections, hierarchies, nested scopes), modularity (importable,
  reusable units), invariants (constraints checked at compile-time),
  and version history (every rule lives in git). Prompts as throwaway
  strings cannot be improved over time; programs can. If a rule does
  not satisfy these properties, it is not an agent rule — it is a
  note.

- **P2 — Human-readable without tooling.** The source is human-readable
  without tooling. Any `.ap` file is intelligible when opened in a
  plain text editor, with no compiler, no GUI, no preview. If a `.ap`
  file required a renderer to be understood, the format has failed.

- **P3 — Agnostic to model, author, and runtime.** No semantics in the
  source belongs to a specific vendor, model family, or runtime.
  Adapters translate but never extend: anything they emit must be
  derivable from the source. A runtime that demands behavior absent
  from `.ap` is the runtime's problem, not the source's. A definition
  written today works on tomorrow's model and on a runtime that does
  not yet exist.

- **P4 — Composable through explicit imports.** Every dependency
  between agents, playbooks, and rules is named, declared with
  `IMPORT FROM`. There is no global namespace, no auto-loading, no
  ambient context, no implicit inheritance. If it is not imported, it
  is not in scope. The composition graph is fully traceable from the
  source alone — any `.ap` file fully discloses what it pulls in.

- **P5 — Model-antifragile.** The paradigm gains value as models
  improve. Better reasoning makes `.ap` sources more powerful, not
  obsolete: the source describes intent, the model executes it. The
  same source compiled today against a stronger model produces a
  stronger agent, with no edits to the source. Agent Pack feeds on
  model progress; it is not threatened by it.

- **P6 — Library-driven evolution.** The rule library is shared, the
  adoption is local. A new rule entering the library does not
  propagate to existing agents by default; each agent imports what
  serves it. The library grows monotonically; agents grow selectively.
  This is the inverse of ambient inheritance: rules are pulled, never
  pushed.

- **P7 — Reasoning distills into code.** What an agent can do
  deterministically, it should reason about only once. The author marks
  a procedure as distillable; the first time an agent carries it out, it
  also writes a program that reproduces the result exactly, and from then
  on the program does the work — no reasoning, no tokens, the same answer
  every time. The language states the contract (input, output, template);
  the harness writes the program; the executable binds the two. Over time
  an agent's reasoning shrinks to what truly needs judgment, and
  everything else becomes code. Agent Pack is the language in which that
  boundary is declared.

## 2. Trade-offs

We value:

- **Source over runtime.** The `.ap` text is the truth. Whatever runs
  is a derived artifact, reproducible from the source.
- **Composition over global magic.** Every dependency is named and
  importable. Nothing is injected by ambient context.
- **Vocabulary over convention.** A primitive with a stable name beats
  a tribal habit. Shared meaning beats shared style guide.
- **Adapters over abstractions.** Translate to many runtimes by
  writing thin, target-specific adapters — not by forcing every
  runtime under a universal abstraction layer.
- **Citable blocks over invisible state.** A definition whose every
  block has a stable id can be referenced, compared, and benchmarked
  block by block. An opaque prompt blob is none of those things.
- **Context on demand over context up front.** An agent reads the
  block its task needs, when it needs it — not the whole definition on
  every invocation.
- **Code over repeated reasoning.** A result a program can produce is
  not derived again by a model. Reasoning is spent where judgment is
  needed, once where it is not.
- **Explicit adoption over ambient propagation.** A rule reaches an
  agent because the agent imports it. The library grows monotonically;
  agents grow selectively. No rule is pushed onto an agent that did
  not ask for it.

That is, while there is value in the items on the right, we value the
items on the left more.

## 3. Primitives

The shared vocabulary of the paradigm. Each primitive has a stable
identifier (`D1`–`D39`) for external citation as `Agent Pack §D<n>`.
These terms have precise meaning and are not interchangeable.

- **D1 — agent** — an executable unit defined by a mission (what it
  must accomplish), a set of constraints (what it must not violate),
  and a compiled context (the rules and playbooks it has access to). The
  smallest addressable unit of the paradigm — every other primitive
  exists to serve, compose, or constrain agents.

- **D2 — playbook** — a self-contained, reusable capability — a
  workflow, a procedure, a piece of expertise — activated when a
  declarative trigger matches the current task. Playbooks are imported
  into agents, not duplicated; the same playbook can serve dozens of
  agents.

- **D3 — directive** — the smallest unit of normative content: a
  single rule, written once, identifiable by ID, versionable in git,
  citable across agents and projects. The "sentence" of the language:
  every larger artifact (playbook, agent, team shared block) is built
  out of directives.

- **D4 — IMPORT FROM** — the explicit dependency operator. Statements
  like `IMPORT <directive> FROM <library>.<path>` declare exactly which
  rule or playbook is pulled into a definition, and from where. There is
  no ambient inheritance, no auto-discovery — every link is named and
  traceable from the source alone.

- **D5 — *deprecated (parked)*.** Previously defined the *vocabulary*.
  Removed from version 1; the ID is retained and may only return with
  the same meaning.

- **D6 — lens** — the binding of an agent's input or output to a
  template (D15). `LENS-IN` states the shape every request to the agent
  — or a procedure's input — arrives in; `LENS-OUT` the shape of every
  answer an agent gives. A lens is
  the agent's contract with whoever talks to it: orchestrators shape
  what they hand it accordingly.

- **D7 — team** — a named group of agents with a shared purpose, its
  members, and a routing rule that picks the flow for a given task.
  Flows (D24) compile orchestration into
  static instructions the agents follow themselves: the paradigm needs
  no orchestration runtime. (Formerly deprecated; reinstated with this
  definition.)

- **D8 — adapter** — a translation layer from `.ap` source to a
  specific runtime's native format (Claude Code, Cursor, Junie, the
  `AGENTS.md` every harness reads). Adapters are pure
  transformations: they map, they never invent. New runtimes are
  supported by writing a new adapter, never by altering the source.

- **D9 — compiled definition** — the structured document an agent
  compiles to: every block it holds, addressable by id (D19), with every
  cross-reference resolved. Every output is a projection of it — the
  markdown a harness loads, the orchestration, the executable (D20) — so
  two projections of one source can never disagree. (Formerly *bundle*.)

- **D10 — team shared block** — the optional `team.ap` file at a team
  root (sibling of `flows.ap`) that declares the context every member
  of that team shares — its mission, house rules, vocabulary. At
  compile time the compiler injects it ahead of each member's own
  identity and rules; standalone agents and the project level receive
  no injected shared block. The paradigm is *self-describing*: the
  shared blocks governing the Agent Pack reference implementation's own
  teams are themselves `.ap` artifacts, processed by the very system it
  specifies.

- **D11 — force level** — the calibrated strength of a directive,
  written as a keyword and zero to two `!` (or a leading `!` for the
  negative): `MUST`, `MUST!`, `MUST!!`, `!MUST`; `ALWAYS` / `NEVER`;
  `SHOULD`, `SHOULD!`; `MAY`. The same levels calibrate every keyword
  family that expresses obligation — the answer shape (D35), memory
  (D21), distillation (D22). At compile time each level expands into
  one exact formula. Obligation is a first-class primitive of the
  language, not a documentation convention: a level is always written
  with its keyword, never as an action (`DO`) carrying a strength word —
  `NEVER skip a finding`, not `DO never skip a finding`. Every body that
  holds actions — agent, role, playbook, procedure (D16), flow step
  (D24) — admits the levels for that reason. (Rule added in 1.1.)

- **D12 — *deprecated*.** Previously defined the *dynamic rule*. Never
  implemented as specified; the ID is retained per the append-only rule
  (§4) and not reused.

- **D13 — *deprecated*.** Previously defined *rule-fit*. Never
  implemented; the ID is retained and not reused.

- **D14 — *deprecated*.** Previously defined the *librarian*. Never
  implemented; the ID is retained and not reused.

- **D15 — template** — a typed answer format: named slots, each with a
  type (text with a word limit or a pattern, a number in a range, one
  value of an enum, one or a list of another template), an exact layout
  and an example. A template is the unit of contract between agents,
  steps and programs.

- **D16 — procedure** — a reusable sequence of directives with control
  flow (D27), invoked by name with `RUN` from an agent, a role, another
  procedure or a flow step. Its contract is optional: the shape of its
  input (`LENS-IN`, D6) and of its result (`AS`, D35). Beside its
  actions (`DO`, `RUN`), its body holds directives at any force level
  (D11) — memory (D21) included — at its top and under its `IF`, `ELSE`
  and `UNTIL`; `DISTILL` (D22) alone is bound to its top.

- **D17 — role** — a way of thinking and acting: an identity, its
  expertise and its rules, reusable across agents. An agent binds one
  role as its identity (`AS <role>`); a role may extend another.

- **D18 — store** — the data an agent keeps between sessions, declared
  like a schema: slots, a key that identifies a record, and how long it
  lasts. The language defines the structure; the backing is chosen
  apart, and the agent reads and writes only through the executable
  (D20), inside `IN <store>:`. A store is never named like a verb of the
  executable. (Amended in 1.2.)

- **D19 — block id** — the stable identity of every block: a kind prefix
  and a hash of its kind, namespace and name (e.g. `tpl-d82fd6de`),
  unchanged by any edit to the content. Every reference, in every
  projection, is produced from the id by one function; a reference is
  never ambiguous.

- **D20 — apx** — the executable form of an agent: its compiled
  definition (D9) and the engine that serves it, in one file run by
  Node alone. The agent starts from a short quiz on the kinds of blocks
  it holds — each kind defines how it is used — then reads only the
  blocks its task needs, following ids; every reference it prints
  carries the command that fetches it. The apx is also the bridge to the
  agent's stores (D18) and distilled programs (D22).

- **D21 — memory (`MEM`)** — the directive that tells an agent to
  remember an event, to act on it directly the next time: `MEM <event>`,
  at a force level (D11), optionally shaped by a template (D35). The
  memory is the harness's own; the language states what is worth
  remembering. It is written in an agent, a role or a procedure (D16),
  never in a flow step (D24).

- **D22 — distillation (`DISTILL`)** — the line, set by the author
  inside a procedure (D16), that marks its reasoning as able to become a
  deterministic program (P7). The procedure's contract is the program's:
  input `LENS-IN` (D6), output `AS` (D35), required. The first execution
  produces the program — any language, JSON in, JSON out; every later
  execution runs it through the executable (D20), which checks both
  sides. The program's identity is a hash of the procedure and its
  contract, so an edit invalidates it. Levels (D11) say how binding
  writing the program is; an existing program is always used.

- **D23 — policy** — a set of invariants: `ALWAYS` and `NEVER` rules
  that hold across every task. Every policy an agent imports applies,
  cumulatively; none is weighed against convenience.

- **D24 — flow** — the ordered steps a team follows for one kind of
  work. Each `STEP` names who carries it out (`BY`, an agent or a team),
  what to do (`DO`), how much upstream context to pass (D25) and the
  template it hands over (D35); a step may put some of its actions under
  a condition (D36); `PARALLEL` groups steps that run at the same time;
  `RUN` carries out another flow; `IF` / `ELSE` and `UNTIL` put steps
  under a condition or in a loop (D37). A team's routing (D7) points
  each request at one flow. A step also holds directives at any force
  level (D11), except `DISTILL` (D22), which marks a procedure, and memory (`MEM`, D21), since the agent a step
  names with `BY` may have no memory in its harness — memory belongs to
  an agent, a role or a procedure. A directive is a rule of the step,
  never its action: a step needs at least one `DO` or `RUN`.

- **D25 — context mode** — how much upstream context a step's executor
  receives: `isolated` (only its own intent), `summary` (a synthesized
  digest, provenance preserved), `full` (all of it), `inherited` (a fork
  of the caller). Adapters render each mode as the harness's own
  delegation call.

- **D26 — trigger** — `WHEN <condition>:` scopes a workflow to the
  moment its condition holds. Lifecycle hooks (`ON-INVOKE`,
  `ON-AGENT-PROMPTED`, `ON-TASK-COMPLETED`, `ON-ERROR`, `ON-DELEGATE`)
  are fixed triggers written as a single keyword.

- **D27 — control flow** — `IF` / `ELSE` branch, `UNTIL` repeats until
  its condition holds, `RUN` carries out a procedure or a flow by name.
  Structure is indentation: a construct's body is what sits beneath it.
  An `ELSE` is the second branch of the `IF` right before it in the same
  body, never a line of its own. Inside a flow step, only the branch is
  admitted (D36); around a flow's steps, both are (D37).

- **D28 — mandate** — `MANDATE`: the one statement of what an agent is
  responsible for, distinct from how it behaves.

- **D29 — perimeter** — `OWNS <globs>`: the files an agent may write.
  Its definition opens with a scope warning; outside the perimeter
  belongs to other agents.

- **D30 — export and namespace** — a block is local to its file unless
  marked `EXPORT`; exported blocks live in libraries and are reached by
  namespace: `@main` (the project library), an alias per shared
  library, `@user` (the author's global library), `@builtin` (the one
  shipped with the compiler). A reference resolves to exactly one block
  or the compilation fails.

- **D31 — tags** — `TAGS #a #b`: the labels that group blocks — under a
  common heading in the compiled definition, under a filter in the
  executable — and link blocks that share them.

- **D32 — variable** — a named value, read as `{{name}}`. A
  constant, `VAR <name> = <value>`, is declared in `vars.ap` at the
  project, team or agent level and substituted at compile time; when the
  same name is declared at several levels, the agent's overrides the
  team's, which overrides the project's. A constant takes no scope word:
  `SESSION VAR <name> = <value>` fails the compilation. A session
  variable (D38) gets its value at run time and is declared once: a
  second declaration fails the compilation. Variables carry
  configuration, never secrets: those stay in the environment. (Amended
  in 1.2.)

- **D33 — project context** — `PROJECT.ap`: the rules every agent of a
  project follows, compiled with the orchestration of every standalone
  agent and team into the project's `AGENTS.md`, the file every harness
  reads.

- **D34 — tool** — a capability described to the agent, with the
  instructions to use it; imported like any other block.

- **D35 — shape** — `AS <template>`: the binding of a result to a
  template, at a force level (D11) — an agent's answer, a procedure's
  result, what a step hands its executor, the structure of a memory.

- **D36 — step branch** — a flow step (D24) may hold `IF <condition>:`
  and a bare `ELSE`; under them sit only `DO` and `RUN` lines and the
  step's directives (D24) — no `AS`, which belongs to the signature, and,
  as in the step itself, no `DISTILL` and no `MEM`.
  The branch is transparent: its lines are the step's own, so a
  step whose every action sits under an `IF` still has its action. The
  step's signature — `BY`, `CONTEXT`, `AS` — stays unconditional, and a
  branch holds no further `IF`. Conditions and loops around whole steps
  belong to the flow (D37). (Added in 1.1.)

- **D37 — flow control** — a flow (D24) may hold `IF <condition>:`, its
  `ELSE` and `UNTIL <condition>:` around its steps. Under them sit what
  the flow itself holds — `STEP`, `PARALLEL`, `RUN` — and further `IF`,
  `ELSE` and `UNTIL`, nested at any depth. A step under them is the
  flow's own: a flow whose only step sits under an `UNTIL` still has its
  step, while a lone `RUN` is not a step. The condition is prose, judged
  by whoever runs the flow unless it is checked (D39); the language adds
  no syntax for it and sets no bound on an unchecked `UNTIL` — a bound,
  when wanted, is written in the condition. (Added in 1.1; amended in
  1.2.)

- **D38 — session variable** — a variable (D32) whose value is set while
  a session runs, its scope written as a word before `VAR`, as `EXPORT`
  before a block. With no word, `VAR <name>` or `VAR <name> AS
  <template>` is private: seen only by the agent that declares it, in its
  own `vars.ap` or in an agent, role or procedure body — a procedure's
  private variable belongs to the agent running it. `SESSION VAR <name>`,
  optionally `AS <template>`, is seen by every agent of the project and
  is declared only in a team or project `vars.ap`, so that every reader
  sees the declaration at compile time. `GLOBAL` — every agent, every
  session, persisted — is reserved: this version refuses it at
  compilation. An agent never sees a private and a `SESSION` variable of
  the same name. `INTO <name>` at the end of a `DO` line puts the
  action's result into a variable of either scope, and reassigns it — in
  a loop too — without redeclaring it. The block form `VAR <name>:`
  assigns a variable already declared in a `vars.ap` the agent reads, and
  otherwise declares a private one; `VAR <name> AS <template>:` always
  declares. The block holds, beneath, any lines of a procedure body
  (D16) — `DO`, `RUN`, `IF` / `ELSE`, `UNTIL` — but no further `VAR`; its
  value is the block's final outcome, a procedure's result included. A
  variable declared `AS <template>` keeps that type for life: it gives the
  line or block that fills it its shape (D35), and a value of another
  template fails the compilation; an untyped variable takes the type of
  its first typed assignment. `{{name}}` reads the value whole; `{{name
  AS <template>}}`, with no force level, reads it shaped as that
  template — the plain read when the variable already has that type,
  otherwise the agent takes from the value only what fits the template,
  and nothing is stored. A constant takes no shape: `{{name AS
  <template>}}` on a constant fails the compilation. The executable
  (D20) keeps the values in a builtin session store (D18), keyed by name
  — private values per session and agent, `SESSION` values per session,
  shared by every agent; the last write wins. The session id comes from
  the harness adapter (D8); without it the executable refuses. A block of
  a shared or builtin library (D30) never reads a session variable (P4):
  it takes its input through `LENS-IN` (D6). (Added in 1.2.)

- **D39 — checked condition** — an `IF` or `UNTIL` (D27) whose head
  carries the marks of the force levels (D11) hands its condition to an
  outside judge, a model that answers with a probability. Unmarked, the
  agent decides. With `!`, the agent sees the condition and the judge
  decides, winning when they disagree. With `!!`, the condition is
  sealed — never in the agent's prompt nor in any view of the executable
  (D20); the judge decides and the agent hears only open or closed.
  `!IF` and `!UNTIL` fail the compilation. A checked condition reads at
  least one session variable (D38): the judge's state is each variable
  read, exactly as the executable stored it, and `{{name AS <template>}}`
  sends the whole value with the template's fields as guidance in the
  question. The question is built from the source at compile time, kept
  in the executable and asked through `check <cnd-id>`. The judge is
  configured under the key `checks` — its adapter, a threshold (0.7 by
  default) and a number of rounds (3 by default); without it, a `!`
  condition falls back to an unmarked one with a warning and a `!!`
  condition fails the compilation. In doubt the condition is closed: a
  probability below the threshold, an uncertain answer, an unreachable
  judge, a state too large or an empty variable all close it, and a
  checked `UNTIL` stops after its last round with the condition closed.
  Every check is recorded in the session. (Added in 1.2.)

## 4. Citation

External works referencing this specification should use the stable
identifiers defined above. Examples:

- `Agent Pack §P7` — reasoning distills into code
- `Agent Pack §D22` — the distillation primitive (`DISTILL`)
- `Agent Pack §D20` — the executable agent (apx)
- `Agent Pack §P4 + §D4` — explicit composition and its operator

Identifiers are append-only: new principles or primitives may be added
in future revisions, but existing IDs must never be reassigned. A
deprecated ID is marked deprecated; it is not reused.

## 5. Authorship and License

The Agent Pack paradigm, its language and this specification were
created by **Giuseppe Federico**. The specification was first written
in May 2026; this version 1.2 dates from October 2026.

Its text is released under the Creative Commons
Attribution-NoDerivatives 4.0 International license — see
[`LICENSE-spec`](./LICENSE-spec) and [`NOTICE`](./NOTICE). It may be
shared, quoted and implemented freely; modified versions of it may not
be distributed. The specification exists in one version: this one.

The license protects the original expression of the principles,
trade-offs, and primitive definitions as written here. It does not
claim ownership over the abstract ideas or concepts they describe;
those remain free for anyone to reach independently.

Required attribution for any redistribution or reference of this
specification, and for any work based on Agent Pack:

> *"Based on the Agent Pack paradigm by Giuseppe Federico (2026)."*
