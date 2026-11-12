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
agent-pack bundle all            [--adapter <name>] [--out <dir>] [--watch] [--apx-compress | --no-apx-compress] [--no-judge | --judge-strict]
agent-pack bundle <name|path>    [--adapter <name>] [--out <dir>] [--executable [--target <bun target>]] [--apx-compress | --no-apx-compress] [--no-judge | --judge-strict]
```

**`bundle all`** discovers every agent under `agentsDir` and compiles it for every configured adapter. It writes:

- each adapter's files for each agent;
- each agent's apx, `.agent-pack/apx/<agent>.apx`, and its compiled document, `.agent-pack/compiled/<agent>.ap.json`;
- with a main, its apx, `.agent-pack/apx/<main>.apx`: every agent it holds in one file, run as `node .agent-pack/apx/<main>.apx <agent> <verb>` — see [The apx](/guide/apx#the-main);
- `AGENTS.md` — with a main (the root `.ap` file holding a `MAIN:` block), only what boots it: its name, the command that prints it, and its universal policies; with none, the orchestration of every team and standalone agent — plus each adapter's pointer to it (`CLAUDE.md` for Claude Code).

AGENTS.md and CLAUDE.md are written as managed blocks: whatever you write outside them is kept. Program folders in `distilled/` that no piece owns any more — because it was edited or removed — are listed, never deleted (see [Programs](/reference/language#programs)). The default delegate, `quick`, is built with the agents when one of them hands it work (`DELEGATE` without `BY`) and the project has no agent of that name.

**`bundle <name|path>`** compiles one agent or skill, by name or by the path of its file.

**`bundle <main | team> [--executable]`** builds what `bundle all` builds — every team gets its apx too, `.agent-pack/apx/<team>.apx`; with `--executable` it then compiles that unit's apx into one executable, `.agent-pack/bin/<main | team>`. For the main, every agent it holds is inside, and `AGENTS.md` boots the main from it until the next `bundle all` points it back at the apx; a team's executable leaves `AGENTS.md` as it is.

**`bundle <name> --executable`** compiles the agent, then its apx with [Bun](https://bun.sh) into one executable, `.agent-pack/bin/<agent>`: the engine and the agent's data in a single file. The apx is the development form, run by Node; the executable is the form to hand out. It answers the verbs as the apx does and keeps its paths: run from the project, it finds the same state, stores and programs. Bun must be on the PATH, and `bundle all --executable` is refused — name the agent. Only the agent's context is inside: the stores, the distilled programs and the tabeli engine stay where they are, so the executable is not yet self-contained, and only `ls`, `start`, `get` and `set` are tested on it so far.

| Option | |
|---|---|
| `--adapter <name>` | only this adapter — a configured one, or a built-in by name |
| `--out <dir>` | output directory for the neutral markdown (used when no adapter applies) |
| `--watch` | `bundle all` only: rebuild on every change to a `.ap` file; stop with Ctrl+C |
| `--executable` | `bundle <name>` only: also compile the agent's fresh apx with [Bun](https://bun.sh) into one executable, `.agent-pack/bin/<agent>` — see below |
| `--target <bun target>` | with `--executable`: build for another platform (`bun-linux-x64`, `bun-darwin-arm64`, …), the file named after it, `<agent>-linux-x64` |
| `--apx-compress` | store the apx data gzipped (overrides `bundle.apxCompress`) |
| `--no-apx-compress` | store the apx data as compact JSON (overrides `bundle.apxCompress`) |
| `--no-judge` | skip the judge phase for this run |
| `--judge-strict` | a line the judge cannot check yet (judge unreachable, no saved verdict) is an error — `judge.offline: 'error'` for this run |

## `agents list`

```bash
agent-pack agents list [--domain project|global|library] [--json]
```

Lists the agents agent-pack can find, grouped by domain: the project's own, the global ones in `~/.agent-pack`, and the library's. `--json` prints machine-readable output.

## The apx

Each compiled agent has its own executable, `.agent-pack/apx/<agent>.apx`, run by Node alone. Its verbs — `start`, `ls`, `get`, `set`, `flow`, `check`, `input`, `answer`, `run`, the stores — are in [The apx](/guide/apx).
