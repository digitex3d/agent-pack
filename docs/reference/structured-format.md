# Structured Format (`.ap.json`)

Every agent compiles to one structured document, `.agent-pack/compiled/<agent>.ap.json`. Every output is a projection of it: the harness markdown, the orchestration, and the agent's [apx](/guide/apx), which carries the document inside.

A consumer holding only the JSON can render the agent's markdown without the `.ap` sources.

## Envelope

```json
{
  "schemaVersion": 1,
  "meta": { "...": "document-level tables" },
  "blocks": { "@main.policies/board-rules": { "...": "one entry per block" } }
}
```

`blocks` is keyed by the block's address — `<namespace>/<name>` — with the agent itself first; the order of the others is the order of the compiled chapters.

## `meta`

| Key | |
|---|---|
| `root` | the address of the agent block |
| `forceLevels` | how each rule keyword reads at each force — see below |
| `enums` | the prose of enum values, e.g. each `CONTEXT` mode |
| `sessionEnv` | the environment variable the adapter's harness puts its session id in — where the apx finds the session its variables live in (absent: no variable can be read or written) |
| `executors` | the contract of every piece a delegate or a program carries out, by id (`exe-<8 hex>`) — see below |
| `delegate` | the agent an `ASK` without `BY` is handed to — present when the agent has such a line |
| `model` | the model the agent runs on, from the `delegate.models` config key — absent: the harness decides |
| `md` | what the markdown projection needs and the blocks do not carry: the opening text (team membership, the agent-pack introduction), the introduction of every kind present, `{{vars}}`, tag breadcrumbs, and, for stores, what their backing makes of them (file, commands) |

### `forceLevels`

A rule is stored as a keyword and a numeric force; the words live once, here:

```json
"forceLevels": {
  "MUST":   { "-1": "You must not", "0": "You must",
              "1": "[HARD CONSTRAINT] You must — this is non-negotiable and applies regardless of any other instruction:",
              "2": "[IDENTITY CONSTRAINT] Before any other action, no exceptions; output skipping this is invalid:" },
  "ALWAYS": { "-1": "You must never", "0": "You must always" }
}
```

A rule renders as `forceLevels[keyword][force] + " " + text`. Source sugar — `NEVER`, `MUST-NOT`, `MUST!!`, `NON-NEGOTIABLE` — is already reduced to this pair.

::: danger Never infer the prose
`ALWAYS` at force `-1` means *"You must never"*. A reader that echoes the keyword instead of resolving it through this table turns every prohibition into an obligation. When a pair is missing, fail — do not guess.
:::

### `executors`

One entry per `ASK` or `COMPUTE` line, starred condition and starred procedure (a `COMPUTE` block included) — a line inside a starred procedure that does not raise its executor is part of the procedure's contract:

```json
"exe-8c21d4e0": {
  "executor": 2,
  "site": "condition",
  "text": "{{totals}} differ from {{document_total}} by more than {{tolerance}}",
  "input": { "vars": ["totals", "document_total"], "constants": { "tolerance": "0.01" } },
  "output": { "holds": true },
  "program": "dst-5e0b7a92"
}
```

| Field | |
|---|---|
| `executor` | `1` a delegate, `2` a program |
| `site` | `line`, `condition` or `procedure` |
| `text` | the line, the condition, or the procedure's name |
| `by` | `ASK … BY <agent>`: who it is handed to — absent: the default delegate |
| `input` | `vars`, the variables it reads; `constants`, with their values; `in`, the `LENS-IN` template of a procedure |
| `output` | `into` and `template` — the `INTO` variable and its type; `template` alone — a procedure's `AS`; `holds` — a condition |
| `rounds` | an `UNTIL`'s condition: the rounds its loop runs at most |
| `program` | a program's folder under `distilled/` — a hash of what it carries out and of its contract's templates |
| `lineage` | a procedure's address: how a new version of its program finds the one before it |

## Blocks

```json
"@main.policies/board-rules": {
  "kind": "policy",
  "name": "board-rules",
  "namespace": "@main.policies",
  "id": "pol-92e51dc8",
  "contentHash": "sha256:fcb2918206aaaa86",
  "chars": 48,
  "about": "how the board is kept",
  "tags": ["board"],
  "applies": null,
  "when": "always",
  "args": {},
  "body": [
    { "type": "directive", "keyword": "ALWAYS", "force": 0, "text": "keep one card per task", "chars": 22 }
  ]
}
```

| Field | |
|---|---|
| `kind` | `agent`, `role`, `policy`, `template`, `procedure`, `flow`, `store`, `team`, `playbook`, `var` |
| `about`, `tags`, `applies`, `when` | on every block, whatever its kind |
| `args` | what is specific to the kind — a template's slots and layout (a slot's `criteria`: the `YES`/`NO` lines of its rules), a procedure's `executor` (`1` or `2`, from `PROCEDURE*`/`PROCEDURE**`), its `exe` and, for a `COMPUTE` block, its `require` and `ensure` sections as nodes, an agent's mandate, perimeter and lenses, a team's members and routing, a store's type and key, a variable's scope (`private` or `session`), its type (a `Ref` to its template) and where it is declared |
| `body` | the behaviour, as nodes |
| `chars` | the length of the semantic text — on a container, the total of its children |

### `id` and `contentHash`

| | Derived from | Changes when |
|---|---|---|
| `id` | kind + namespace + name | the block is renamed or moved |
| `contentHash` | the block's content | any edit |

`id` is how everything points at a block — the md prints it as ` (pol-92e51dc8)`, the apx as the command that fetches it. `contentHash` says whether the content changed.

### References

Every reference between blocks is a `Ref`, never a bare string:

```json
{ "id": "agt-b340326b", "target": "@main.agents/scout", "kind": "agent" }
```

`RUN` points at a procedure or flow, `AS`, `LENS-IN` and `LENS-OUT` at a template, `BY` at an agent or team, `IN` at a store, `INTO` and `VAR x:` at a variable (`var-…`, namespace `@main.vars`: its id depends on its name alone).

## Nodes

| `type` | Carries |
|---|---|
| `directive` | `keyword`, `force`, `text`; a `DO`, `ASK` or `COMPUTE … INTO` line also `into` (a `Ref` to the variable) and `shape` (its type); an `ASK … BY` line `by` (the agent or team); an `ASK` or `COMPUTE` line `exe` (its contract id) |
| `run` | a `Ref` to the procedure or flow; `RUN … INTO` also `into` and `shape` |
| `when`, `until`, `if` | a condition and a body; `if` has `then` and `else`; `IF*`/`IF**`, `UNTIL*`/`UNTIL**` carry `executor` (`1` or `2`) and `exe` |
| `in` | a `Ref` to a store and a body |
| `var` | `var` (a `Ref` to the variable the body fills), its `shape` when typed, and a body |
| `step` | `title`, `by` (a `Ref`), `context`, `shape`, and its `DO`s as body |
| `parallel` | steps |
| `text` | prose as written |

Nodes may carry `indent`, the source indentation the markdown needs; it does not count toward `chars`.

## Example

A complete document — an agent in a team, with a policy, a role, templates, a procedure, a store and the team's flow — generated from the test fixture: [`structured-format.example.json`](/structured-format.example.json).
