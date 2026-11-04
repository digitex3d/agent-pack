# Adapters

An **adapter** writes a compiled agent into the format a harness reads: where the file goes, its frontmatter, its body. The compiler stays harness-agnostic; adapters only project.

Whatever adapters are configured, `bundle all` always writes each agent's [apx](./apx.md) and the project's `AGENTS.md`.

## Configuring

Name the built-in adapters in `agent-pack.config.mjs`:

```javascript
export default {
  adapters: ['claude-code-apx', 'cursor'],
};
```

`bundle all` writes every agent for every configured adapter. `--adapter <name>` restricts a run to one adapter — configured or built-in:

```bash
agent-pack bundle all --adapter cursor
```

A built-in takes its options in the config too, with its name: `{ name: '<built-in>', …options }`. `models` maps each [`BUDGET`](/reference/language#agent) tier to a model of that harness — see [Models](#models):

```javascript
export default {
  adapters: ['claude-code', { name: 'opencode', models: { cheap: 'opencode/deepseek-v4.1-flash-free', costly: 'opencode/claude-opus-4-5' } }],
};
```

Or import the adapter and call it (this needs agent-pack installed in the project, so the import resolves):

```javascript
import cursorAdapter from 'agent-pack/adapters/cursor';

export default {
  adapters: ['claude-code-apx', cursorAdapter({ agentsAlwaysActive: true })],
};
```

## Built-in adapters

| Name | Agent | Skill | Project pointer |
|---|---|---|---|
| `claude-code` | `.claude/agents/<name>.md` — the whole definition | `.claude/skills/<name>/SKILL.md` | `CLAUDE.md` → `@AGENTS.md` |
| `claude-code-apx` | `.claude/agents/<name>.md` — the agent's own definition (team, identity, mandate, shapes, its own rules) in the same words as `claude-code`, then a pointer to the agent's apx for the rest | `.claude/skills/<name>/SKILL.md` — the same, under the skill's frontmatter | as `claude-code` |
| `cursor` | `.cursor/rules/<name>.mdc` | `.cursor/rules/<name>.mdc` | — |
| `codex` | `.codex/agents/<name>.toml` — `name`, `description`, `developer_instructions` | `.agents/skills/<name>/SKILL.md` | — (Codex reads `AGENTS.md` itself) |
| `opencode` | `.opencode/agents/<name>.md` — `description` frontmatter, `model` when the agent's `BUDGET` tier maps to one, the instructions as body; no `mode`, so `opencode run --agent` launches it | `.agents/skills/<name>/SKILL.md` | — (opencode reads `AGENTS.md` itself) |

Options:

```javascript
claudeCodeAdapter({ agentsDir: '.claude/agents', skillsDir: '.claude/skills', tools: '*' });
claudeCodeApxAdapter({ agentsDir: '.claude/agents', skillsDir: '.claude/skills', tools: '*' });
cursorAdapter({ rulesDir: '.cursor/rules', agentsAlwaysActive: false });
codexAdapter({ agentsDir: '.codex/agents', skillsDir: '.agents/skills', models: {} });
opencodeAdapter({ agentsDir: '.opencode/agents', skillsDir: '.agents/skills', models: {} });
```

A skill is an agent: `bundle all` builds every `EXPORT SKILL` of the project library, with its apx, and the adapter writes it as a skill instead of a subagent. The frontmatter carries its name and its `ABOUT` as `description`.

An adapter may word how an imported skill is loaded: `renderings.SKILL.apx` (an agent-pack skill, `{command}` its apx) and `renderings.SKILL.harness` (a skill of the harness, `{name}`). `claude-code` says to load the harness's skills with the Skill tool.

An adapter may word how its harness hands work out and waits, over the neutral words of a flow's lines (`src/config/formulas.json`, keywords `DELEGATE`, `FORK`, `WAIT`): `renderings.DELEGATE.background` (how a `~` starts), `renderings.FORK.self` / `.agent` (a fork; `{definition}` is the command that reads the agent's definition), `renderings.WAIT.run` (`{apx}`, `{ids}`, `{max}`). `claude-code` uses them for its own way of working:

- a `~` is a background agent (the Agent tool, `run_in_background: true`);
- a `WAIT` never blocks the session: Claude Code tells it when a background agent ends, between turns — the lead goes on only when the notification of each piece has come, then checks the states with `apx wait … --now`, the limit counted from when each piece started;
- a `FORK` is a native fork (`subagent_type: "fork"`); a `FORK … BY y` first reads who `y` is (`y.apx scope`) and follows its rules from there.

Every other adapter keeps the neutral words: `apx wait` blocks until each piece is settled or the limit is reached.

An adapter may keep the project's settings too (`projectSettings`, called once per build, after every agent): `claude-code` keeps the perimeter there. When some agent works under one — an `@WITHIN`, a `DELEGATE~`, a `MARK` — `bundle all` adds two hooks to `.claude/settings.json`, on `Write|Edit|MultiEdit|NotebookEdit`: before a write, `.agent-pack/hooks/claude-code-guard.mjs before` asks the apx (`guard`) and denies a write outside the perimeter of the work in progress; after one in a contract's copy, `… after` warns when the file is outside the contract. The settings' hooks run inside subagents too, with `agent_id` and `agent_type` in their input: that is how the apx knows who writes. Only agent-pack's own entries are written or removed — the rest of the file stays as it is — and they go when no agent works under a perimeter. A write the hook cannot check is denied: the check failing never lets a write through.

