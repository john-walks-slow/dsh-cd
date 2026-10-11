# dsh-cd

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that adds a `cd`: it can **re-base relative paths only** (the file tools and the bash default workdir follow), or **really move the session to another workspace** (sandbox root, AGENTS.md, skill discovery, session storage and sidebar grouping all follow). Users can move a session directly with the `/cd` command.

## What it is / why it exists

A dsh session's working directory (`session.header.cwd`) is frozen at creation and is part of the session's identity — it determines where the session is stored, the sandbox root, and where AGENTS.md and skills are discovered, so dsh deliberately does not allow changing it mid-session. Whenever the model needs to work outside the workspace (say, "go tidy up the logs in /tmp"), every read/write/bash call has to carry a full absolute path — long and error-prone; and when the centre of work **permanently** moves out of the workspace, AGENTS.md, skills and the sandbox boundary stay behind too, which is just wrong.

dsh-cd gives the model and the user two granularities:

| Granularity | Entry point | Effect |
|---|---|---|
| **Working base override** (light, reversible) | `cd {"path": "..."}` | Only the base that relative paths resolve against moves: the file tools and the bash default workdir follow. The session keeps its identity. |
| **Real workspace switch** (heavy, changes identity) | `cd {"path": "...", "workspace": true}` or the user's `/cd <dir>` | The session really belongs to the new directory: its storage moves, the header is rewritten, and sandbox root / AGENTS.md / skill discovery / sidebar grouping all follow. |

Under an override, tools change like this:

| Tool | Behavior change |
|---|---|
| `bash` / `pwsh` | With no `workdir`, runs in the override directory; a relative `workdir` resolves there too |
| `read` / `write` / `edit` / `read_image` | A relative `file_path` resolves there |
| `glob` / `grep` | With no `path`, searches the override directory; a relative `path` resolves there |
| `present` | A relative `files[].path` resolves there |
| Everything else | Unaffected, original semantics (absolute paths) |

**Deliberately not moved by an override**: sandbox policy root, project instructions (AGENTS.md), skill discovery, MCP configuration, session storage. `cd` back to the session workspace root clears the override. Use a real workspace switch when all of that should move too.

## Install

```bash
dsh plugin --profile web add dsh-cd
```

No configuration needed; the bundled `cordis.patch.yml` mounts the plugin automatically: the model gains a `cd` tool and the composer gains a `/cd` command.

From GitHub (source install; pnpm ≥10 requires allowing the build script):

```bash
dsh plugin --profile web add github:john-walks-slow/dsh-cd
# the first add is blocked by pnpm: put the package name pnpm prints into
# allowBuilds in ~/.dsh/profiles/web/pnpm-workspace.yaml, then run it again
```

## For the model

```
cd {"path": "/tmp/some-dir"}                      # re-base only: absolute, relative, or ~-prefixed
cd {"path": "/path/to/other-project", "workspace": true}   # relocate for real (takes effect at turn end)
cd {"path": "-"}                                  # back to the previous directory
cd {}                                             # current directory and any queued relocation
```

Details:

- The target must be an existing directory (symlinks are resolved to their real path), otherwise it errors.
- The override is **per session**: one session's `cd` does not affect others.
- `cd` back to the session workspace root clears the override.
- While an override is active, a short notice is injected into the system prompt (a cache-safe runtime-context snapshot that exists only while the override is active): **tool arguments** resolve against the override, whereas **paths in the visible reply** — markdown links, images, file mentions — still resolve against the session workspace root (write them workspace-relative or absolute, or the links will not open), plus the boundary that does not move.
- **Persistence across restarts**: the override is stored in `$DSH_HOME/dsh-cd/state.json` (atomic write, pruned after 30 days of disuse). Reopening the session after an instance restart restores it.
- **Subagent inheritance**: a delegated subagent snapshots its parent session's override directory at creation time (inherited entries are never persisted).
- **A real switch needs an idle session**: it rewrites the session log and moves it on disk, so it only runs when nothing is writing. A model call with `workspace: true` happens mid-turn, so that turn keeps working against the new base (relative paths work immediately) and the move is completed **when the turn ends**; the queued state — and any failure reason — is reported in the runtime context.

## Commands

```
/cd <directory>   # move this session's workspace there for real (the session must not be mid-turn)
/cd               # show the current directory, workspace, override state and any queued switch
```

The command runs on the host and never reaches the model, so it costs no model turn; its reply tells you whether the page needs a refresh (see below).

## What a real switch does

dsh has no API for moving a session, so dsh-cd does it itself (see `src/relocate.ts`):

