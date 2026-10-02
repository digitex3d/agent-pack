# Configuration

agent-pack reads `agent-pack.config.mjs` in the current directory (`--config <path>` to use another file). It is a JavaScript module exporting an object; every key is optional.

```javascript
// agent-pack.config.mjs
export default {
  adapters: ['claude-code-apx'],
};
```

## Options

| Key | Default | |
|---|---|---|
| `adapters` | `[]` | the harnesses to write for — built-in names (`'claude-code'`, `'claude-code-apx'`, `'cursor'`, `'junie'`) or adapter objects. See [Adapters](/guide/adapters) |
| `agentsDir` | `agents` | where agents are discovered — every `.ap` file holding an `EXPORT AGENT` block |
| `teamsDir` | `agents/teams` | where teams live — one folder per team |
| `libraryRoot` | `library` | the project library, reached as `@main` |
| `sharedLibraries` | `[]` | more libraries, each reached by its own alias — see below |
| `bundle.runtime` | `true` | open every agent definition with the agent-pack introduction |
| `bundle.apxCompress` | `false` | store the apx data gzipped instead of as compact JSON |
| `lint.maxLineLength` | `120` | longest line accepted in a `.ap` file |
| `judge` | absent | turns on the judge phase — see below; absent, everything compiles as before |
| `judge.adapter` | `'jev'` | the judge — a built-in name (`'jev'`) or a judge object `{ type: 'judge', name, ask }` |
| `judge.threshold` | `0.5` | a check answered below this probability is reported |
| `judge.offline` | `'warn'` | a line with no saved verdict when the judge cannot be reached: `'warn'` (a "not judged yet" warning) or `'error'` |
| `judge.lock` | `agent-pack.judge.lock` | the judge lock, from the project root — the judge, its pinned model, your decisions; commit it |
| `judge.concurrency` | `8` | requests in flight at most |

## Judge

With a `judge` key, `bundle` and `bundle all` run a judge phase: a model checks that the `.ap` code is well written. A rule is a `TEMPLATE` tagged `#judge` — its `BODY` layout names the lines it applies to (`DO {action}` → every `DO` line), each slot rule is a check, `MUST` an error and `SHOULD` a warning. The builtin library ships three rules, each checking every `DO` line: `judge-do-line` (exactly one imperative verb), `judge-do-condition` (no condition inside the line — write it as an `IF` with the `DO` under it) and `judge-do-force` (no word of force inside the line — write it with its primitive: `NEVER`, `ALWAYS`, `MUST`, …).

```javascript
export default {
  judge: { adapter: 'jev' },
};
```

Diagnostics point at `file:line:col` with the check's id. The judge keeps two kinds of files:

- **the lock**, `agent-pack.judge.lock` — `{ "version": 1, "judge": "jev", "model": "…", "decisions": { "<key>": { "p": 1, "by": "human" } } }`. The judge writes it once, to pin the model of its first answer; after that only you edit it. Add a decision to overrule a false alarm: it wins over the judge's verdict, whatever the model. After a clean `bundle all`, one line lists the decisions no line used any more — a report only, never deleted.
- **one unit per `.ap` source**, `.agent-pack/units/<source path>.json` — like a C object file: the hash of the source, the hash of the rules (with the lock and the threshold), the model that answered, the judge's verdicts on its lines, and its diagnostics. A source outside the project is named by its library: `.agent-pack/units/_external/@alias/<path inside the library>.json` (`source: "@alias/…"`), else `_external/<hash of its directory>/<file>.json` — no machine path is written. A source whose text and rules are unchanged is not judged again: its diagnostics are the unit's. An edited source asks only for its changed lines — every other verdict comes from the units. Change the model in the lock and the verdicts of the other model are not reused: every line is asked again. A source with a line that could not be judged keeps its old unit, so the next run retries. A single-agent `bundle` keeps a unit's earlier verdicts; a clean `bundle all` trims what it re-judges and deletes the units of sources no agent uses any more.

Keys are hashes of the check and the line text — neither file reveals the rules or the lines. `--no-judge` skips the phase for one run, `--judge-strict` makes an unjudged line an error.

Only a judge that cannot be reached, times out, or has no key or a rejected one (401/403) goes offline for the rest of the run. Any other failure — a rate limit, a server error, a malformed answer — leaves only that line not judged, with its own reason, and the rest is still asked; Jev retries a 429 or 5xx once. A judge object marks such a failure by throwing an error with `kind: 'line'`.

**What leaves your machine:** with `judge.adapter: 'jev'`, the text of every `DO` line (nothing else) is sent to TypeSafe AI's API (`api.typesafe.ai`). The key is read from `TYPESAFE_API_KEY`, else `~/.config/typesafe/key` — never from the config.

## Libraries

Reusable blocks — policies, roles, templates, procedures — live in libraries and are imported by name:

```
IMPORT security FROM @main.policies
IMPORT review-report FROM @main.templates.review
```

`@main.<kind>[.<folder>…]` points at `<libraryRoot>/<kind>/[<folder>/…]`. The kinds are the plural folder names: `policies`, `roles`, `templates`, `procedures`, `playbooks`, `flows`, `stores`.

A shared library is a local folder reached by an alias of your choice:

```javascript
export default {
  sharedLibraries: [
    { alias: '@company', path: '~/code/company-agents' },
    { alias: '@team', path: '../team-agents', watch: true },  // rebuilt by bundle all --watch
  ],
};
```

```
IMPORT security FROM @company.policies
```

Two aliases are reserved: `@user`, the global library in `~/.agent-pack` (see below), and `@builtin`, the library shipped inside agent-pack.

## The global layer

`~/.agent-pack/` holds what you want in every project — global agents and a global library — and `~/.agent-pack/config.json`, a config layer read before the project's: the project overrides it key by key (a shared library by its alias). `AGENT_PACK_HOME` moves the global home elsewhere.

## Project context

A `PROJECT.ap` at the project root holds the rules every agent working on the project follows. `bundle all` compiles it into the `project` block of `AGENTS.md`:

```
# Project Rules

ABOUT  always-on rules for this project

IMPORT security FROM @main.policies
```

## vars.ap

A `vars.ap` declares [variables](/reference/language#variables) for the agents below it, at three levels: the project root, a team's folder, an agent's folder (a team member's folder is its team's). It holds only `VAR` lines:

```
VAR board = Product                        # a constant — any level
SESSION VAR plan AS implementation-plan    # shared by the session's agents — a team's or the project's vars.ap
VAR draft                                  # private to one agent — the agent's own vars.ap
```

| Level | Constants | `SESSION VAR` | private `VAR` |
|---|---|---|---|
| project root | yes | yes | no |
| team folder | yes | yes | no |
| agent folder | yes | no | yes |

A constant at a deeper level overrides the same one above it: agent over team over project. Every agent also has the constant `name`, its own name. How variables are assigned and read, and what their scopes mean, is in [Language → Variables](/reference/language#variables).

Never put secrets in `vars.ap`: constants are compiled into the agent's output. Tools read secrets from the environment.