## Models

The `.ap` source never names a model: an agent declares a [`BUDGET`](/reference/language#agent) tier — `cheap`, `moderate` or `costly` — and each adapter maps the tiers to models of its harness. A project config maps them per adapter, with `models`:

```javascript
export default {
  adapters: [
    { name: 'claude-code', models: { costly: 'opus' } },
    { name: 'opencode', models: { cheap: 'opencode/deepseek-v4.1-flash-free' } },
    { name: 'codex', models: { moderate: 'gpt-5-codex' } },
  ],
};
```

| Adapter | Without `models` | Where the model goes |
|---|---|---|
| `claude-code`, `claude-code-apx` | `cheap` haiku, `moderate` sonnet, `costly` opus — the config maps over them | the agent's `model:` |
| `opencode` | none: opencode's own default | the agent's `model:`, and `--model` when another harness launches it |
| `codex` | none: codex's own default | `-m` when another harness launches it |
| `cursor` | — | — |

A key that is no tier, or a model that is no text, fails the config. An agent with no `BUDGET` runs on what the harness picks — with Claude Code, [`delegate.models`](/reference/config#delegate), else `inherit`; a `BUDGET` wins over `delegate.models`.

When a flow delegates to an agent of another harness (`BY opencode:fixer`, below), the agent runs on the model its tier maps to on *that* harness. An agent whose tier the harness maps to none is a warning at build — it runs on the harness's own default model — never an error: the work still runs.

## Delegating to another harness

An adapter is two-sided. Out, it writes the agents in its harness's form. In, it says how an agent on another harness launches one of its agents, from outside: `invocation`, a recipe in an `.ap` TEMPLATE — `invoke.ap` beside the adapter — whose BODY is the command line and whose slots' rules say how to run it.

```
BODY:
    codex exec -C {project} -s workspace-write --skip-git-repo-check --ephemeral --color never -o {answer} {shape} - < {prompt}
```

The apx fills it when the piece starts (`delegate start`, or `contract start` for a list of contracts): `{project}` the piece's copy, `{agent}`, `{prompt}` the file it writes, `{answer}` the file the command writes, `{shape}` the adapter's `shape` flag with its JSON Schema when the line has an `AS`, `{model}` the adapter's `model` flag with the model the agent's `BUDGET` tier maps to — left out when it maps to none. `carry` lists the files the copy is given from the working folder — the agent's definition, generated and often untracked — and `intro` the prompt's first line, for a CLI that picks the agent by its prompt.

```javascript
invocation: { recipe: '<dir>/invoke.ap', cli: 'codex', shape: '--output-schema {schema}', model: '-m {model}', carry: ['.codex/agents/{agent}.toml', 'AGENTS.md'], intro: 'Have the custom agent `{agent}` carry out the task below, and answer with its result.' }
```

`agent-pack harness list` shows every harness: installed (shipped, or an adapter object of the config), enabled (in `adapters:`), delegable (enabled, with a recipe), and whether its CLI is on the PATH — looked up, never run. `claude-code`, `codex` and `opencode` ship a recipe; `cursor` has none, and cannot be delegated to.

opencode has no flag that writes its last message to a file, nor one that binds the answer's form: its recipe runs `opencode run {model} --agent {agent} --dir {project} --format json` (`{model}` is `--model <provider/model>`, as `opencode models` lists them), the prompt on stdin, and a `node` filter on the same line keeps only the answer text of the JSON events for `{answer}` — the form of an `AS` is asked for in the prompt only. It runs without `--auto`: opencode then refuses on its own every permission it would ask for (a path outside the copy, for one), and the filter lists those refusals after the answer, for the harness that launched it to decide on.

## Writing an adapter

An adapter is an object:

```typescript
interface AdapterPlugin {
  type: 'adapter';
  apiVersion: 2;
  name: string;
  emitters: {
    agent?: (bundle: AgentBundle, ctx: AdapterCtx) => EmittedFile[];
    skill?: (bundle: SkillBundle, ctx: AdapterCtx) => EmittedFile[];
  };
  /** The harness's own instructions file and the line pointing it at AGENTS.md. */
  projectPointer?: { file: string; content: string };
  /** Harness-native phrases, keyed by keyword: enum values ({ CONTEXT: { full: '…' } }), force levels ({ MEM: { '0': '…' } }) or skill loading ({ SKILL: { harness: '…' } }). */
  renderings?: Record<string, Record<string, string>>;
  /** The model of each BUDGET tier on this harness ({ cheap: '…' }) — a tier left out runs on the harness's default. */
  models?: Partial<Record<'cheap' | 'moderate' | 'costly', string>>;
}
```

An emitter receives the bundle — `name`, `body` (the compiled markdown), `metadata` (keyword → values, e.g. `ABOUT`), `structure` (the compiled document) — and the context (`projectRoot`, `outputDir`), and returns the files to write as `{ path, content }`. Declare only the kinds the adapter handles: asking it to emit another kind is an error.

```javascript
import { resolve } from 'path';

const plainText = {
  type: 'adapter',
  apiVersion: 2,
  name: 'plain-text',
  emitters: {
    agent: (b, ctx) => [{ path: resolve(ctx.projectRoot, 'prompts', `${b.name}.txt`), content: b.body }],
  },
};

export default { adapters: [plainText] };
```
