# Language

An `.ap` file is a sequence of **blocks**. A block opens with its kind and its name, and its body is indented under it:

```
EXPORT POLICY security:
    ABOUT   baseline security rules
    NEVER   commit credentials, .env files or private keys
```

- `EXPORT` makes a block importable by other files. Without it, the block belongs to the file it is written in.
- A line starting with `#` at the top of a file is a title, for the reader.
- Names are lowercase words joined by dashes (`verify-claim`) — variable names too (`{{best-pizza}}`). Every block gets a stable id from its kind, library and name.
- Nothing compiles quietly: a word the language does not have, a level a keyword does not declare (`MEM!!!`), a value outside its set (`CONTEXT isolatd`), a name that points at no block, an undeclared `{{variable}}`, an `INTO` naming no variable — each fails the build, with its file and line, and a suggestion when a keyword is misspelled.

## Blocks

### AGENT

```
EXPORT AGENT reviewer AS code-reviewer:
    ABOUT     Reviews a change for bugs and duplicated logic, never edits the code
    MANDATE   review the change the user points at and report what to fix
    OWNS      src/**
    LENS-IN   review-request
    LENS-OUT  review-report
    NEVER     edit the files under review
    WHEN asked to review a change:
        RUN   review-change
```

One agent per file, anywhere under `agents/`.

