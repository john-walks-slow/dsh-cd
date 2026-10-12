# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that adds a `cd`: it **re-bases relative paths** so the file tools and the bash default workdir follow the new directory, while the session itself stays where it is.

> **Since 0.3.0 the real workspace switch has moved out of this plugin (breaking change).** Changing a session's identity — moving its stored
> log, re-pinning its sandbox root, rebinding its workspace — is now provided by
> [dsh-manage-session](https://github.com/john-walks-slow/dsh-manage-session) as the `session_move` tool and
> `/move` (`/cd` is an alias), and **no longer belongs to dsh-cd**.

## What it is / why it exists

A dsh session's working directory (`session.header.cwd`) is frozen at creation and is part of the session's identity — it determines where the session is stored, the sandbox root, and where AGENTS.md and skills are discovered, so dsh deliberately does not allow changing it mid-session. Whenever the model needs to work outside the workspace (say, "go tidy up the logs in /tmp"), every read/write/bash call has to carry a full absolute path — long and error-prone.

dsh-cd answers lightly: it leaves the session's identity alone and only moves the base that relative paths resolve against — and it can be moved back at any time.

Under an override, tools change like this:

| Tool | Behavior change |
|---|---|
| `bash` / `pwsh` | With no `workdir`, runs in the override directory; a relative `workdir` resolves there too |
| `read` / `write` / `edit` / `read_image` | A relative `file_path` resolves there |
| `glob` / `grep` | With no `path`, searches the override directory; a relative `path` resolves there |
| `present` | A relative `files[].path` resolves there |
| Everything else | Unaffected, original semantics (absolute paths) |

**Deliberately not moved**: sandbox policy root, project instructions (AGENTS.md), skill discovery, MCP configuration, session storage, workspace membership. `cd` back to the session workspace root clears the override. When all of that should move too, use `session_move` / `/move` from dsh-manage-session instead.

## Install

```bash
dsh plugin --profile web add dsh-cd
```

No configuration needed; the bundled `cordis.patch.yml` mounts the plugin automatically and the model gains a `cd` tool.

From GitHub (source install; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-cd
# the first add is blocked by pnpm: put the package name pnpm prints into
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then run it again
```

## For the model

```
cd {"path": "/tmp/some-dir"}   # re-base: absolute, relative to the current base, or ~-prefixed
cd {"path": "-"}               # back to the previous directory
cd {}                          # current directory
```

Details:

- The target must be an existing directory (symlinks are resolved to their real path), otherwise it errors.
- The override is **per session**: one session's `cd` does not affect others.
- `cd` back to the session workspace root clears the override.
- While an override is active, a short notice is injected into the system prompt (a cache-safe runtime-context snapshot that exists only while the override is active): **tool arguments** resolve against the override, whereas **paths in the visible reply** — markdown links, images, file mentions — still resolve against the session workspace root (write them workspace-relative or absolute, or the links will not open).
- **Persistence across restarts**: the override is stored in `$DSH_HOME/dsh-cd/state.json` (atomic write, pruned after 30 days of disuse). Reopening the session after an instance restart restores it.
- **Subagent inheritance**: a delegated subagent snapshots its parent session's override directory at creation time (inherited entries are never persisted).
- **A git worktree is the typical use case**: a path re-base is all you need while working in one.

## What the model sees

While an override is active, the Runtime Context snapshot assembled at each step carries this paragraph (appended only when the text changes, so steady turns reuse the previous one):

```
[dsh-cd] Working-directory override active for this session: /home/me/project/legacy. Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths. Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root (/home/me/project), so write them workspace-relative (a file at /home/me/project/legacy/report.md is written "legacy/report.md") or absolute — reply paths written relative to the override will not open. The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.
```

When the override directory sits outside the workspace root, the conversion example is omitted (only absolute paths can work in the reply).

## Permissions and compatibility

- **No network, no external services**: the plugin keeps a "session → override directory" map in memory and one state file.
- **Reads, never writes, session data**: the only file it writes is its own `$DSH_HOME/dsh-cd/state.json` (tmp+rename atomic write, pruned after 30 days of disuse). It does **not** touch dsh session logs, the `workspace.json` ledger or any workspace record.
- **Prompt-level, not a mechanism**: the reply-path base is decided by the DSH Web GUI (always the session workspace root); the plugin cannot rewrite model output, so it constrains the model through the injected notice.
- **Host requirements**: `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-home-paths` are declared as peerDependencies in the range `^0.1.5-rc.3 || ^0.2.0-rc.1` (supplied by the host, never installed twice); Node.js >= 22.5.

## Development

Link it into a profile for local debugging:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# then add "dsh-cd" to the dsh.profile.bundles array in package.json and restart dsh
```

```bash
npm install    # runs prepare → builds dist/
pnpm check     # type check
npm test       # build + behavior tests (re-base / '-' / clearing / restart restore)
npm run e2e:cd # GUI end-to-end (start dsh-e2e --wait-ready first)
```

- Sources: `src/index.ts` (wiring, the `cd` tool and the shadow tools), `src/context.ts` (the runtime-context notice), `src/state.ts` (state persistence).
- Design and research notes: `docs/features/260927-cd-tool/`; the host-source exploration and implementation record of the real switch lives in `docs/features/261012-workspace-switch/` (that capability has moved to dsh-manage-session).

## Release a new version

```bash
npm run release                                                # test + npm version patch (commit+tag) + pack to /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<version>.tgz
git push --follow-tags
```

Verify with `npm view dsh-cd version` afterwards.

## License

MIT
