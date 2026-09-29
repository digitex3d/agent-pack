# CLI Reference

```bash
agent-pack <command> [options]
```

| Global option | |
|---|---|
| `--config <path>` | config file (default: `./agent-pack.config.mjs`) |
| `--help` | show the commands |
| `--version` | show the installed version |

## `init`

```bash
agent-pack init
```

Writes a default `agent-pack.config.mjs` (the `claude-code` adapter) and the `.agent-pack/` directory. In an interactive terminal it then offers two example agents, each copied to `agents/standalone/` on a yes: `agent-pack-developer` (writes and edits your `.ap` files) and `web-researcher` (researches a question on the web and answers with sources). Existing files are never overwritten.

## `bundle`

```bash
agent-pack bundle all            [--adapter <name>] [--out <dir>] [--watch] [--apx-compress | --no-apx-compress]
agent-pack bundle <name|path>    [--adapter <name>] [--out <dir>] [--apx-compress | --no-apx-compress]
```

**`bundle all`** discovers every agent under `agentsDir` and compiles it for every configured adapter. It writes:

- each adapter's files for each agent;
- each agent's apx, `.agent-pack/apx/<agent>.apx`, and its compiled document, `.agent-pack/compiled/<agent>.ap.json`;
- `AGENTS.md` — the project context from `PROJECT.ap` (when present) and the orchestration of every standalone agent and team — plus each adapter's pointer to it (`CLAUDE.md` for Claude Code).

AGENTS.md and CLAUDE.md are written as managed blocks: whatever you write outside them is kept. Scripts in `distilled/` that no `DISTILL` procedure owns any more — because it was edited or removed — are listed, never deleted.

**`bundle <name|path>`** compiles one agent by name, or a playbook by the path of its `.playbook.ap` file.

| Option | |
|---|---|
| `--adapter <name>` | only this adapter — a configured one, or a built-in by name |
| `--out <dir>` | output directory for the neutral markdown (used when no adapter applies) |
| `--watch` | `bundle all` only: rebuild on every change to a `.ap` file; stop with Ctrl+C |
| `--apx-compress` | store the apx data gzipped (overrides `bundle.apxCompress`) |
| `--no-apx-compress` | store the apx data as compact JSON (overrides `bundle.apxCompress`) |

## `agents list`

```bash
agent-pack agents list [--domain project|global|library] [--json]
```

Lists the agents agent-pack can find, grouped by domain: the project's own, the global ones in `~/.agent-pack`, and the library's. `--json` prints machine-readable output.

## The apx

Each compiled agent has its own executable, `.agent-pack/apx/<agent>.apx`, run by Node alone. Its verbs — `start`, `ls`, `get`, `flow`, `run`, the stores — are in [The apx](/guide/apx).