| Line | |
|---|---|
| `AS <role>` | the role the agent embodies — its identity |
| `ABOUT` | one line: what the agent is for — also its description in the harness and in the orchestration |
| `MANDATE` | what it is responsible for |
| `OWNS <globs>` | the files it may write; the definition opens with a perimeter warning |
| `LENS-IN <template>` | the shape requests to it arrive in |
| `LENS-OUT <template>` | the shape of its answers |
| rules and `WHEN` workflows | its own behaviour — rules at every level, `SHOULD`, `MAY` and [`MEM`](#memory) included (see [Rules](#rules)), and [Control flow](#control-flow); `ASK` and `COMPUTE` lines hand a line to a delegate or a program (see [Executors](#executors)) |

### SKILL

```
EXPORT SKILL pdf-report AS reporter:
    ABOUT    Turns a PDF into a short report
    APPLIES  #reports
    MANDATE  read the PDF and report its tables
    MUST     quote every table as CSV
```

A skill is an agent in every respect — the same lines, the same compilation, its own apx — that the adapter writes as a skill of the harness instead of a subagent (`.claude/skills/<name>/SKILL.md`, `.junie/skills/<name>/SKILL.md`). It lives in the project library, under `skills/`; `bundle all` builds every one. Its `ABOUT` is the description the harness picks it by. Its `APPLIES` line — its own, never its role's — gives its tags and, like a [policy](#policy)'s, where it holds. An agent uses it by importing it — see [Skills](#skills).

### ROLE

```
ROLE code-reviewer:
    ABOUT      a careful reviewer who reads before judging
    EXPERTISE  code-review refactoring
    ALWAYS     quote the line a finding is about
    NEVER      report a style preference as a bug
```

A way of thinking and acting. The role an agent is bound to with `AS` becomes the opening of its identity — *You are: **code reviewer** — a careful reviewer who reads before judging — with expertise in **code-review**, **refactoring***. Other imported roles apply together with it.

A role can extend another with `EXTENDS <parent>`: the parent's rules — looked up in the role's own folder, then in `roles/` of every library — come first, then the role's own. A parent that cannot be found, or a chain that loops back, fails the compilation.

### POLICY

```
EXPORT POLICY security:
    ABOUT   baseline security rules every agent in this project respects
    APPLIES #baseline universal
    ALWAYS  validate every input crossing a trust boundary
    NEVER   commit credentials, .env files or private keys
```

Invariants: only `ALWAYS` and `NEVER` rules. A policy holds where its scope says, and every policy that holds applies, cumulatively. The scope is on its `APPLIES` line:

| `APPLIES` | the policy holds |
|---|---|
| `universal` | everywhere it is imported |
| `team:<team>` | in the members of that team that import it |
| `agent:<agent>` | in that agent, when it imports it |
| tags only, or no `APPLIES` | only in the lines a [`WITH`](#with) names it for |

A policy imported where it holds nowhere — no perimeter and no `WITH` naming it — fails the build. In the compiled definition every policy opens with the line that says where it applies.

### TEMPLATE

```
EXPORT TEMPLATE finding:
    ABOUT  one claim of the answer, backed by its sources
    SLOTS:
        claim:       TEXT MAX_WORDS 30   "the claim, stated as fact or labelled as opinion"
        confidence:  ENUM[high low]      "high = two independent sources agree"
        sources:     TEXT                "each source as <url> (<publication date>)"
            MUST  give a publication date for every source
        note?:       TEXT                "anything the reader should know"
    BODY:
        - {claim} [{confidence}] — {sources}
    EXAMPLE:
        - Paris hosted the 2024 Olympics [high] — https://olympics.com (2024-08-11)
```

A typed answer format. `SLOTS` declares the fields — `name?:` makes one optional, rules indented under a slot constrain it; `BODY` is the literal layout, with `{slot}` placeholders; `EXAMPLE` shows a filled instance.

| Slot type | |
|---|---|
| `TEXT` | free text — `MAX_WORDS n`, `MIN_WORDS n`, `REGEX /p/` |
| `NUMBER` | a number — `a..b`, `>=n`, `<=n` |
| `ENUM[a b c]` | one of the listed values |
| `<template>` | one instance of another template |
| `LIST <template>` | several instances — `>=n`, `a..b` |

Any other type is a compile error.

An answer is bound to a template with `AS` (see [Shapes](#shapes)).

### PROCEDURE

```
PROCEDURE verify-claim:
    ABOUT  back one claim with independent sources before it enters the brief
    DO     search for the claim and read the most authoritative result
    NEVER  count two pages that quote the same origin as two sources
    UNTIL  the claim has two independent sources, or no new source turns up
      DO   search again with different terms and read one more source
    IF     the sources disagree
      DO   add the conflict, with both sources, to the open questions
    ELSE
      DO   write the finding
    AS     finding
```

Reusable steps, invoked with `RUN verify-claim` from an agent, a role, another procedure or a flow. Besides `DO` and `RUN`, a procedure takes [rule](#rules) lines — `MUST`, `NEVER`, `SHOULD`, … — at its top and under its `IF`/`ELSE` and `UNTIL`: write `NEVER …`, not `DO never …`. `AS <template>` is the shape of its result; `LENS-IN <template>` the shape of its input, when it has one. `PROCEDURE* <name>:` hands the whole procedure to a delegate, `PROCEDURE** <name>:` to a program — see [Executors](#executors).

### COMPUTE

```
EXPORT COMPUTE dose:
    ABOUT  pediatric dose by body weight
    NEVER  read a file, the network or the clock
    REQUIRE:
        MUST  {{weight_kg}} be between 2 and 80, bounds included
    RETURN AS dose-result:
        DO    mg = {{weight_kg}} × {{mg_per_kg}}
        DO    ml = mg / {{mg_per_ml}}
    ENSURE:
        MUST  ml be rounded half up to 2 decimals
```

A procedure a program carries out — a `PROCEDURE**` written as a specification. Called with `RUN dose`, imported like any procedure (it lives in `procedures/`). Rule lines on top say how the program is written; then three sections, all required, each holding at least one line, in this order:

| Section | |
|---|---|
| `REQUIRE:` | when the program refuses its input — it stops with exit `1`, and the procedure stops with it. Only rules and `IF` |
| `RETURN AS <template>:` | the computation, and the template its result is shaped as (no force level: the result is always checked). `DO`, `COMPUTE`, `IF`, `UNTIL` and rules — never `ASK` |
| `ENSURE:` | the guarantees on the result — they become the program's tests. Only rules and `IF` |

A section out of order, repeated, empty or missing fails the compilation; `REQUIRE`, `RETURN` and `ENSURE` stand only in a `COMPUTE` block. How the program is written and run: [Programs](#programs).

### STORE

```
EXPORT STORE notes:
    ABOUT  working notes kept between sessions
    TYPE   tabeli
    LASTS  project
    KEY    topic
    SLOTS:
        topic:  TEXT MAX_WORDS 1   "the one word the note is filed under"
        note:   TEXT MAX_WORDS 30  "what is known about the topic"
```

The data an agent keeps, declared like a schema. `TYPE` names the backing (`tabeli`); `LASTS project` survives between sessions, `LASTS session` lasts one; `KEY` names the slot that identifies a record — adding a record with an existing key updates it. `LASTS` takes `project` or `session`, and `KEY` must name one of the slots. A tabeli record is flat: its slot names use letters, digits and `_` (`vat_number`), and hold no nested template — the compiler refuses anything else, and the apx refuses a write outside the schema (an unknown field, a missing required one, a value outside its type). The agent works in a store inside an `IN` block:

```
    WHEN asked to remember something:
        IN notes:
            DO  add the record when its topic is not there yet
```

Stores are read and written through the agent's [apx](/guide/apx#stores). A store may not be named like one of the [apx's verbs](/guide/apx#reading): the apx reads that word as the verb, so the store could never be reached.

### FLOW

Written in a team's `flows.ap`. See [Teams and flows](/guide/teams-and-flows).

```
FLOW complex-task:
    STEP implement end-to-end:
        BY senior
        DO implement the change and run the tests
    STEP review:
        BY reviewer
        CONTEXT full
        AS review-request
        DO review the change for duplicated logic
```

| Line | |
|---|---|
| `STEP <title>:` | one step, in order |
| `BY <agent or team>` | who carries it out |
| `CONTEXT isolated \| summary \| full \| inherited` | how much upstream context the step's agent receives |
| `AS <template>` | the shape of what is handed to the step's agent |
| `DO` | what to do |
| `MUST`, `NEVER`, `SHOULD`, … | a [rule](#rules) of the step — `NEVER skip a finding`, not `DO never skip a finding`; never `MEM` |
| `IF <condition>:` / `ELSE` | the `DO`, `RUN` and rule lines indented under it apply only when the condition holds (or, under `ELSE`, when it does not); `BY`, `CONTEXT` and `AS` stay unconditional |
| `PARALLEL` | the steps indented under it run at the same time |

A flow itself may put its `STEP`, `PARALLEL` and `RUN` lines under `IF <condition>:` and its `ELSE`, or repeat them under `UNTIL <condition>:`, and nest further `IF`/`ELSE`/`UNTIL` inside them. The condition is prose, judged by whoever runs the flow; an `UNTIL` takes no mandatory bound — write it in the condition when there is one.

```
FLOW build-change:
    STEP write the plan:
        BY planner
        DO write the implementation plan
    UNTIL the audit says pass or fail — three revisions at most:
        STEP revise the plan:
            BY planner
            DO amend the plan to close every gap the audit lists
    IF the audit says pass:
        RUN deliver-task
```

A flow needs at least one `STEP`, directly or under its `IF`/`ELSE`/`UNTIL`. A flow in a team's `flows.ap` is checked like one in a flow file.

A step needs at least one `DO` or `RUN`, directly or under its `IF`/`ELSE`: a rule line says how to act, never what to do.

A step takes no `MEM`, nor do its `IF`/`ELSE` branches: the agent its `BY` names may have no memory in its harness.

## Rules

A rule is a keyword and an action. The keyword says how binding it is:

| Write | Reads as |
|---|---|
| `MAY` | You may |
| `SHOULD` | You should |
| `SHOULD!` | You should — strongly recommended, skipped only with explicit justification |
| `SHOULD-NOT` | You should not |
| `MUST` | You must |
| `MUST!` | [HARD CONSTRAINT] You must — non-negotiable |
| `MUST!!`, `NON-NEGOTIABLE` | [IDENTITY CONSTRAINT] before any other action, no exceptions |
| `!MUST`, `MUST-NOT` | You must not |
| `ALWAYS` | You must always |
| `NEVER` | You must never |
| `DO` | a step the agent carries out |
| `ASK` | a step a delegate carries out — see [Executors](#executors) |
| `COMPUTE` | a step a program carries out — see [Executors](#executors) |

A level is written with its keyword — `NEVER skip a finding`, `ALWAYS cite the line` — never as `DO never …` or `DO always …`.

## Memory

`MEM <event>` tells the agent to save an event to its persistent memory, to act on it directly the next time instead of working it out again. It is a rule like any other — in an agent, a role, a procedure or a `WHEN`, never in a flow step — with the same levels:

| Write | Reads as |
|---|---|
| `MEM` | You may save to your persistent memory, to act on it directly next time |
| `MEM!` | You should save … |
| `MEM!!` | You must always save … |
| `!MEM` | Never save to your persistent memory |

```
EXPORT AGENT reviewer AS code-reviewer:
    MEM!!  the user rejects a finding as intended behaviour
    !MEM   credentials, tokens or secrets
    WHEN the project profile is confirmed:
        MEM  the confirmed project profile
            AS project-profile
```

An `AS <template>` line beneath `MEM` gives the memory a shape: *… the confirmed project profile — shaped as `project-profile`*.

The memory is the harness's own. With Claude Code, an agent that uses `MEM` gets `memory: project` in its frontmatter: Claude Code gives it a memory directory (`.claude/agent-memory/<agent>/`) and loads its `MEMORY.md` at every start.

## Executors

Every line is carried out by one of three executors. The verb says which:

| Write | Carried out by |
|---|---|
| `DO <action>` | the agent itself |
| `ASK <action>` | a delegate — another agent, handed the line's inputs and nothing else |
| `COMPUTE <action>` | a program — a script: same input, same output, every time |

On a block head, stars say the same:

| Write | |
|---|---|
| `PROCEDURE <name>:`, `IF`, `UNTIL` | the agent |
| `PROCEDURE* <name>:` | a delegate carries out the whole procedure |
| `PROCEDURE** <name>:` | a program carries it out ([`COMPUTE <name>:`](#compute) is one, written as a specification) |
| `IF* <condition>`, `UNTIL* <condition>` | a delegate decides the condition |
| `IF** <condition>`, `UNTIL** <condition>` | a program decides it |

```
VAR pdf_text
VAR contract
VAR lines AS invoice-lines
VAR risks
VAR totals
VAR document_total

WHEN an invoice arrives:
    ASK      read the invoice lines from {{pdf_text}} INTO lines
    ASK      check the clauses of {{contract}} INTO risks BY legal-reviewer
    COMPUTE  group {{lines}} by VAT rate INTO totals
    IF** {{totals}} differ from {{document_total}} by more than 0.01:
        DO   tell the user which rates do not add up
```

- **On a procedure, the mark covers the body**: its lines inherit the executor. **On an `IF` or an `UNTIL`, it covers only the condition**: the lines beneath inherit the enclosing block's executor — and an unmarked `IF` inside a `PROCEDURE**` is decided by the program too.
- **A line may raise its executor, never lower it** — agent, then delegate, then program. Under a `PROCEDURE**`, an `ASK`, an `IF*`, or a `RUN` of anything but a `PROCEDURE**` fails the compilation: a program cannot stop for the agent; under a `PROCEDURE*`, a `RUN` takes only a `PROCEDURE*` or a `PROCEDURE**`. A [checked condition](#checked-conditions) (`IF!`) inside a starred procedure is an error: its executor decides its conditions.
- **A condition has one judge.** `IF!`/`IF!!` are decided by a judge, `IF*`/`IF**` by a delegate or a program: `IF!*` or `UNTIL**!` is an error. A starred condition reads at least one variable — its only input.

**What a delegate or a program receives is its input, and nothing else.** One key per `{{variable}}` the piece reads, with its value in the session; one per constant, with its value; and `in`, the input of a procedure that declares a `LENS-IN`. An empty variable stops the piece before it starts. Its answer is checked against its contract: a line with `INTO x` answers a value of `x`'s type, a procedure its `AS` template, a condition `{"holds": true}` or `{"holds": false}`. Each piece gets a contract id, `exe-<8 hex>`, and the compiled line names the apx command that carries it out — `input` and `answer` for a delegate, `run` for a program (see [The apx](/guide/apx#delegates-and-programs)):

```
Ask a delegate to read the invoice lines from `pdf_text` — delegate: `quick` — hand it over its input and the shape of its answer, both from `node .agent-pack/apx/clerk.apx input exe-…`, then store its answer: `node .agent-pack/apx/clerk.apx answer exe-… -`
If `totals` differ from `document_total` by more than 0.01 — a program decides — `node .agent-pack/apx/clerk.apx run exe-…`
```

### ASK and BY

`ASK … BY <agent>` names who the line is handed to: a standalone agent, a team (its routing picks the member), or a member of the asking agent's own team. A member of another team, or a name the project does not have, fails the compilation. `BY` ends the line, after the `INTO`: `ASK … INTO risks BY legal-reviewer` (`BY … INTO …` is an error). Only `ASK` takes a `BY` — a `COMPUTE` is a program's.

Without `BY`, the line goes to the **default delegate**, `quick`: a builtin agent that answers from the JSON input it is handed alone, as JSON in the shape the contract asks, saying what is missing when the input lacks it. `bundle all` builds it only when some agent hands it work and the project has no agent of that name. With Claude Code it runs on `haiku` and with no tool at all — it cannot read a file. The [`delegate`](/reference/config#delegate) key names another default and sets the model each agent runs on: the source never names a model.

### Programs

A program is written by the agent, the first time it is needed: `apx run` answers that there is no program yet, where to write it, and how — the builtin procedure `write-program`, imported by every agent a program works for. It lives at the project root, versioned with the sources:

```
distilled/dst-1a2b3c4d/
    manifest.json   {"version": 1, "lineage": "…", "timeout_ms": 2000}
    script.py       a #! line, JSON in on stdin, JSON out on stdout, exit 1 with the reason on stderr to refuse
    tests.json      [{"why": "…", "input": {…}, "output": {…}}, {"why": "…", "input": {…}, "exit": 1}]
```

- **Any language**: `script.<ext>`, executable, with a `#!` line.
- **`tests.json`** holds the program's cases: an input and the output it must answer, or `"exit": 1` when it must refuse. Every `REQUIRE` line gives a refusal case, every `ENSURE` line cases that prove the guarantee, and each decision the block left open a case whose `why` starts with `CHOICE:` — so the choice is written down, for a reader to confirm.
- **A new or changed program runs its tests first**; the apx records the hash of the script and the tests (`tested` in the manifest) and runs them again only when either changes.
- **The folder** (`dst-` and eight hex digits) is a hash of what the piece carries out and of its contract's templates: editing either gives a new folder. The new version starts from the previous one — the manifests share a `lineage` (the procedure's address); the new one sets `version` + 1 and `previous`. `bundle all` lists the folders no piece owns any more, for you to review and delete; it never deletes them.
- Writing its programs is always inside an agent's perimeter (`OWNS` gains `distilled/**`).

A refusal (exit `1`) stops the procedure: the agent never carries the piece out itself. A program that does not answer in `timeout_ms` hands that one run to the agent, which says so.

### Rounds

An `UNTIL*` or `UNTIL**` asks its condition after each round, at most `rounds` times — the [`checks`](/reference/config#checks) key's `rounds`, 3 by default, as for `UNTIL!`. The apx says `round 2 of 3` after each closed answer, and at the limit — exit `7` — to stop and report that the condition never held.

## Control flow

| Construct | |
|---|---|
| `WHEN <condition>:` | a workflow: the indented lines apply when the condition holds |
| `IF <condition>` … `ELSE` | a branch; the indented lines are its body. An `ELSE` must come right after an `IF` in the same body |
| `UNTIL <condition>` | repeat the indented lines until the condition holds |
| `IF!` / `IF!!`, `UNTIL!` / `UNTIL!!` | the same, with the condition decided by a judge — see [Checked conditions](#checked-conditions) |
| `WHEN! <condition>:` | a trigger whose condition a judge decides — sugar for `WHEN <condition>:` with `IF! <condition>:` beneath — see [Checked conditions](#checked-conditions) |
| `IF*` / `IF**`, `UNTIL*` / `UNTIL**` | the same, with the condition decided by a delegate or a program — see [Executors](#executors) |
| `RUN <procedure or flow>` | carry out that procedure or flow |
| `RUN <procedure> INTO <name>` | carry it out, and store its result in a variable |
| `IN <store>:` | the indented lines work on that store |
| `VAR <name>:` | the indented lines work out a [variable](#variables): its value is their final outcome |
| `DO <action> INTO <name>` | do it, and store its result in a variable — `ASK` and `COMPUTE` take `INTO` too |

Lifecycle shorthands expand to a `WHEN`:

| Write | Means |
|---|---|
| `ON-INVOKE` | WHEN this agent is called |
| `ON-AGENT-PROMPTED` | WHEN the agent receives a new user prompt |
| `ON-TASK-COMPLETED` | WHEN the agent is about to declare the task complete |
| `ON-ERROR` | WHEN a step or tool call fails unexpectedly |
| `ON-DELEGATE` | WHEN the agent is about to delegate work to another agent |

## Checked conditions

The `!`s after `IF` or `UNTIL` say how little the agent is trusted with the condition:

| Write | The agent | Who decides |
|---|---|---|
| `IF <condition>` | sees the condition | the agent |
| `IF! <condition>` | sees the condition | a judge — when they disagree, the judge wins |
| `IF!! <condition>` | never sees it: the condition is **sealed** — in no prompt, in no view of the apx | a judge; the agent hears only *open* or *closed* |

`UNTIL!` and `UNTIL!!` are the same as a loop head: repeat the lines beneath until the judge opens the gate, at most `rounds` rounds (3 by default); at the limit the agent stops and reports that the gate stayed closed. A gate needs no keyword of its own: it is an `UNTIL` the judge decides, and a branch is an `IF` the judge decides. `ELSE` follows `IF!` and `IF!!` as it follows `IF`. `!IF` is an error.

**`WHEN!` is sugar.** `WHEN! <condition>:` is rewritten, before anything else reads the source, into `WHEN <condition>:` with `IF! <condition>:` beneath it and the trigger's lines under that — byte-identical to the hand-written pair. The agent still picks the moment, as for every `WHEN`; the judge decides the condition, as for every `IF!`, with the same rules: it reads at least one variable, it needs `checks` configured, it is checked by the agent whose apx answers for it. `WHEN!!` is an error: a sealed condition has no moment the agent could see, so a sealed trigger is written as a prose `WHEN <moment>:` with `IF!! <condition>:` beneath. `!WHEN` and `WHEN*` are errors too.

```
VAR request
WHEN! {{request}} submits one new idea, not a bug nor a task already decided:
    RUN shape-idea
```

reads as

```
VAR request
WHEN {{request}} submits one new idea, not a bug nor a task already decided:
    IF! {{request}} submits one new idea, not a bug nor a task already decided:
        RUN shape-idea
```

```
VAR report
WHEN asked to ship:
    DO  run the tests INTO report
    IF!! {{report}} shows every test passing:
        DO  tag the release
    ELSE
        DO  tell the user what failed
```

compiles into

```
If `node .agent-pack/apx/shipper.apx check cnd-95dbba72` answers open:
    Do tag the release
Else:
    Do tell the user what failed
```

**The judge decides on variables.** A checked condition reads at least one variable — `{{x}}`, private or `SESSION`, one the agent sees — or the compilation fails: the judge decides on what the variables hold, never on the agent's word. When the apx checks the condition, it builds the state from the session's memory: each variable the condition reads, in the order it first appears, as `### <name>` followed by its value exactly as stored (a typed one, its JSON text), a blank line between two. The agent cannot retouch it at check time. `{{x AS t}}` sends the whole value of `x`, and adds the fields of `t` (names and descriptions) to the question as guidance. A field read, `{{x.slot}}`, is an error, as anywhere. A constant `{{c}}` is written into the question at compile time.

**The question comes from the source.** The compiler builds it — `In the state, <condition>?`, each variable read by its name — and keeps it in the apx; the agent never writes it. Each checked condition has a stable id, `cnd-<8 hex>`, made from the agent that answers for it and the condition's text: editing the text makes a new condition.

**Closed when in doubt.** The judge answers with a probability. At or above the threshold (0.7 by default) the condition is *open*; below it — or when a variable it reads is empty, when the state is too large for the judge, or when the judge cannot be reached or gives no probability — it is *closed*, and nothing is sent when nothing can be decided. Every check is recorded in the session: the condition's id, the agent, the level, the round, a fingerprint of the state (never the state), the judge's model and probability, the threshold and the outcome. The agent's own opinion is never asked.

**Where a check is possible:** in an agent's body, in a procedure or role an agent runs, and in a flow step whose `BY` is an agent — wherever an apx can answer for it. Anywhere else — a standalone file, a team's routing — there is no executable: `IF!` and `UNTIL!` read as `IF` and `UNTIL`, decided by the agent, with a warning naming the line, and `IF!!` and `UNTIL!!` fail the compilation, since they could never be sealed there.

**In a flow step**, a checked `IF!` or `IF!!` is checked by the step's `BY` agent, through its own apx: the condition is compiled into that agent's apx, and `AGENTS.md`, `apx flow` and the Workflow script name its command. The variables it reads are the ones that agent sees — its own, or its team's `SESSION` ones. `BY` must name an agent — or the role a member takes, which names that member, as everywhere in a flow: a team is resolved by routing, and no one apx answers for the check. A checked condition at a flow's own level — between its steps, run by whoever drives the flow — is not supported yet.

**Configuration.** The judge of checked conditions is the [`checks`](/reference/config#checks) key, apart from the compile-time `judge`. Without it, `IF!` and `UNTIL!` compile as `IF` and `UNTIL` — decided by the agent — with a warning naming the line; `IF!!` and `UNTIL!!` fail the compilation.

What a check is, and is not:

- A sealed condition protects against an agent that follows its instructions, not against one that reads files by hand: the question is in the apx file, as the compiled document is.
- A judge checks the text the variables hold, not the facts behind it: "the tests pass" is judged on the report the agent stored. A condition about facts is a program's to decide: write it `IF**` — see [Executors](#executors).

## Shapes

`AS <template>` binds an answer to a template, at a strength:

| Write | Reads as |
|---|---|
| `AS` | Shape your response as |
| `AS!` | Strictly shape your response as — no deviation |
| `AS!!` | Shape your response to match exactly |
| `!AS` | Do not shape your response as |

On an agent, `LENS-OUT` sets the shape of every answer and `LENS-IN` the shape of every request it receives. In a procedure, `AS` is the shape of the procedure's result; in a flow step, of what the step's agent is handed.

On a `VAR`, `AS <template>` is the variable's type: it takes no force level (`VAR report AS! task-report` is an error), and it shapes — at the strength of `AS!` — every step that fills the variable. See [Variables](#types).

## Variables

A variable is a named value. A **constant** is fixed when the agent is compiled; a **variable** is filled while the agent works and read back later. The form of the `VAR` line says which:

| Write | Means |
|---|---|
| `EXPORT VAR board = Product` | a constant, exported by a module: `{{board}}` is replaced by `Product` at compile time |
| `VAR draft` | a variable, declared, still empty |
| `VAR report AS task-report` | a variable with a type: a template |
| `VAR draft:` + an indented block | declared and assigned: its value is the final outcome of the block |
| `VAR report AS task-report:` + an indented block | the same, typed |
| `DO <action> INTO draft` | assigns, or reassigns, a declared variable — so do `ASK`, `COMPUTE` and `RUN … INTO draft` |
| `{{draft}}` | reads it |

A variable is stored, and read back, only through the agent's [apx](/guide/apx#variables), which keeps the exact text stored — a later reader gets it verbatim, never a summary.

### Scope

A word before `VAR` says who sees a variable and how long it lives:

| Write | Who sees it | How long | Declared in |
|---|---|---|---|
| `VAR x` (no word: **private**) | only the agent that declares it | the session | the body of the agent, of a role or of a procedure — or a module, `EXPORT VAR x`, each agent that imports it having its own |
| `SESSION VAR x` | the session's agents that import it | the session | a module only: `EXPORT SESSION VAR x` |
| `GLOBAL VAR x` | every agent | every session | not available yet — an error today |

- **Private** is the default: there is no word for it. A private variable declared in a procedure or a role belongs to the agent that runs it — two agents running the same procedure each have their own. The same agent, called again in the same session, finds its own earlier values.
- **SESSION** is how agents hand work to each other: a planner stores the plan, an auditor reads it. It is exported once by a module — `agents/library/vars/<team>.ap`, say — and imported by every agent that reads or fills it, so each compiles with the same declaration. `SESSION VAR` or a constant in a body is an error: a module exports them.
- A scope word stands only right before `VAR`. A constant has no scope: `SESSION VAR x = v` is an error.

A session is the harness's: one conversation, with the agents it calls.

### Exporting and importing

A module of a library declares a variable on one top-level line, `EXPORT` in front:

```
# agents/library/vars/delivery.ap
EXPORT VAR board = Product
EXPORT SESSION VAR plan AS implementation-plan
EXPORT VAR draft
```

One line, no body, no `ABOUT`; a module may export several, next to its other blocks, each name once. A module declares, it never assigns: `EXPORT VAR x:` is an error, and so are lines indented beneath it. An agent's file and a team's `flows.ap` export no variable — they declare one in a body, or import it. A file sees a variable only when it declares it or imports it — `IMPORT plan, board FROM @main.vars`, resolved like any [import](#imports-and-tags): the exported name is matched, not the file's.

**Imports never pass on.** What a module imports, it alone sees: a procedure that imports `plan` reads `{{plan}}`, and the agent that imports the procedure does not — unless it imports `plan` too. Reading it anyway fails, naming the file that imports it. A team's `flows.ap` imports constants and `SESSION` variables (a private one would be each member's own): its flows read them in `AGENTS.md`, and each member that reads one imports it too.

Never put a secret in a constant: constants are compiled into the agent's output. Tools read secrets from the environment.

### Declaring once

A name is declared once for an agent, whatever its scope: a second declaration in any body is an error, the same name imported from two modules collides, and a private variable never takes the name of a `SESSION` variable the agent sees (no shadowing). **A name means one thing**: a variable or a constant never shares the name of a template the agent sees. A loop reassigns a variable with `INTO`, it never declares it again: `VAR` never stands inside an `UNTIL`, nor inside another `VAR` block, a flow step, a template, a store or a policy.

### Assigning

Every block is a value. `VAR <name>:` absorbs the block beneath it — `DO` lines, a `RUN`, an `IF`/`ELSE`, an `UNTIL`, rule lines, `IN <store>:`, `DO … INTO` another variable — and its value is the block's final outcome:

```
VAR verdict AS review-verdict:
    IF the claim has two independent sources
        DO  accept it, citing both
    ELSE
        DO  reject it, saying what is missing

VAR claim:
    RUN  verify-claim
```

**`VAR x:` assigns an imported variable.** In a body, `VAR x:` normally declares a private `x` and assigns it. When the agent imports `x` — a `SESSION` variable, or an exported private one — `VAR x:` only assigns it: it declares nothing. This is how a procedure's result goes into a shared variable (`VAR plan:` with `RUN make-plan` beneath). It takes no `AS` there: the type is the declaration's — `VAR plan AS x:` would declare `plan` again, an error.

A single step registers its result with a trailing `INTO <name>`, on a `DO`, `ASK`, `COMPUTE` or `RUN` line only — uppercase, at the very end of the line (before an `ASK`'s `BY`); anywhere else, `into` is plain text:

```
VAR summary
DO  sum up the findings in one paragraph INTO summary
```

`RUN verify-claim INTO claim` stores the procedure's result in `claim`, like `VAR claim:` with `RUN verify-claim` beneath; when a delegate or a program carries the procedure out, the apx stores it (`run … --into claim`). `VAR x = …` never opens a block, even when its value ends with `:`; `VAR x` followed by indented lines is missing its `:`. The target of an `INTO` must be a declared variable — never a constant.

### Types

A variable has one type for its whole life. `VAR report AS task-report` declares it; `VAR claim:` with `RUN verify-claim` beneath takes the type of the procedure's result (its `AS`). A block whose type differs from the declared one, or an `IF` and an `ELSE` yielding different types, fail the compilation. A typed variable shapes the step that fills it: the compiled text tells that step to shape its result as the template, and the apx refuses to store a value that is not JSON with the template's fields.

### Reading

`{{name}}` reads a variable, in any line. A constant's read is its value; a variable's read compiles into the command that prints its value (`node .agent-pack/apx/<agent>.apx get <name>`). Reading a field of a typed variable (`{{report.status}}`) is not supported yet. A read of a name the agent neither declares nor imports fails the compilation — and when the name is a template's, the error says so: declare `VAR <name> AS <template>` and read that.

A read can take a shape: `{{name AS template}}` reads the variable and keeps only what fits the template, shaped as it:

```
DO  compare {{report AS dividend-table}} with last year's
```

The agent does the extracting, when it reads: it runs the same `get` and takes from the value what the template asks for — nothing is stored, the variable keeps its value. When the variable is already typed with that template, the shaped read is a plain read. The name is a variable, never a constant (a constant has no shape to take — write the part you need); the template is one the agent has, like any `AS` template; `AS` takes no force level (`{{report AS! dividend-table}}` is an error). A shaped read stands wherever a read does — a `DO` line, an `IF` or `UNTIL` condition — under the same rules. A template's `BODY` and `EXAMPLE` are literal text: no `{{…}}` there. A comment line is never read. A block of a shared or builtin library reads no variable — a library block takes its input through `LENS-IN`; constants it may read.

### Examples

A private draft, in an agent's body:

```
EXPORT AGENT writer AS technical-writer:
    ABOUT    writes the release notes
    MANDATE  turn the changes into notes a user reads in one minute

    WHEN asked for the release notes:
        VAR draft:
            DO  list the user-visible changes since the last tag
            DO  write one sentence per change
        DO  shorten {{draft}} to the five changes that matter INTO draft
```

A plan shared by a team — exported once, by a module:

```
# agents/library/vars/delivery.ap
EXPORT SESSION VAR plan AS implementation-plan
```

the planner fills it with its procedure's result, and the auditor reads it — each imports it:

```
# planner.ap
IMPORT plan FROM @main.vars
    …
    WHEN a request arrives:
        VAR plan:
            RUN  write-plan

# goal-auditor.ap
IMPORT plan FROM @main.vars
    …
    WHEN the plan is ready:
        DO  audit {{plan}} against the goal, from the goal backwards
```

## Imports and tags

```
IMPORT security, privacy FROM @main.policies
IMPORT review-report FROM @main.templates.review
IMPORT plan, board FROM @main.vars
```

`@main` is the project library; shared libraries have their own alias. See [Configuration](/reference/config#libraries).

`APPLIES #board #planning` tags a block: in the compiled definition, blocks sharing tags sit under a common heading, the apx filters by them (`ls tag=board`, or `tag=#board`), and a [`WITH #policy:board:`](#with) (or `#skill:board`) selects every imported policy (or skill) that carries the tag. On a policy or a skill, `APPLIES` also takes its perimeter — `universal`, `team:<team>`, `agent:<agent>` (see [POLICY](#policy)); on any other block a perimeter fails the build.

## Skills

An agent imports the skills it may use: a [`SKILL`](#skill) of the project library, or a skill the harness provides itself.

```
IMPORT pdf-report FROM @main.skills
IMPORT pdf, frontend-design:frontend-design FROM @harness.skills
```

`@harness.skills` is reserved: agent-pack neither compiles nor writes those skills — the adapter tells the agent how its harness loads them (Claude Code: the Skill tool). The name is written as the harness knows it.

**A skill holds where its scope says — like a policy.** An imported skill is listed in the agent's *Skills* chapter with its scope line and how to load it — run its apx, or ask the harness. With `universal`, `team:<team>` or `agent:<agent>` on its `APPLIES` line it holds there; otherwise only in the lines a [`WITH`](#with) names it for. A skill imported where it holds nowhere fails the build; a skill of `@harness.skills` has no `APPLIES` line, so a `WITH` names it. Its own body stays in its apx: it is loaded when it is needed, never with the agent.

### WITH

**`WITH` says which work skills and policies are for.** It is a block: the lines nested below it are under the skills and policies it names — by name, or by a tag with its kind (`#policy:<tag>`, `#skill:<tag>`), comma separated.

```
EXPORT PROCEDURE reasoning:
    ABOUT  reason a decision out with the developer
    WITH developer-reasons-first:
        UNTIL the developer has a solution:
            DO  ask one question that helps the developer reason it out

    WITH pdf-report AS report:
        IF the input is a text PDF:
            MUST extract every table as CSV

    !WITH pdf, #skill:scanning:
        IF the input is a scanned image:
            MUST run OCR with the project script
```

| Head | |
|---|---|
| `WITH <name>, #policy:<tag>, #skill:<tag>:` | the lines below are under these skills and policies |
| `WITH <skill> AS <template>:` | and the skill's answer is shaped as the template |
| `!WITH <name>, #policy:<tag>:` | the lines below are out of them |

`#policy:<tag>` selects every imported policy whose `APPLIES` line carries `#<tag>`, `#skill:<tag>` every such skill; the compiler writes their names, each with its id, in place of the tag. A tag without its kind, and a name or a tag that selects nothing, fail the build. `AS` shapes the answer of one skill — named, never a policy or a tag — and never on `!WITH`.

`WITH` stands in a body — an agent, a role, a procedure — around the lines it is for; first in a procedure's body, it covers the whole procedure, and whoever imports the procedure gets it with it. Its zone holds lines, never a block, and a flow step takes none — its `BY` agent uses what it imports. It reads the same in `PROJECT.ap`, whose `AGENTS.md` lists the skills it imports in its own *Skills* chapter.

`!WITH` is an instruction to the agent: a skill the harness triggers on its own description may still be offered, the agent is told not to use it there; a policy that holds everywhere does not hold there.
