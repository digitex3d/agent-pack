# plugin-example

A plugin you can read in two minutes and bundle as it is: `checklist`, a list of checks an agent goes through before it
delivers. The apx remembers, in each session, which items are ticked.

```
plugins/checklist/
  plugin.ap         # the manifest — the block it adds and the apx commands that serve it
  service.mjs       # one function per command — the only code you write
agents/standalone/
  releaser.ap       # an agent with a CHECKLIST of its own, and one imported from the library
library/checklists/
  before-deploy.ap  # a CHECKLIST in the library, imported with IMPORT … FROM @main.checklists
```

## How a plugin is made

**One name.** The manifest's `PLUGIN checklist:` gives everything else: the block `CHECKLIST`, the library folder
`checklists/`, the ids `che-…`, the commands `<apx> checklist <operation> <che-id>`.

**The block is a template.** `AS checklist` names the template whose slots are the block's lines: the slot `item` is
the line `ITEM`. It is a `LIST`, so the line is written once per item; `1..` makes at least one required. Each item is a
`check` — a text of at most 8 words. A block that breaks this fails the build, where it is written:

```
releaser.ap:7  CHECKLIST before-release: ITEM line 1: expected ≤8 words, got 12
```

**Each command is an `OPERATION`.** It has its `ABOUT`, and — when it takes something after the id — `AS` the template
of its input. `tick` takes an `item`, written `item='…'` on the command line.

**The service does only the work.** `service.mjs` exports a function per operation, with the same name. Before calling
it, the apx has checked the operation, the id and the input against the manifest, so `tick` receives the checklist and a
valid `item` and only has to remember it. `state` is the checklist's memory in the session.

`bundle` refuses a manifest and a service that do not agree: an operation without its function, a function no operation
declares, a template the manifest names but does not declare.

## Try it

From the root of your project, with agent-pack installed globally:

```bash
agent-pack init
cp -r "$(npm root -g)/agent-pack/templates/examples/plugin-example/"{plugins,agents,library} .
```

Name the plugin in `agent-pack.config.mjs`:

```js
plugins: ['plugins/checklist'],
```

Then `agent-pack bundle all`. The definition of `releaser` has a *Checklists* chapter with both checklists, their items
and their commands:

```
## `before-release` — what a release needs before it goes out
- ITEM: the tests pass
- ITEM: the changelog has an entry
- ITEM: the version is bumped

Its commands:
- `node .agent-pack/apx/releaser.apx checklist status che-…` — every item, ticked or not
- `node .agent-pack/apx/releaser.apx checklist tick che-… item=<check>` — mark one item done
```

The agent runs them in its session:

```bash
node .agent-pack/apx/releaser.apx checklist tick che-… item='the tests pass'
node .agent-pack/apx/releaser.apx checklist status che-…
# x  the tests pass
#    the changelog has an entry
#    the version is bumped
```

`node .agent-pack/apx/releaser.apx checklist` lists the agent's checklists with their ids. The state needs the session
id the harness gives — with the `claude-code` adapter, `CLAUDE_CODE_SESSION_ID`.