1. **Disk**: move the session directory into the target workspace's `projectKey(cwd)` directory and rewrite the header `cwd` in the log's **first frame**. A dsh session log is a multi-frame Zstandard container whose first frame holds exactly the header line, so only that frame is decoded and re-encoded while every later event frame is copied **byte for byte** — re-compressing the whole log would break the reader's invariant. Earlier generations (`session.jsonl[.zstd]`) are handled too.
2. **Memory**: swap the `session.header` reference (the object itself is deep-frozen) and redirect the JSONL write handle so later appends land on the new path, then refresh the workspace registry's header index. The sandbox root and the file tools' relative-path base are read from the live header on every call, so they follow immediately.
3. **Ledger**: `detachSession` from the old workspace → reuse or create the target workspace → `attachSession` there (the registry re-reads the stored header to validate, which is why this comes after the disk rewrite).

The disk move is copy → verify → delete-old: any failure rolls back (drop the copy, restore the in-memory header, leave the old directory untouched) and reports the real reason instead of degrading.

## What the model sees

While an override is active, the Runtime Context snapshot assembled at each step carries this paragraph (appended only when the text changes, so steady turns reuse the previous one):

```
[dsh-cd] Working-directory override active for this session: /home/me/project/legacy. Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths. Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root (/home/me/project), so write them workspace-relative (a file at /home/me/project/legacy/report.md is written "legacy/report.md") or absolute — reply paths written relative to the override will not open. The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.
```

With a queued switch, the last sentence is replaced by the relocation notice (plus a failure reason when there is one):

```
… A real workspace switch to /home/me/project/legacy is queued: as soon as this turn ends the session is relocated there for good — sandbox root, project instructions (AGENTS.md), skill discovery, session storage and the sidebar workspace all follow, and this override stops being needed.
```

When the override directory sits outside the workspace root, the conversion example is omitted (only absolute paths can work in the reply).

## Permissions and compatibility

- **No network, no external services**: the plugin keeps a "session → override directory" map in memory and one state file, and calls the host's workspace registry and session persistence services.
- **File writes**: `$DSH_HOME/dsh-cd/state.json` (tmp+rename atomic write, pruned after 30 days of disuse). A real switch additionally **moves the session's own log file** (`$DSH_HOME/sessions/<projectKey>/<sessionId>/`) and updates its ownership entry in `$DSH_HOME/storages/workspace.json` — both are dsh's own data files.
- **The model can create workspaces**: to let the model move itself, a `workspace: true` call creates a workspace record when the target directory does not have one. In `workspace-write` sandbox mode that means the model can point the sandbox root at any existing directory (it can widen its own permissions); under `danger-full-access` this changes nothing. If you do not want that, do not give the model the `cd` tool or use a read-only/restricted preset.
- **Prompt-level, not a mechanism**: the reply-path base is decided by the DSH Web GUI (always the session workspace root); the plugin cannot rewrite model output, so it constrains the model through the injected notice.
- **Sidebar after a switch**: the session itself keeps working immediately (the e2e proves a continued conversation in the same page), but the sidebar grouping is built from the client's cached session list, so it usually takes a page refresh (F5) to show the session under its new workspace; the command reply reminds you.
- **Host requirements**: `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-home-paths` are declared as peerDependencies in the range `^0.1.5-rc.3 || ^0.2.0-rc.1` (supplied by the host, never installed twice); a real switch additionally needs the host's `sessionPersistence` and `workspaceRegistry` services (provided by `dsh-base`; `cd`/`/cd` report a clear error when they are missing); Node.js >= 22.5.

## Development

Link it into a profile for local debugging:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-cd@link:/path/to/dsh-cd
# then add "dsh-cd" to the dsh.profile.bundles array in package.json and restart dsh
```

```bash
npm install             # runs prepare → builds dist/
pnpm check              # type check
npm test                # build + behavior tests (frame surgery / ledger / rollback / real-log round trip)
npm run e2e:cd          # the original re-base e2e
npm run e2e:workspace   # the real workspace switch e2e
```

- Sources: `src/index.ts` (wiring), `src/relocate.ts` (the switch engine), `src/command.ts`, `src/context.ts`, `src/state.ts`.
- Design and research notes: `docs/features/260927-cd-tool/` and `docs/features/261012-workspace-switch/`.

## Release a new version

```bash
npm run release                                                # test + npm version patch (commit+tag) + pack to /tmp
node ~/.agents/skills/npm-publish/scripts/publish-webauthn.cjs /tmp/dsh-cd-<version>.tgz
git push --follow-tags
```

Verify with `npm view dsh-cd version` afterwards.

## License

MIT
