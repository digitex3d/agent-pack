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

For every kind it missed (`?` counts as a miss, and costs nothing), the apx prints that kind's introduction — how to use it. Then it prints the **scope**: who the agent is and its mandate, its perimeter (`OWNS`), its role, its team and the team's routing, the policies it respects, what it does when (every `WHEN` and hook), what it remembers (`MEM`), the stores it writes to, the template requests arrive in and the one its answers take, and how many blocks of each kind it holds. The quiz runs once, at the start of the work.

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
| `run <dst-id> [json]` | run a distilled script — see below |
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

Exit code `0` is success, `1` means something does not exist (an unknown id), `2` means wrong usage (an unknown verb, a missing argument). Every error is one line starting with `# error:` that carries the command to run instead:

```
# error: no block with id 'nope' and no variable named so — list them: node .agent-pack/apx/reviewer.apx ls
```

## Stores

An agent that declares a `STORE` reads and writes it through its apx:

```bash
node .agent-pack/apx/note-keeper.apx notes a topic=tabeli note='engine lives in the skill dir'
node .agent-pack/apx/note-keeper.apx notes q
```

The verbs are tabeli's (`a`dd, `q`uery, `s`et, …; run the store bare for its manual). The table is created on first use and is never touched directly: a `LASTS project` store lives in `stores/<agent>/<store>.tbl`, at the project root — yours to version or not — and a `LASTS session` store beside the apx, in `.agent-pack/apx/<agent>.state/`. A write outside the store's slots is refused before it reaches the table. When the store declares a `KEY`, adding a record whose key already exists updates it instead of duplicating it.

Stores need the tabeli engine, v2 or newer, and work where tabeli runs (Linux). The apx finds it through the tabeli skill, or through the `APX_TABELI` environment variable pointing at the binary; it creates tables only with a v2 engine, and a table made earlier keeps working with the engine it carries.

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

## Distilled scripts

A procedure marked `DISTILL` (see [Language](/reference/language#distillation)) carries an id like `dst-174db08e`. The agent runs its script through the apx:

```bash
node .agent-pack/apx/accountant.apx run dst-174db08e '{"supplier":"Acme","lines":[{"amount":100,"vat-rate":22}]}'
{"net":100,"vat":22,"gross":122}
```

The input goes to the script as JSON on stdin — as the argument, or piped in. The apx:

- runs only the ids of this agent's distilled procedures;
- checks the input against the procedure's `LENS-IN` template (exit `2` when it does not fit);
- finds the script by name in `distilled/` and runs it, for at most 30 seconds;
- checks the output against the procedure's `AS` template.

When there is no script yet, the script fails (its error is shown), times out, or answers outside the template, `run` exits `1` and says so: the agent works it out by reasoning, and writes the script if its level asks for it. `scope` lists every distilled procedure and whether its script exists.

## Compression

The agent's data is stored as one line of compact JSON at the end of the file. To store it gzipped instead, set `bundle.apxCompress: true` in the config, or pass `--apx-compress` to `bundle` (`--no-apx-compress` overrides the config the other way).
