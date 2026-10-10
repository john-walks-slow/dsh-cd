# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that adds a `cd` tool: the model can **switch the session's working directory in place**. Afterwards relative paths in the file tools and the bash tool's default workdir resolve against the new directory, so no call has to spell out a long absolute path.

## What it is / why it exists

A dsh session's working directory (`session.header.cwd`) is frozen at creation and is part of the session's identity — it determines where the session is stored, the sandbox root, and where AGENTS.md and skills are discovered, so dsh deliberately does not allow changing it mid-session. Whenever the model needs to work outside the workspace (say, "go tidy up the logs in /tmp"), every read/write/bash call has to carry a full absolute path — long and error-prone.

dsh-cd registers a model-facing `cd` tool that solves this without touching the session identity: it keeps a per-session "working-directory override" in the tool execution layer. After `cd /some/dir`:

| Tool | Behavior change |
|---|---|
| `bash` / `pwsh` | With no `workdir`, runs in the new directory; a relative `workdir` resolves there too |
| `read` / `write` / `edit` / `read_image` | A relative `file_path` resolves there |
| `glob` / `grep` | With no `path`, searches the new directory; a relative `path` resolves there |
| `present` | A relative `files[].path` resolves there |
| Everything else | Unaffected, original semantics (absolute paths) |

**Deliberately not moved** (the session workspace root stays put): sandbox policy root, project instructions (AGENTS.md), skill discovery, MCP configuration, session storage location. `cd` back to the session workspace root clears the override and everything returns to normal.

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

## Usage

Zero configuration. The model gets one more tool:

```
cd {"path": "/tmp/some-dir"}   # absolute, relative, or ~-prefixed
cd {"path": "-"}               # back to the previous directory
cd {}                          # query the current directory (cwd, override, previous)
```

Details:

- The target must be an existing directory (symlinks are resolved to their real path), otherwise it errors.
- The override is **per session**: one session's `cd` does not affect others.
- `cd` back to the session workspace root clears the override.
- While an override is active, a short notice is injected into the system prompt (a cache-safe runtime-context snapshot that exists only while the override is active): **tool arguments** resolve against the override, whereas **paths in the visible reply** — markdown links, images, file mentions — still resolve against the session workspace root (write them workspace-relative or absolute, or the links will not open), plus the boundary that does not move.
- **Persistence across restarts**: the override is stored in `$DSH_HOME/dsh-cd/state.json` (atomic write, pruned after 30 days of disuse). Reopening the session after an instance restart restores it.
- **Subagent inheritance**: a delegated subagent snapshots its parent session's override directory at creation time (inherited entries are never persisted).

## What the model sees

While the override is active, the Runtime Context snapshot assembled at each step carries this paragraph (appended only when the text changes, so steady turns reuse the previous one):

```
[dsh-cd] Working-directory override active for this session: /home/me/project/legacy. Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths. Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root (/home/me/project), so write them workspace-relative (a file at /home/me/project/legacy/report.md is written "legacy/report.md") or absolute — reply paths written relative to the override will not open. The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.
```

When the override directory sits outside the workspace root, the conversion example is omitted (only absolute paths can work in the reply).

## Permissions and compatibility

- **No network, no external services**: the plugin only keeps a "session → override directory" map in memory and in one state file.
- **Single file write**: `$DSH_HOME/dsh-cd/state.json` (tmp+rename atomic write, pruned after 30 days of disuse). It never writes into any session workspace.
- **Session identity unchanged**: sandbox policy root, AGENTS.md, skill discovery, MCP configuration and session storage stay anchored to the session workspace root — `cd` only affects how tool arguments resolve.
- **Host requirements**: `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-home-paths` are declared as peerDependencies in the range `^0.1.5-rc.3 || ^0.2.0-rc.1` (supplied by the host, never installed twice); Node.js >= 22.5.
- **Prompt-level, not a mechanism**: the reply-path base is decided by the DSH Web GUI (always the session workspace root); the plugin cannot rewrite model output, so it constrains the model through the injected notice above.

## Development

Link it into a profile for local debugging:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# then add "dsh-cd" to the dsh.profile.bundles array in package.json and restart dsh
```

```bash
npm install     # runs prepare → builds dist/
pnpm check      # type check
pnpm build      # build dist/
npm run e2e:cd  # GUI e2e (start an isolated instance per the dsh-e2e flow)
```

- The source is a single file: `src/index.ts`.
- Design notes and rejected alternatives live in `docs/features/260927-cd-tool/`.

## Release a new version

```bash
npm run release                                                # check + npm version patch (commit+tag) + pack to /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<version>.tgz
git push --follow-tags
```

Verify with `npm view dsh-cd version` afterwards.

## License

MIT
