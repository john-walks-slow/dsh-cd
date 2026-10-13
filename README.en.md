# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

Lend `cd` to dsh — re-base the working directory, or move the whole session to another project. The `cd` tool shifts the base that relative paths resolve against (light, reversible); with confirmation it can also move the entire session to another project (sandbox, AGENTS.md, skills, session storage and sidebar grouping all follow).

> Just want to install and go? Skip ahead to [Install](#install). To see the boundary between the two granularities and the conditions of a real switch, read on at [What it gives you](#what-it-gives-you).

## Install

```bash
dsh plugin --profile web add dsh-cd
```

No configuration needed — the bundled `cordis.patch.yml` mounts the plugin automatically, adding a `cd` tool and a `/cd` command.

From GitHub (source install; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-cd
# the first add is blocked by pnpm: put the package name pnpm prints into
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then run it again
```

## What it gives you

### `cd` (the tool)

Two granularities. **The default is the light one.**

| Granularity | Call | Effect |
|---|---|---|
| **Re-base** | `cd {"path": "..."}` | Shifts the base that subsequent tools' relative paths resolve against to `path`; the session keeps its identity. |
| **Real switch** | `cd {"path": "...", "workspace": true, "confirmed": true}` | Moves the **whole** session: sandbox root, AGENTS.md, skill discovery, session storage, sidebar grouping all follow. |
| Query | `cd {}` | Reports the current override directory and any queued real switch. |
| Roll back | `cd {"path": "-"}` | Returns to the previous override directory. |

Usage examples (`path` accepts absolute paths, relative paths, or `~`-prefixed; the target must exist):

```
cd {"path": "/tmp/some-dir"}
cd {"path": "/path/to/other-project", "workspace": true, "confirmed": true}
cd {}
cd {"path": "-"}
```

### `/cd` (the user command)

Type it in the composer; it runs on the host, never reaches the model and costs no model turn.

```
/cd <dir>    # move this session to <dir> (session must be idle)
/cd          # show current directory, workspace, override state and any queued switch
```

### Boundary

Things worth knowing once installed:

- **What the override affects**: `bash`/`pwsh` default workdir; relative paths in `read`/`write`/`edit`/`read_image`/`grep`/`glob`/`present`. Other tools keep their original semantics and need absolute paths.
- **What the override does not move**: MCP configuration, sandbox policy root, project instructions (AGENTS.md), skill discovery, session storage location — these only follow on a real switch.
- **Path resolution in replies**: tool arguments written relative to the override resolve automatically; **markdown links, images and file paths in the visible reply still resolve against the session workspace root** — otherwise they will not open in the GUI. `cd` back to the session workspace root clears the override.
- **Across restarts**: the override is persisted to `$DSH_HOME/dsh-cd/state.json` (atomic write, pruned after 30 days of disuse); the next time the same session is opened, it is restored.
- **Subagents**: any subagent delegated from the session snapshots the parent's override directory at creation (not persisted).
- **A real switch needs the user's go-ahead**: the plugin does not use approval prompts (the default Full access preset rejects them automatically). Instead the protocol is "ask first, repeat the call with `confirmed: true` after agreement". A `workspace: true` call **without** `confirmed` only re-bases and reports "waiting for agreement". The caller must not set `confirmed` on its own initiative.
- **Real switches run only when idle**: the turn in which the caller invokes `workspace: true` keeps working against the new base (relative paths work immediately); the actual move is performed when that turn ends and the session is idle.
- **Worktrees generally do not need a real switch**: when working in a git worktree, leave `workspace: false`; the real switch is for cases where the centre of work moves for good.

## What a real switch does (implementation reference)

DSH has no official API for moving a session, so this plugin does it in three steps:

1. **Disk**: move the session directory into the new workspace and rewrite the first frame of the log header; every later frame is copied **byte for byte**, no re-compression.
2. **Memory**: swap the frozen `session.header`, redirect the JSONL write handle, refresh the header index.
3. **Ledger**: detach the old workspace and attach the new one.

Any step failing rolls back the move entirely; the plugin does not provide a degraded mode.

## Permissions and compatibility

- **No network, no external services**: only a local "session → override directory" map, plus calls to the host's workspace registry and session persistence services.
- **Writes**: `$DSH_HOME/dsh-cd/state.json` (atomic write, pruned after 30 days of disuse). A real switch additionally **moves the session's own log file** and updates its entry in `$DSH_HOME/storages/workspace.json` — both are DSH's own data files.
- **A real switch is gated on agreement**: it only queues when the same call carries `confirmed: true`; there is no bypass and no degraded mode. Running `/cd <dir>` yourself needs no second confirmation.
- **The caller can create workspaces**: a `workspace: true, confirmed: true` call against a directory that is not yet a workspace causes the plugin to create a workspace record for it. Under `workspace-write` sandbox mode that means the user, once agreeing to the move, gives the caller a sandbox root pointed at any existing directory; under `danger-full-access` this changes nothing. If that is not acceptable, do not grant the `cd` tool or switch to a more restricted preset.
- **Prompt-level, not a mechanism**: the reply-path base is decided by the DSH Web GUI (always the session workspace root); the plugin cannot rewrite model output, so it constrains through the injected notice.
- **Sidebar after a switch**: the session itself works immediately (verified by e2e in the same page), but the sidebar grouping depends on the client's cached session list and usually needs a page refresh (F5) to show the session under its new workspace; `/cd`'s reply will mention this.
- **Host requirements**: `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-home-paths` are declared as peerDependencies in the range `^0.1.5-rc.3 || ^0.2.0-rc.1` (supplied by the host, never installed twice). A real switch additionally needs the host's `sessionPersistence` and `workspaceRegistry` services (provided by `dsh-base`; `cd`/`/cd` report a clear error when they are missing). Node.js ≥ 22.5.

## Development

Link it into a profile for local debugging:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# add "dsh-cd" to the dsh.profile.bundles array in package.json, then restart dsh
```

Build and test:

```bash
npm install             # runs prepare → builds dist/
pnpm check              # type check
npm test                # build + behavior tests (frame surgery / ledger / rollback / real-log round-trip)
npm run e2e:cd          # re-base e2e
npm run e2e:workspace   # real switch e2e
```

Sources and design notes:

- `src/index.ts` (wiring), `src/relocate.ts` (the switch engine), `src/command.ts`, `src/context.ts`, `src/state.ts`
- `docs/features/260927-cd-tool/` and `docs/features/261012-workspace-switch/`

## Release a new version

```bash
npm run release                                                # test + npm version patch (commit+tag) + pack to /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<version>.tgz
git push --follow-tags
```

Verify with `npm view dsh-cd version` afterwards.

## License

MIT

## Community

Thanks to the [LINUX DO](https://linux.do/) community for providing the discussion environment.
