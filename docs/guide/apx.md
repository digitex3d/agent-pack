# The apx

`bundle all` writes one `.apx` per agent, in `.agent-pack/apx/`: the agent's compiled definition and the engine that serves it, in a single file run by Node alone.

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

For every kind it missed (`?` counts as a miss, and costs nothing), the apx prints that kind's introduction — how to use it. Then it prints the **scope**: who the agent is and its mandate, its perimeter (`WRITES` and `READS`), its role, its team and the team's routing, the policies it respects, what it does when (every `WHEN` and hook), what it remembers (`MEM`), the stores it writes to, the template requests arrive in and the one its answers take, and how many blocks of each kind it holds. The quiz runs once, at the start of the work.

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

An agent that declares a `STORE` reads and writes it through its apx:

```bash
node .agent-pack/apx/note-keeper.apx store a sto-7c1e40b2 topic=tabeli note='engine ships with agent-pack'
node .agent-pack/apx/note-keeper.apx store q sto-7c1e40b2
```

A store is reached by its id, like every block, after the operation; `store` alone lists the agent's stores with their ids. The operations are tabeli's (`a`dd, `q`uery, `s`et, `next`, …; `manual` for the table's own manual). The table is created on first use and is never touched directly: a `LASTS project` store lives in `stores/<agent>/<store>.tbl`, at the project root — yours to version or not — and a `LASTS session` store beside the apx, in `.agent-pack/apx/<agent>.state/`. A write outside the store's slots is refused before it reaches the table. When the store declares a `KEY`, adding a record whose key already exists updates it instead of duplicating it.

Stores are backed by tabeli, which ships with agent-pack (`tabeli/`, MIT) and works on Linux. `npm run build` compiles its engine with tabeli's own Makefile, so building agent-pack needs `make` and a C compiler (gcc or clang); `bundle all` records the engine's path in every `.apx`, which is how the apx finds it — an apx written before is rewritten by `agent-pack bundle all`. The apx creates tables only with a tabeli v2 engine, and a table made earlier keeps working with the engine it carries.

## Dimensions

An agent that has a [`DIMENSION`](/reference/language#dimension) reaches it by its id, like every block, after the operation: `dimension <operation> <dim-id>`. `dimension` alone lists the agent's dimensions, each with its id. A dimension is an agent's own: it is reached only through that agent's apx, never imported into a project's `PROJECT.ap` or a team's `flows.ap`. When it is worth reading is the agent's to say: a [`@WITH`](/reference/language#decorators-with) names the dimension above the work it is for, and the agent's definition shows that line with the dimension's id — *For the work below, use the dimension `pseudocode` (dim-…)* — while `ls kind=dimension` lists it as holding *only where @WITH names it*. There the agent reads the answer kept for the file, and decides whether it also needs the code:

```bash
node .agent-pack/apx/coder.apx dimension read dim-3f2a9c1e src/billing/invoice.py
```

| Answer | Exit | |
|---|---|---|
| `hit pseudocode <file> — by <agent>, <date>` | `0` | the file and every file the answer depends on are as they were: the answer follows, each instance through its template's `BODY` (`none` when there was nothing to report); `read <file> json` prints the raw value instead |
| `miss pseudocode <file> — never written` | `1` | no answer yet |
| `miss pseudocode <file> — changed: <path>` | `1` | the file, or a file the answer depends on, was edited — the old answer is never printed |
| `miss pseudocode <file> — ref gone: <path>` | `1` | a file the answer depends on was deleted |
| `gone pseudocode <file> — file not found` | `1` | the file was deleted; its entry waits for `gc` |

A file outside the dimension's `FOR` is a usage error (exit `2`) naming the globs it covers. A file moved or renamed without an edit keeps its answer: on a `miss`, the apx first looks for the entry of a file that no longer exists, written against this same content, and moves it.

On a `miss`, the agent works the answer out and keeps it — a JSON list of instances of the dimension's template on stdin, or the literal `none`:

```bash
node .agent-pack/apx/coder.apx dimension write dim-3f2a9c1e src/billing/invoice.py refs=src/billing/tax.py - < value.json
node .agent-pack/apx/coder.apx dimension write dim-3f2a9c1e src/billing/empty.py none
```

`refs=` names the other files the answer depends on (`;` between them; each must exist); every project file the value names, literally, is one too. The write is refused, and nothing is written, for a file outside `FOR` or that does not exist, a ref that does not exist, or a value its template refuses (at least one instance, every field checked as a typed variable's). An answer still fresh is never overwritten: the write exits `4` — another agent answered meanwhile, read it.

| Command | |
|---|---|
| `dimension find <dim-id> <text>` | every instance kept, across the dimension's files, whose text holds `<text>` (case aside) — fresh entries only; exit `1` when none does |
| `dimension ls <dim-id> [glob]` | the entries kept — `fresh`, `stale` or `gone`, and why — then the counts, hits, misses and hit rate |
| `dimension why <dim-id> <file>` | the state of one entry, file by file: the fingerprint kept and the current one |
| `dimension clear <dim-id> [glob] [--by <agent>]` | delete entries: all, those matching a glob, those an agent wrote |
| `dimension gc <dim-id>` | delete the entries of files that no longer exist |
| `dimension` | every dimension of the agent, by its id: what it covers, its cache folder and its counts |

The cache lives at the project root, outside git, and is never touched directly: `.agent-pack/cache/<defhash>/<file>.json`, one entry per file, with the counters apart in `.agent-pack/cache/stats/<defhash>.json`. The defhash is the dimension's content without its name — `ABOUT`, `FOR`, `EACH`, its rules, and the content of the templates `AS` and `EACH` name: renaming the dimension or a template keeps the cache, any other edit starts a new folder, and `agent-pack bundle all` deletes the folders no dimension produces any more. A file's fingerprint ignores line endings, trailing whitespace and blank lines; indentation and comments count.

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

`get` and `set` are the only way to a variable: how the apx keeps the values is its own business, and may change. Today they sit in tabeli tables under `.agent-pack/state/<session id>/`, never touched directly.

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

The script runs each `STEP` as its agent (`BY`), a `PARALLEL` group at the same time, passes upstream results by the step's `CONTEXT` mode, and enforces a step's input shape (`AS`) as the JSON Schema of the answer of the step before it. The Workflow tool still runs only when the user asks for the flow, a workflow or ultracode; otherwise the steps are carried out as written.

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

A line an agent hands to a delegate (`ASK`, `IF*`, `UNTIL*`, `PROCEDURE*`) or to a program (`COMPUTE`, `IF**`, `UNTIL**`, `PROCEDURE**` — see [Language](/reference/language#executors)) has a contract with an id like `exe-3f9a1c07`. The compiled line names the commands; `get <exe-id>` shows the contract, `scope` lists them all.

**A delegate** — the agent hands it the input, and stores the answer it gets back:

```bash
node .agent-pack/apx/clerk.apx ask input exe-3f9a1c07
{"pdf_text": "INVOICE 2026-114 …"}
node .agent-pack/apx/clerk.apx ask answer exe-3f9a1c07 - < answer.json
# stored as `lines` for this session — read it: node .agent-pack/apx/clerk.apx get lines
```

- `ask input <exe-id>` prints the JSON the piece receives — one key per variable it reads, with its value in this session (parsed when it is JSON), one per constant — and nothing else. An empty variable stops it (exit `1`).
- `ask answer <exe-id> -` reads the delegate's answer on stdin (or the rest of the line) and checks it against the contract: a line with `INTO x` takes a value of `x`'s type and stores it in `x`; a procedure takes its `AS` template; a condition takes `{"holds": true}` or `{"holds": false}` and prints it. An answer that breaks the contract is refused (exit `6`): nothing is stored, and the agent hands the piece over again with the same input.

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

**`--into <var>`** stores a procedure's result in a variable of the agent — what `RUN p INTO x` compiles to when a delegate or a program carries `p` out: `run <exe-id> --into x`, `ask answer <exe-id> - --into x`. It takes only a procedure's contract; a line stores in its own `INTO`.

**Rounds.** For an `UNTIL*` or `UNTIL**`, each `holds: false` is a round: the apx adds `round 2 of 3 — do the next round, then ask again`, and at the limit (the head's `MAX <n>`) `round limit reached (3 of 3): stop and report that the condition never held`, with exit `7` — so a command chained after it with `&&` never starts another round. A `holds: true` starts the count again, and so does an answer given after the limit: the loop was left, a later entry is a new loop at round 1.

Every delegate's answer and every program run is recorded in the session, in `.agent-pack/state/<session id>/executors.tbl`: the contract id, the executor, who carried it out (the delegate's name, or `program`), a sha256 fingerprint of the input (not the input), the outcome (`answered`, `ran`, `refused`, `timeout`, `broken`), the condition's answer, and the time.

## Compression

The agent's data is stored as one line of compact JSON at the end of the file. To store it gzipped instead, set `bundle.apxCompress: true` in the config, or pass `--apx-compress` to `bundle` (`--no-apx-compress` overrides the config the other way).
