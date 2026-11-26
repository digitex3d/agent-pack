# The apx

`bundle all` writes one `.apx` per agent, in `.agent-pack/apx/`: the agent's compiled definition and the engine that serves it, in a single file run by Node alone.

The file is a *pack*: the engine, then its data as sections, one JavaScript comment line each — `//apx:<type>:<name>:<encoding>:<data>` — between a header line and an end line. The header locates every section (offset, size, sha256) and carries the hash of the data, the identity of the program, which the engine does not change; the end line repeats it and says where the header is, so the engine opens a pack of any size by reading its tail, its header and the one section it needs, and refuses a truncated or altered file before running anything. An agent's apx holds one section, `image`; a reader ignores the types it does not know.

```bash
node .agent-pack/apx/<agent>.apx <verb>
```

The apx is build output, like a compiler's `target/`: it is not committed, and a fresh clone runs `agent-pack bundle all` first. Next to the apx files, `bundle all` writes a `package.json` declaring them CommonJS, so they run inside projects whose own `package.json` says `"type": "module"`.

## Why

A harness usually loads an agent's whole definition into its context on every invocation, whether the task needs all of it or not. With the apx, the agent carries only a pointer and reads its definition on demand: the scope first, then the blocks the task actually needs.

On-demand reading pays only when the definition is large. A definition under about 12,000 characters is printed whole by `start` — one call, no quiz. Above that, `start` opens with the agent every block it always needs (its role, the policies, the templates its requests and answers take) and every block under about 600 characters; only the large, conditional ones stay a `get`, and the quiz asks only about those.

## Starting

```bash
node .agent-pack/apx/reviewer.apx start
```

`start` prints who the agent is and a short multiple-choice quiz: one or two questions for each kind of block the agent holds — how a policy binds, how a template is filled, how a flow is run. The agent answers them:

```bash
node .agent-pack/apx/reviewer.apx start 1=c 2=a 3=b 4=?
```

For every kind it missed (`?` counts as a miss, and costs nothing), the apx prints that kind's introduction — how to use it. Then it prints the **scope**: who the agent is and its mandate, its perimeter (the domains `@WITHIN` names), its role, its team and the team's routing, the policies it respects, what it does when (every `WHEN` and hook), what it remembers (`MEM`), the stores it writes to, the template requests arrive in and the one its answers take, and how many blocks of each kind it holds. The quiz runs once, at the start of the work.

Running the apx with no verb is the same as `start`.

## Reading

| Command | |
|---|---|
| `scope` | everything needed to start |
| `ls [kind= tag= name~ about~] [count]` | every block, grouped by kind — id, name, tags, description |
| `get <id>` | one block: its text, then a footer with kind, name, id, size and tags, what it uses and what uses it |
| `get <id> json` | the block's raw structure |
| `get <name>` | a variable: its scope, how to read and store it, who stores it, who reads it, then its value in this session — see below |
| `set <name> -` / `set <name> <value>` | store a variable's value — see below |
| `refs <id>` | only the links: what the block uses, what uses it |
| `find <text>` | the blocks containing the text, each with the lines that matched |
| `md` | the whole definition at once — the same text a harness `.md` carries |
| `flow <flw-id>` | how to run a flow — see below |
| `run <exe-id> [json] [--into <var>]` | run a program — see below |
| `check <cnd-id>` | a checked condition put to the judge: `open` or `closed` — see below |
| `<kind> <operation> [<id>] …` | a kind the apx serves at run time — `store`, `dimension`, `ask` — one form for all: the kind, the operation, then the id; `help` lists every operation |
| `dimension [<dim-id> <verb> …]` | the agent's dimensions, by id — alone, the list: what each covers, its cache folder, its counts; with an id, that dimension's verb — see below |
| `version` | agent and id, build date, agent-pack version, content hash, block count |
| `help` | the verbs |

`get` on the agent's own id returns its definition complete — perimeter, team, identity, mandate, rules — never trimmed.

## References

Every block has an id — a kind prefix and eight hex digits, like `tpl-d82fd6de` — stable as long as the block keeps its name and place. Every reference the apx prints carries the command that fetches it:

```
Shape your response as `finding` [node .agent-pack/apx/web-researcher.apx get tpl-d82fd6de]
```

so the agent follows ids and never guesses a block's content. A fellow team member defined in another file is reached through its own apx: `[node .agent-pack/apx/scout.apx scope]`.

## Errors

Exit code `0` is success, `1` means something does not exist (an unknown id), `2` means wrong usage (an unknown verb, a missing argument). `check`, `answer`, `run` and a dimension's `write` use a few more — see [Checked conditions](#checked-conditions), [Delegates and programs](#delegates-and-programs) and [Dimensions](#dimensions). Every error is one line starting with `# error:` that carries the command to run instead:

```
# error: no block with id 'nope' and no variable named so — list them: node .agent-pack/apx/reviewer.apx ls
```

## Stores

An agent that declares a `STORE` reads and writes it through its apx, with the same commands whatever driver keeps it:

```bash
node .agent-pack/apx/note-keeper.apx store put sto-7c1e40b2 topic=drivers note='files is the default'
node .agent-pack/apx/note-keeper.apx store find sto-7c1e40b2 topic~driv
```

A store is reached by its id, like every block, after the operation; `store` alone lists the agent's stores, each with its driver and where its data lives. Every answer writes a record on one line, its `id` first — `id=1 topic=drivers note='files is the default'` — and `find` ends with how many there are.

| Operation | |
|---|---|
| `put <sto-id> <field>=<value> …` | add a record — when the store has a `KEY` and a record has that key, update it instead, never duplicate it |
| `get <sto-id> <key>` | one record, by its `KEY` — by its `id` when the store has none; exit `1` when there is none |
| `find <sto-id> [<filter> …] [limit=<n>] [count] [json]` | the records every filter holds for, in the order they were added |
| `set <sto-id> <key> <field>=<value> … [if <filter> …]` | set some fields of a record; with `if`, only while every filter still holds — else exit `4`: your view of it is stale |
| `remove <sto-id> <key>` | remove a record |
| `take <sto-id> [<filter> …] set <field>=<value> …` | the first record the filters hold for, its fields set in the same step: two agents never take the same one — exit `1` when none is left |
| `mark <sto-id>`, then `since <sto-id> <mark>` | a mark of now, then the records added or changed after it |

A filter is `<field><op><value>`: `=`, `!=`, `>`, `<`, `>=`, `<=`, and `~` for "contains". Values compare as numbers when both sides are numbers, as text otherwise; a field that is none of the store's is refused. A write outside the store's slots — an unknown field, a required one missing, a value outside its type — is refused before it reaches the driver, and nothing is written.

`take`, `set … if` and `mark`/`since` are what a driver may add to the base operations; both shipped drivers have all three. With a driver that lacks one the operation is refused (exit `2`), and the compiled definition never shows its command.

The data is never touched directly. Where it lives is the driver's: with `files`, the default, a `LASTS project` store is `stores/<agent>/<store>.json` at the project root — yours to version or not — and a `LASTS session` store sits beside the apx, in `.agent-pack/apx/<agent>.state/`. Other drivers come from the config: [Store drivers](./drivers.md).

## Dimensions

