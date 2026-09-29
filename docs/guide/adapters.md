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

To pass options, import the adapter instead of naming it (this needs agent-pack installed in the project, so the import resolves):

```javascript
import cursorAdapter from 'agent-pack/adapters/cursor';

export default {
  adapters: ['claude-code-apx', cursorAdapter({ agentsAlwaysActive: true })],
};
```

## Built-in adapters

| Name | Agent | Playbook | Project pointer |
|---|---|---|---|
| `claude-code` | `.claude/agents/<name>.md` — the whole definition | `.claude/skills/<name>/SKILL.md` | `CLAUDE.md` → `@AGENTS.md` |
| `claude-code-apx` | `.claude/agents/<name>.md` — the agent's own definition (team, identity, mandate, shapes, its own rules) in the same words as `claude-code`, then a pointer to the agent's apx for the rest | as `claude-code` | as `claude-code` |
| `cursor` | `.cursor/rules/<name>.mdc` | `.cursor/rules/<name>.mdc` | — |
| `junie` | `.junie/AGENTS.md` | `.junie/skills/<name>/SKILL.md` | — |

Options:

```javascript
claudeCodeAdapter({ agentsDir: '.claude/agents', skillsDir: '.claude/skills', tools: '*' });
claudeCodeApxAdapter({ agentsDir: '.claude/agents', tools: '*' });
cursorAdapter({ rulesDir: '.cursor/rules', agentsAlwaysActive: false });
junieAdapter({ agentsFile: '.junie/AGENTS.md', skillsDir: '.junie/skills' });
```

A playbook is compiled by path: `agent-pack bundle path/to/file.playbook.ap`.

## Writing an adapter

An adapter is an object:

```typescript
interface AdapterPlugin {
  type: 'adapter';
  apiVersion: 2;
  name: string;
  emitters: {
    agent?: (bundle: AgentBundle, ctx: AdapterCtx) => EmittedFile[];
    playbook?: (bundle: PlaybookBundle, ctx: AdapterCtx) => EmittedFile[];
  };
  /** The harness's own instructions file and the line pointing it at AGENTS.md. */
  projectPointer?: { file: string; content: string };
  /** Harness-native phrases, keyed by keyword: enum values ({ CONTEXT: { full: '…' } }) or force levels ({ MEM: { '0': '…' } }). */
  renderings?: Record<string, Record<string, string>>;
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
