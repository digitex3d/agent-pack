# Language

An `.ap` file is a sequence of **blocks**. A block opens with its kind and its name, and its body is indented under it:

```
EXPORT POLICY security:
    ABOUT   baseline security rules
    NEVER   commit credentials, .env files or private keys
```

- `EXPORT` makes a block importable by other files. Without it, the block belongs to the file it is written in.
- A line starting with `#` at the top of a file is a title, for the reader.
- Names are lowercase words joined by dashes (`verify-claim`). Every block gets a stable id from its kind, library and name.
- Nothing compiles quietly: a word the language does not have, a level a keyword does not declare (`MEM!!!`), a value outside its set (`CONTEXT isolatd`), a name that points at no block, an undeclared `{{variable}}` — each fails the build, with its file and line, and a suggestion when a keyword is misspelled.

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
| rules and `WHEN` workflows | its own behaviour — rules at every level, `SHOULD`, `MAY` and [`MEM`](#memory) included (see [Rules](#rules)), and [Control flow](#control-flow); never `DISTILL`, which marks a procedure |

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
    TAGS    #baseline
    ALWAYS  validate every input crossing a trust boundary
    NEVER   commit credentials, .env files or private keys
```

Invariants: only `ALWAYS` and `NEVER` rules. Every policy an agent imports applies, cumulatively.

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

Reusable steps, invoked with `RUN verify-claim` from an agent, a role, another procedure or a flow. Besides `DO` and `RUN`, a procedure takes [rule](#rules) lines — `MUST`, `NEVER`, `SHOULD`, … — at its top and under its `IF`/`ELSE` and `UNTIL`: write `NEVER …`, not `DO never …`. `AS <template>` is the shape of its result; `LENS-IN <template>` the shape of its input, when it has one. A procedure that always gives the same result for the same input can be [distilled](#distillation) into a script.

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

Stores are read and written through the agent's [apx](/guide/apx#stores).

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
| `MUST`, `NEVER`, `SHOULD`, … | a [rule](#rules) of the step — `NEVER skip a finding`, not `DO never skip a finding`; never `MEM` or `DISTILL` |
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

A step takes no `MEM`, nor do its `IF`/`ELSE` branches: the agent its `BY` names may have no memory in its harness. `DISTILL` marks a procedure, never a step.

## Rules

A rule is a keyword and an action. The keyword says how binding it is:

| Write | Reads as |
|---|---|
| `MAY` | You may |
| `SHOULD` | You should |
| `SHOULD!` | You should — strongly recommended, skipped only with explicit justification |
| `MUST` | You must |
| `MUST!` | [HARD CONSTRAINT] You must — non-negotiable |
| `MUST!!`, `NON-NEGOTIABLE` | [IDENTITY CONSTRAINT] before any other action, no exceptions |
| `!MUST`, `MUST-NOT` | You must not |
| `ALWAYS` | You must always |
| `NEVER` | You must never |
| `DO` | a step to carry out |

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

## Distillation

`DISTILL`, a line inside a procedure, marks its reasoning as distillable into a deterministic script: the first time an agent carries the procedure out, it also writes a program that reproduces it, and from then on the program does the work — no reasoning, same result every time.

```
PROCEDURE compute-totals:
    ABOUT     add up an invoice
    LENS-IN   invoice
    AS        totals
    DISTILL!!
    DO        add net, VAT and gross from the invoice lines
```

Each line says one thing: `LENS-IN` what comes in, `AS` what goes out, `DISTILL` how it runs. The procedure's contract is the program's contract:

- `AS <template>` is **required** — without a shape for the result there is nothing to check;
- `LENS-IN <template>` is optional — the shape of the input, when the procedure has one;
- `DISTILL` sits directly in the procedure, alone on its line, once; anywhere else it is a compile error.

The level says how binding writing the script is, while none exists yet; once it exists, it is always used:

| Write | |
|---|---|
| `DISTILL` | the agent may write the script |
| `DISTILL!` | it should |
| `DISTILL!!` | it must, as soon as the work is done |
| `!DISTILL` | never — the procedure needs judgment every time |

The script is the harness's work; agent-pack fixes only its interface:

- **any language**, an executable file with a `#!` line;
- **input** as JSON on stdin, **output** as JSON on stdout, **exit 0** when it answers — anything else sends the agent back to reasoning;
- the instruction shows an example JSON of the input and of the output, generated from the templates; the apx checks both.

Scripts live in the project, versioned with the sources: `distilled/<id>.<ext>`. The id (`dst-` and eight hex digits) comes from the procedure's exact text and its contract templates, so editing either gives a new id: the old script is no longer used, and a new one is written the next time (a new level alone keeps the id). `agent-pack bundle all` lists the scripts no procedure owns any more, for you to review and delete. Writing its own scripts is always inside an agent's perimeter (`OWNS`).

Agents run a script through their apx — `node .agent-pack/apx/<agent>.apx run <id> '<json>'` (see [The apx](/guide/apx#distilled-scripts)).

## Control flow

| Construct | |
|---|---|
| `WHEN <condition>:` | a workflow: the indented lines apply when the condition holds |
| `IF <condition>` … `ELSE` | a branch; the indented lines are its body. An `ELSE` must come right after an `IF` in the same body |
| `UNTIL <condition>` | repeat the indented lines until the condition holds |
| `RUN <procedure or flow>` | carry out that procedure or flow |
| `IN <store>:` | the indented lines work on that store |

Lifecycle shorthands expand to a `WHEN`:

| Write | Means |
|---|---|
| `ON-INVOKE` | WHEN this agent is called |
| `ON-AGENT-PROMPTED` | WHEN the agent receives a new user prompt |
| `ON-TASK-COMPLETED` | WHEN the agent is about to declare the task complete |
| `ON-ERROR` | WHEN a step or tool call fails unexpectedly |
| `ON-DELEGATE` | WHEN the agent is about to delegate work to another agent |

## Shapes

`AS <template>` binds an answer to a template, at a strength:

| Write | Reads as |
|---|---|
| `AS` | Shape your response as |
| `AS!` | Strictly shape your response as — no deviation |
| `AS!!` | Shape your response to match exactly |
| `!AS` | Do not shape your response as |

On an agent, `LENS-OUT` sets the shape of every answer and `LENS-IN` the shape of every request it receives. In a procedure, `AS` is the shape of the procedure's result; in a flow step, of what the step's agent is handed.

## Imports and tags

```
IMPORT security, privacy FROM @main.policies
IMPORT review-report FROM @main.templates.review
```

`@main` is the project library; shared libraries have their own alias. See [Configuration](/reference/config#libraries).

`TAGS #board #planning` groups blocks: in the compiled definition, blocks sharing tags sit under a common heading, and the apx filters by them (`ls tag=board`, or `tag=#board`).

## Playbooks

A file ending in `.playbook.ap` holds one triggered workflow compiled into a harness skill: `ABOUT`, a `WHEN` trigger, and its steps. Compile it by path: `agent-pack bundle path/to/on-release.playbook.ap`.