An agent that has a [`DIMENSION`](/reference/language#dimension) reaches it by its id, like every block, after the operation: `dimension <operation> <dim-id>`. `dimension` alone lists the agent's dimensions, each with its id. A dimension is an agent's own: it is reached only through that agent's apx, never imported into the project's main or a team's file. When it is worth reading is the agent's to say: a [`@WITH`](/reference/language#decorators-with) names the dimension above the work it is for, and the agent's definition shows that line with the dimension's id — *For the work below, use the dimension `pseudocode` (dim-…)* — while `ls kind=dimension` lists it as holding *only where @WITH names it*. There the agent reads the answer kept for the file, and decides whether it also needs the code:

```bash
node .agent-pack/apx/coder.apx dimension read dim-3f2a9c1e src/billing/invoice.py
```

| Answer | Exit | |
|---|---|---|
| `hit pseudocode <file> — by <agent>, <date>` | `0` | the file and every file the answer depends on are as they were: the answer follows, each record through the `BODY` of its store's template — on a line of `field=value` when the store has its own `SLOTS` — (`none` when there was nothing to report); `read <file> json` prints the raw value instead |
| `miss pseudocode <file> — never written` | `1` | no answer yet |
| `miss pseudocode <file> — changed: <path>` | `1` | the file, or a file the answer depends on, was edited — the old answer is never printed |
| `miss pseudocode <file> — ref gone: <path>` | `1` | a file the answer depends on was deleted |
| `gone pseudocode <file> — file not found` | `1` | the file was deleted; its entry waits for `gc` |

A file outside the dimension's `FOR` is a usage error (exit `2`) naming the globs it covers. A file moved or renamed without an edit keeps its answer: on a `miss`, the apx first looks for the entry of a file that no longer exists, written against this same content, and moves it.

On a `miss`, the agent works the answer out and keeps it — a JSON list of records with the fields of the dimension's store on stdin, or the literal `none`:

```bash
node .agent-pack/apx/coder.apx dimension write dim-3f2a9c1e src/billing/invoice.py refs=src/billing/tax.py - < value.json
node .agent-pack/apx/coder.apx dimension write dim-3f2a9c1e src/billing/empty.py none
```

`refs=` names the other files the answer depends on (`;` between them; each must exist); every project file the value names, literally, is one too. The write is refused, and nothing is written, for a file outside `FOR` or that does not exist, a ref that does not exist, or a value its template refuses (at least one instance, every field checked as a typed variable's). An answer still fresh is never overwritten: the write exits `4` — another agent answered meanwhile, read it.

| Command | |
|---|---|
| `dimension find <dim-id> <text>` | every instance kept, across the dimension's files, whose text holds `<text>` (case aside) — fresh entries only; exit `1` when none does |
| `dimension q <dim-id> [<field><op><value> …] [json]` | the instances every filter holds for, each with its file — filters as a [store's](#stores), on the store's fields or `_file`; fresh answers only, and the files left out for having none |
| `dimension next <dim-id>` | the next file it covers with no fresh answer, taken for you: no other agent gets it meanwhile (for thirty minutes, or until it is written) — exit `1` when every file is answered or taken |
| `dimension mark <dim-id>`, then `dimension since <dim-id> <mark>` | a mark of now, then the files answered after it |
| `dimension ls <dim-id> [glob]` | the entries kept — `fresh`, `stale` or `gone`, and why — then the counts, hits, misses and hit rate |
| `dimension why <dim-id> <file>` | the state of one entry, file by file: the fingerprint kept and the current one |
| `dimension clear <dim-id> [glob] [--by <agent>]` | delete entries: all, those matching a glob, those an agent wrote |
| `dimension gc <dim-id>` | delete the entries of files that no longer exist |
| `dimension` | every dimension of the agent, by its id: what it covers, its defhash and its counts |

The cache lives at the project root, outside git, and is never touched directly: each dimension's answers are a store of their own, `.agent-pack/cache/<defhash>.<ext>` — the fields and the driver of its `STORE`, the extension the driver's (`.json` for files) — with one record per file answered (its fingerprint, its refs, who wrote it) and one per instance; the counters apart in `.agent-pack/cache/stats/<defhash>.json`. Every agent that has the dimension reads and writes the same store. A write is guarded: the file's record is claimed while its instances change, so two agents answering one file never mix their records — the one that loses exits `4`. The defhash is the dimension's content, its store's and the template `EACH` names, without their names: renaming any of them keeps the cache, any other edit starts a new store, and `agent-pack bundle all` deletes the stores no dimension produces any more. A file's fingerprint ignores line endings, trailing whitespace and blank lines; indentation and comments count.

## Variables

A variable (see [Language](/reference/language#variables)) is filled while the agent works and read back later — by a later step of the same agent, or, when it is a `SESSION` variable, by another agent of the project in the same session. The compiled text tells the agent when to store and how to read; the apx keeps the value:

```bash
node .agent-pack/apx/reviewer.apx set summary - < summary.txt      # the value on stdin
node .agent-pack/apx/reviewer.apx set verdict '{"decision":"accept","reason":"two sources agree"}'
node .agent-pack/apx/reviewer.apx get verdict
```

- `get <name>` prints the variable — its scope (private or SESSION), its type and where it is declared, how to read and store it — then who stores it (`uses:` / `used by:`) and who reads it (`read by:`), and last, after a `# value:` line, its value exactly as stored, byte for byte; or `# value: (empty — nothing stored in this session yet)`. An argument shaped like a block id (`tpl-1a2b3c4d`) is always a block; a variable may never be named so. `get` on a constant prints its value.
- `set <name>` stores the value for this session; the last write wins. The value is the rest of the line, or stdin with `-`. Only a variable of this agent is set, never a constant. A typed variable takes only JSON its template accepts: anything else is refused with what is wrong, and nothing is written.
- `ls kind=var` lists the variables, each with its scope, its type and where it is declared; `scope` lists them too.

`get` and `set` find the variable's scope themselves. A **private** variable is the agent's own: another agent of the session, even one running the same procedure, never sees its value, and the same agent called again in the session finds it. A **SESSION** variable is one value for every agent of the project in the session — a team shares it.

`get` and `set` are the only way to a variable: how the apx keeps the values is its own business, and may change. Today they sit in JSON files under `.agent-pack/state/<session id>/`, never touched directly.

The session is the harness's: each adapter names the environment variable that holds its id (`claude-code` and `claude-code-apx`: `CLAUDE_CODE_SESSION_ID`). Without it — an adapter that names none, the variable unset, or an id that is no folder name — `get` and `set` of a variable refuse (exit `2`) and read or write nothing; every other verb works as usual.

## Flows

A flow is routed in `AGENTS.md` through the apx of one of its team's members:

```
Run the flow `assess-readiness` (flw-0b872a2f) — start with `node .agent-pack/apx/docs-auditor.apx flow flw-0b872a2f`: it says how
```

`AGENTS.md` is read by every harness, so it only names the command; the apx answers for the harness it was built for. When the adapter runs flows as scripts of its own, `bundle all` compiles each flow into `.agent-pack/flows/<id>.<hash>.<ext>` and `flow` prints how to run it — with `claude-code` and `claude-code-apx`, a Workflow tool script:

```bash
node .agent-pack/apx/docs-auditor.apx flow flw-0b872a2f
run this flow with the Workflow tool: Workflow({ scriptPath: "…/.agent-pack/flows/flw-0b872a2f.68279ca3.js", args: { request: "<the request, verbatim>" } }) — …
```

The script runs each `DELEGATE` as its agent (`BY`), starts a `DELEGATE~` without waiting and awaits it at its `WAIT`, passes every result so far — or, under an `AS`, only the one before, its shape enforced as the JSON Schema of that answer. A step with a line of its own for whoever runs the flow (a `DO`, an `IF`, a `FORK`), or a delegation to a team, keeps the flow out of the script. The Workflow tool still runs only when the user asks for the flow, a workflow or ultracode; otherwise the steps are carried out as written.

Without a script — another adapter, a step run by a team, anything but steps at the flow's top level, or a script built for an earlier version of the flow (the `<hash>` is the flow's content hash) — `flow` prints the flow's steps, to carry out in order.

## Checked conditions

A checked condition (`IF!`, `IF!!`, `UNTIL!`, `UNTIL!!` — see [Language](/reference/language#checked-conditions)) compiles into the command that decides it:

```bash
node .agent-pack/apx/shipper.apx check cnd-95dbba72
open
the gate opened (p=0.91)
```

```bash
node .agent-pack/apx/shipper.apx check cnd-95dbba72
closed
the gate stayed closed — p=0.42, below 0.7
```

The first line is `open` or `closed`, for a machine; the second, why. The exit code says the same: `0` open, `1` closed, `2` a usage or configuration error (no id, an id this agent has not, no `checks` configured, no session id) — still with `closed` on the first line.

- The apx reads the variables the condition reads from this session's memory, builds the state (`### <name>` and the value as stored, each), and asks the judge the question the compiler built — the agent passes nothing.
- At or above the threshold the answer is `open`; below it, and whenever in doubt — a variable empty, a state too large for the judge, a judge that cannot be reached — `closed`.
- For a sealed condition (`!!`), no answer says what it checks: only *the gate opened* or *the gate stayed closed*, and why (`p=0.42`, a variable it reads is empty, …). `get <cnd-id>` shows the question of an `IF!` and refuses that of an `IF!!`; `scope` lists the checks.
- A checked `UNTIL` counts the closed answers in a row for this agent and condition: `round 2 of 3`, then `round limit reached (3 of 3): stop and report that the gate stayed closed`. An open answer starts the count again, and so does a check made after the limit: the loop was left, a later entry is a new loop at round 1.
- Every check is recorded in the session, beside its variables: the id, the agent, the level, the round, a sha256 fingerprint of the state (not the state), the model, the probability, the threshold and the outcome.

## Delegates and programs

A line an agent hands to a delegate (`DELEGATE`, `IF*`, `UNTIL*`, `PROCEDURE*`) or to a program (`COMPUTE`, `IF**`, `UNTIL**`, `PROCEDURE**` — see [Language](/reference/language#executors)) has a contract with an id like `exe-3f9a1c07`. The compiled line names the commands; `get <exe-id>` shows the contract, `scope` lists them all.

**A delegate** — the agent hands it the input, and stores the answer it gets back:

```bash
node .agent-pack/apx/clerk.apx delegate input exe-3f9a1c07
{"pdf_text": "INVOICE 2026-114 …"}
node .agent-pack/apx/clerk.apx delegate answer exe-3f9a1c07 - < answer.json
# stored as `lines` for this session — read it: node .agent-pack/apx/clerk.apx get lines
```

- `delegate input <exe-id>` prints the JSON the piece receives — one key per variable it reads, with its value in this session (parsed when it is JSON), one per constant — and nothing else. An empty variable stops it (exit `1`).
- `delegate answer <exe-id> -` reads the delegate's answer on stdin (or the rest of the line) and checks it against the contract: a line with `INTO x` takes a value of `x`'s type and stores it in `x`; a procedure takes its `AS` template; a condition takes `{"holds": true}` or `{"holds": false}` and prints it. An answer that breaks the contract is refused (exit `6`): nothing is stored, and the agent hands the piece over again with the same input.

**A program** — the apx runs it itself:

```bash
node .agent-pack/apx/clerk.apx run exe-8c21d4e0
{"holds": false}
```

`run <exe-id> [in-json]` finds the program in `distilled/<dst-id>/` (see [Programs](/reference/language#programs)), runs its tests first when the program is new or changed, then runs it on the piece's input — the JSON `input` prints, plus `in` for a procedure that takes a `LENS-IN` (passed as the argument). Its answer is checked against the contract like a delegate's. The exit code tells the agent what to do:

| Exit | |
|---|---|
| `0` | the answer — printed, or stored in its `INTO` variable |
| `10` | no program yet: the message says where to write it and how (`write-program`), and where its previous version is |
| `3` | the program refused its input: stop the procedure and report it — never carry the piece out yourself |
| `4` | the program timed out (`timeout_ms` in its manifest): carry this one run out yourself, and say so |
| `6` | the program is broken: it fails one of its own tests, cannot start, answers outside its contract, or its folder lacks `tests.json` or `timeout_ms` |
| `7` | an `UNTIL*` / `UNTIL**` reached its round limit: stop the loop and report that the condition never held (also from `answer`) |
| `1` / `2` | the piece cannot run yet (an empty variable, a delegate's contract) / wrong usage |

**`--into <var>`** stores a procedure's result in a variable of the agent — what `RUN p INTO x` compiles to when a delegate or a program carries `p` out: `run <exe-id> --into x`, `delegate answer <exe-id> - --into x`. It takes only a procedure's contract; a line stores in its own `INTO`.

**Rounds.** For an `UNTIL*` or `UNTIL**`, each `holds: false` is a round: the apx adds `round 2 of 3 — do the next round, then ask again`, and at the limit (the head's `MAX <n>`) `round limit reached (3 of 3): stop and report that the condition never held`, with exit `7` — so a command chained after it with `&&` never starts another round. A `holds: true` starts the count again, and so does an answer given after the limit: the loop was left, a later entry is a new loop at round 1.

Every delegate's answer and every program run is recorded in the session, in `.agent-pack/state/<session id>/executors.json`: the contract id, the executor, who carried it out (the delegate's name, or `program`), a sha256 fingerprint of the input (not the input), the outcome (`answered`, `ran`, `refused`, `timeout`, `broken`), the condition's answer, and the time.

## Background work

What a flow starts with `DELEGATE~` or `FORK~` has an id like `dlg-28f9d7d3` and a record in the session's registry, `.agent-pack/state/<session id>/delegations.json`: shared by every agent of the session, on disk — it outlives the conversation that started it. The compiled flow names the commands on each line (`get <flw-id>`):

```bash
node .agent-pack/apx/lead.apx delegate start dlg-28f9d7d3          # the lead, before handing it over
node .agent-pack/apx/lead.apx delegate deliver dlg-28f9d7d3 - < style.txt   # whoever carries it out
node .agent-pack/apx/lead.apx wait dlg-28f9d7d3 dlg-1d06e0a6 --max 10m      # the lead, at the WAIT
dlg-28f9d7d3  style  delivered  → checker-a
dlg-1d06e0a6  check  running  → checker-b  — still running after 10m
```

- `delegate start <dlg-id>` records the piece as `running`. A piece still running cannot start again; one that is settled starts afresh — a loop starts the same piece on every round.
- A piece that goes to another harness (`BY opencode:fixer`, see [Adapters](/guide/adapters#delegating-to-another-harness)): `delegate start` opens its copy, carries the agent's definition in, writes its prompt beside the copy and prints the harness's command, filled — with `# model: <id>`, the model the agent's `BUDGET` tier maps to on that harness, or the harness's own default when it maps to none. The lead runs the command with its shell, then `delegate deliver <dlg-id> --answer`: the answer the command wrote, and what its copy changed within its perimeter.
- `delegate deliver <dlg-id> -` takes its result on stdin and stores it in its `INTO` variable — checked against the variable's type: a value that breaks it is refused (exit `6`), nothing is stored. `delegate block <dlg-id> "<why>"` says it cannot be done as asked.
- `wait <dlg-id | mrk-id | var> … [--max <duration>] [--now]`, `wait all` returns when every piece it names is delivered, blocked or ended without delivery — or when the limit is reached: `--max`, written by the WAIT's `MAX`, else the `wait.max` config key (`30m` by default). Then each one's state: exit `0` when all were delivered, `1` otherwise.
- `--now` does not wait: each one's state at once, its limit counted from when it started — what a harness that is told when work ends uses (Claude Code: the lead waits for the notifications, then `wait … --now`).
- Inside an `EACH`, each run of a `~` is a piece of its own, `dlg-28f9d7d3-<k>` with `<k>` the run's number from 1: `delegate start dlg-28f9d7d3-1`, and so on. A run past the `EACH`'s `MAX` is refused (exit `3`): the list is longer than its bound — stop the flow and report it. A run's result stays with the run; `wait dlg-28f9d7d3` (or its `INTO` variable) takes every run back, and once all are settled the `INTO` holds one result per run, in order — a run not delivered as its state.
- After the `WAIT` of a `MARK`'s contracts, the list's variable holds each one's state (`{"id": "ctr-…", "state": "merged"}`, `"blocked"` with its `reason`); before it, their ids.
- Nothing moves by itself: at the limit what still runs is left running, and the lead decides — wait again, `delegate take <dlg-id>` (it carries the piece out itself), `delegate reassign <dlg-id> <agent>`, or `delegate block <dlg-id> "<why>"`. When the harness says the agent of a piece stopped without delivering, the lead records it with `delegate ended <dlg-id>`, and decides the same way. `delegate list` shows every piece of the session.

## Contracts

A flow's `MARK` has an id like `mrk-5b0e2a71`, and each contract it binds an id like `ctr-4a1f0c92` — a record in the same registry, `delegations.json`, beside the background pieces. The compiled flow names the commands:

```bash
node .agent-pack/apx/lead.apx contract mark mrk-5b0e2a71 - < spec.json    # whoever runs the flow: one zone, its spec on stdin
ctr-4a1f0c92  screens  marked
# … writes `agent-pack ctr-4a1f0c92` and `agent-pack end ctr-4a1f0c92` in comments around the zone
node .agent-pack/apx/lead.apx contract start mrk-5b0e2a71 --by web-dev    # the DELEGATE of the list: a copy each
ctr-4a1f0c92  → web-dev  src/login.ts:2-4  copy: .agent-pack/work/ctr-4a1f0c92
node .agent-pack/apx/web-dev.apx contract get ctr-4a1f0c92                # the agent: its spec, its zones, its copy
node .agent-pack/apx/web-dev.apx delegate deliver ctr-4a1f0c92            # from the copy
node .agent-pack/apx/lead.apx wait mrk-5b0e2a71                           # merged, then landed in the working folder
```

- `contract mark <mrk-id> -` checks the spec against the `MARK`'s `AS` (exit `6` when it breaks it), refuses past its `MAX` or the `mark.max` config key (exit `3`), and adds the contract's id to the list's variable — what `{{<list>}}` reads.
- `contract start <mrk-id> --by <agent>` finds each waiting contract's zones by their marks, lands what was merged since the last round, and opens a copy for each. A contract with no zone is refused, unless its `MARK` has a `WITHIN`. None waiting: nothing to start, exit `0`.
- A copy shows every tracked file, and links the project's ignored dependency folders (`node_modules`, `vendor`, `.venv`) from the working folder, so the project's own checks run there — `npx tsc`, `npx vitest`. A link is never delivered.
- `contract start <mrk-id> --by <harness>:<agent>` — what a `DELEGATE <list> BY opencode:fixer` compiles to — launches each contract on another harness: for each one it opens the copy, carries the agent's definition in, writes its prompt beside the copy (`<copy>.prompt.md`: its spec, its zones and their marks, what else it may write) and prints the harness's command, filled — the model the agent's `BUDGET` tier maps to there included. The lead runs every command with its shell; when one ends, `delegate deliver <ctr-id> --answer [--why "<reason>"]` takes the answer the command wrote (`<copy>.answer.txt`) and keeps what the copy changed within the contract, as for any contract — never the files carried in. The harness's recipe must have been compiled into the lead: a `--by` naming a harness no line of its flows delegates to is refused (exit `2`).

```bash
node .agent-pack/apx/lead.apx contract start mrk-5b0e2a71 --by opencode:fixer
ctr-4a1f0c92  → fixer on opencode  src/login.ts:2-4  copy: .agent-pack/work/ctr-4a1f0c92
opencode run --model opencode/deepseek-v4.1-flash-free --agent fixer --dir /…/.agent-pack/work/ctr-4a1f0c92 --format json < /…/ctr-4a1f0c92.prompt.md 2>&1 | node -e "…" > /…/ctr-4a1f0c92.answer.txt
# model: opencode/deepseek-v4.1-flash-free — the one fixer's BUDGET tier maps to on opencode
# … the recipe's rules
node .agent-pack/apx/lead.apx delegate deliver ctr-4a1f0c92 --answer      # when its command ended
node .agent-pack/apx/lead.apx wait mrk-5b0e2a71
```
- A contract writes its zones, the files it creates and its `MARK`'s `WITHIN` domain. `delegate deliver <ctr-id>` keeps that from its copy; anything else is left out, and only with a reason: `--why "<reason>"`. With Claude Code, the project's hook warns the agent as soon as it writes outside (see [The perimeter](#the-perimeter)), and stops it when it writes in the project folder instead of its copy.
- `delegate block`, `ended`, `take`, `reassign` and `list` work on a contract as on any piece; `take` names the copy to finish it in.
- `wait <mrk-id>` takes back the contracts the latest `start` of that `MARK` opened: each delivered one is merged and what was merged lands in the working folder, uncommitted. A merge that conflicts is left delivered, for `contract merge <ctr-id> --prefer ours|theirs`, then `contract land`. `contract list [mrk-id]` shows the contracts.

## The perimeter

A piece started in the background carries its perimeter, set by `delegate start`: the `WRITES` files of its step's `@WITHIN`, and those of its assignee's own `@WITHIN`. A file it writes must be in both. A domain that only `READS` writes nothing. `take` and `reassign` set it again for the new assignee.

`guard <path> [--agent <name>] [--subagent]` says whether a write keeps to it — exit `0`, or `3` with who, which file, which perimeter, and what to do: not write it, and say so in the delivery. A harness hook asks it before every write:

```bash
node .agent-pack/apx/lead.apx guard src/api/x.ts --agent builder --subagent
src/api/x.ts: outside builder's own perimeter (src/web/**) — do not write it; if the work needs it, say so in your delivery
```

Which work a write belongs to, the harness says only by who writes:

- **the main conversation** — whoever runs the flow — is held to no piece;
- **a subagent named as the assignee** of pieces in progress is held to theirs;
- **a subagent no piece names** — a fork, an agent the flow did not start — is held to every piece in progress that has a perimeter: the narrowest reading, never the widest;
- **every agent** is held to its own `@WITHIN`, pieces or not. No `@WITHIN` and no piece: no perimeter.

A contract's assignee writes in its copy, never in the project folder. In the copy, `guard <path> --after` asks, once the file is written, whether it stays within the contract — the same answer as `contract within`.

## The main

With a [main](/reference/language#main), `bundle all` also writes its apx, `.agent-pack/apx/<main>.apx`: the engine once, what the main is and holds, and every agent it holds — each one as its own apx has it. Its first word is one of its own verbs, or the agent to run:

```bash
node .agent-pack/apx/orfeo.apx start              # the main: its rules and its orchestration
node .agent-pack/apx/orfeo.apx ls                 # its teams, their members, its agents
node .agent-pack/apx/orfeo.apx designer start     # an agent, served as its own apx serves it
```

`AGENTS.md` then holds only what boots the main — its name, `… start`, and the policies that hold everywhere — so the harness reads the rest from it.

An agent run through the main answers every verb as its own apx does, on the same state, and every command it prints goes through the main — the main rewrites, as it prints them, the commands the compiler wrote for each agent's own apx. `agent-pack bundle orfeo --executable` makes the main one executable, `.agent-pack/bin/orfeo`, every agent inside, and `AGENTS.md` boots it from there.

## A team

Every team gets its apx too, `.agent-pack/apx/<team>.apx`: its members inside, and as its own text its flows and its routing — nothing of the other teams. It answers like the main: `start`, `ls`, `version`, `help`, and `<team> <member> <verb>`. `agent-pack bundle <team> --executable` makes it one executable, `.agent-pack/bin/<team>`, to hand the team out on its own.

## One executable

The apx is the development form: Node runs it, `bundle` rewrites it. To hand an agent out, `agent-pack bundle <agent> --executable` also compiles it with [Bun](https://bun.sh) into one executable, `.agent-pack/bin/<agent>`:

```bash
agent-pack bundle reviewer --executable
.agent-pack/bin/reviewer start
```

The executable is the same engine with the apx's data lines carried inside it; it answers the verbs as the apx does, and, run from the project, keeps to the same state, stores and programs — `.agent-pack/bin/` is as deep as `.agent-pack/apx/`. `--target <bun target>` builds for another platform. Only the agent's context is inside: the stores and the distilled programs stay where they are, and the verbs that run another program may still need Node.

## Compression

The agent's data is stored as one line of compact JSON at the end of the file. To store it gzipped instead, set `bundle.apxCompress: true` in the config, or pass `--apx-compress` to `bundle` (`--no-apx-compress` overrides the config the other way).
