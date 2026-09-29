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

A `vars.ap` in an agent's folder defines values substituted into the text of the agents there at compile time, written `{{name}}`:

```
VAR board = Product
```

Never put secrets in `vars.ap`: the values are compiled into the agent's output. Tools read secrets from the environment.
