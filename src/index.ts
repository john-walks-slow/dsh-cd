/**
 * dsh-cd — session working-directory override for DeepSeek Harness.
 *
 * Registers a model-facing `cd` tool that switches this session's working
 * directory in place: afterwards every relative path in the filesystem tools
 * (read/write/edit/glob/grep/read_image/present) and the bash tool's default
 * workdir resolve against the new directory. The session's workspace root
 * (sandbox anchor, project instructions, skills, storage location) is NOT
 * moved. The override is per-session, announced through a cache-safe
 * runtime-context snapshot, and persisted across restarts keyed by session id.
 *
 * Mechanism: the harness derives per-call defaults from the frozen session
 * header (`session.header.cwd`) and the `tools/pre-execute` waterfall
 * explicitly cannot rewrite tool arguments, so dsh-cd shadows the affected
 * tools in each agent's own scope (documented registry behavior: scoped
 * registrations shadow inherited definitions) and rewrites only path-like
 * arguments.
 */
import { defineTool, type ParameterSchemaSpec, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

export const inject = ["tools", "agents"];

/** One session's override; `inherited` entries are spawn-time snapshots, never persisted. */
interface CwdEntry {
  cwd: string;
  previous?: string;
  updatedAt: number;
  inherited?: true;
}

const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const CD_PARAMETERS: ParameterSchemaSpec = {
  path: {
    type: "string",
    description:
      "Target directory: absolute, relative to the current working directory, or starting with ~. '-' switches back to the previous directory. Omit to show the current working directory. Passing the session workspace root clears the override."
  }
};

const CWD_VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    cwd: { type: "string", required: true },
    override: { type: "boolean", required: true },
    previous: { type: "string" },
    sessionWorkspaceRoot: { type: "string" },
    note: { type: "string" }
  }
} satisfies ValueSchemaSpec;

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text" as const, text: JSON.stringify(value) }] as ContentBlock[];
}

/** Rewrite one path-like argument value: relative strings resolve against `cwd`; everything else passes through. */
function rewritePath(value: unknown, cwd: string): unknown {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) ? resolvePath(cwd, value) : value;
}

type ArgsRewriter = (args: Record<string, unknown>, cwd: string) => unknown;

/** Per-tool argument rewrites. Only path-like fields change; every other argument passes through. */
const REWRITERS: Record<string, ArgsRewriter> = {
  bash: (args, cwd) => ({ ...args, workdir: args.workdir === undefined ? cwd : rewritePath(args.workdir, cwd) }),
  pwsh: (args, cwd) => ({ ...args, workdir: args.workdir === undefined ? cwd : rewritePath(args.workdir, cwd) }),
  read: (args, cwd) => ({ ...args, file_path: rewritePath(args.file_path, cwd) }),
  write: (args, cwd) => ({ ...args, file_path: rewritePath(args.file_path, cwd) }),
  edit: (args, cwd) => ({ ...args, file_path: rewritePath(args.file_path, cwd) }),
  read_image: (args, cwd) => ({ ...args, file_path: rewritePath(args.file_path, cwd) }),
  glob: (args, cwd) => ({ ...args, path: args.path === undefined ? cwd : rewritePath(args.path, cwd) }),
  grep: (args, cwd) => ({ ...args, path: args.path === undefined ? cwd : rewritePath(args.path, cwd) }),
  present: (args, cwd) =>
    Array.isArray(args.files)
      ? {
          ...args,
          files: args.files.map((file) =>
            file !== null && typeof file === "object" ? { ...file, path: rewritePath((file as Record<string, unknown>).path, cwd) } : file
          )
        }
      : args
};

interface CdState {
  /** Live overrides keyed by session id; entries created here or restored from disk. */
  readonly live: Map<string, CwdEntry>;
  /** Persisted overrides keyed by session id (inherited entries excluded). Resolves once the state file loads. */
  persisted: Map<string, CwdEntry>;
  readonly ready: Promise<void>;
  readonly stateFile: string;
}

async function loadPersisted(stateFile: string): Promise<Map<string, CwdEntry>> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = new Map<string, CwdEntry>();
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)) {
      for (const entry of (parsed as { entries: unknown[] }).entries) {
        if (entry !== null && typeof entry === "object") {
          const { sessionId, cwd } = entry as { sessionId?: unknown; cwd?: unknown };
          if (typeof sessionId === "string" && typeof cwd === "string") {
            entries.set(sessionId, entry as CwdEntry);
          }
        }
      }
    }
    return entries;
  } catch (error) {
    console.warn(`dsh-cd: ignoring malformed state file ${stateFile}: ${String(error)}`);
    return new Map();
  }
}

async function savePersisted(state: CdState): Promise<void> {
  await state.ready;
  const now = Date.now();
  const entries: object[] = [];
  for (const [sessionId, entry] of state.persisted) {
    if (now - entry.updatedAt > PERSIST_MAX_AGE_MS) continue;
    entries.push({
      sessionId,
      ...(entry.previous === undefined ? {} : { previous: entry.previous }),
      cwd: entry.cwd,
      updatedAt: entry.updatedAt
    });
  }
  await mkdir(dirname(state.stateFile), { recursive: true });
  const tempFile = `${state.stateFile}.tmp`;
  await writeFile(tempFile, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await rename(tempFile, state.stateFile);
}

/** Resolve one candidate directory to its real path, or undefined when it is not a directory. */
async function resolveDirectory(target: string): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return undefined;
  }
  try {
    if (!(await stat(real)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return real;
}

function sessionCwdOf(agent: Agent | undefined): string | undefined {
  return agent?.session?.header?.cwd;
}

/** The workspace-relative form of `target` when it sits inside `root` (`undefined` for the root itself or anything outside it). */
function workspaceRelative(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}

function contextTextFor(state: CdState, sessionId: string, agent: Agent | undefined): string {
  const entry = state.live.get(sessionId);
  if (entry === undefined) return "";
  const root = sessionCwdOf(agent);
  const insideRoot = root === undefined ? undefined : workspaceRelative(root, entry.cwd);
  return (
    `[dsh-cd] Working-directory override active for this session: ${entry.cwd}. ` +
    "Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths. " +
    "Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root" +
    (root === undefined ? "" : ` (${root})`) +
    ", so write them workspace-relative" +
    (insideRoot === undefined ? "" : ` (a file at ${entry.cwd}/report.md is written "${insideRoot}/report.md")`) +
    " or absolute — reply paths written relative to the override will not open. " +
    (root === undefined ? "" : `The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.`)
  );
}

/** The `cd` tool, bound to one state store. */
function cdToolDefinition(state: CdState): ToolDefinition {
  return defineTool({
    name: "cd",
    description:
      "Change this session's working directory in place. After a successful cd, relative paths passed to the file tools (read, write, edit, glob, grep, read_image, present) and the bash tool's default workdir resolve against the new directory instead of the session workspace root. Paths you write in your visible reply (markdown links/images, file mentions) still resolve against the session workspace root, so keep those workspace-relative or absolute. Does NOT move the session or change its workspace root: sandbox policy, project instructions (AGENTS.md), and skills stay anchored to the session workspace. path may be absolute, relative to the current working directory, or start with ~; '-' switches back to the previous directory; omit it to show the current working directory.",
    parameters: CD_PARAMETERS,
    output: { schema: CWD_VIEW_SCHEMA, render: renderValue },
    presentCall(args: unknown): ToolCallView | undefined {
      const path = (args as { path?: unknown } | null | undefined)?.path;
      return {
        card: "generic" as const,
        title: `cd ${typeof path === "string" ? path : ""}`.trim(),
        kind: "other" as const,
        rawInput: JSON.stringify(args) ?? ""
      };
    },
    async execute(args, exec) {
      await state.ready;
      const agent = exec.agent;
      if (agent === undefined) throw new Error("cd: no calling session");
      const sessionId = agent.session.id;
      const entry = state.live.get(sessionId);
      const root = sessionCwdOf(agent);
      const requested = (args as { path?: unknown }).path;

      if (requested === undefined) {
        return {
          cwd: entry?.cwd ?? root ?? process.cwd(),
          override: entry !== undefined,
          ...(entry?.previous === undefined ? {} : { previous: entry.previous }),
          ...(root === undefined ? {} : { sessionWorkspaceRoot: root }),
          ...(entry === undefined ? {} : { note: "Relative paths in file tools and the bash default workdir resolve against the override cwd." })
        };
      }
      if (typeof requested !== "string" || requested.length === 0) throw new Error("cd: path must be a non-empty string");

      let target: string;
      if (requested === "-") {
        if (entry?.previous === undefined) throw new Error("cd: no previous directory to return to");
        target = entry.previous;
      } else {
        target = expandHomePath(requested);
      }
      const base = entry?.cwd ?? root ?? process.cwd();
      const candidate = isAbsolute(target) ? target : resolvePath(base, target);
      const resolved = await resolveDirectory(candidate);
      if (resolved === undefined) throw new Error(`cd: "${requested}" does not resolve to an existing directory (tried ${candidate})`);

      if (root !== undefined && resolved === root) {
        state.live.delete(sessionId);
        state.persisted.delete(sessionId);
        await savePersisted(state);
        return {
          cwd: resolved,
          override: false,
          sessionWorkspaceRoot: root,
          note: "Override cleared: back to the session workspace root."
        };
      }

      const previous = entry?.cwd ?? root;
      const next: CwdEntry = { cwd: resolved, ...(previous === undefined ? {} : { previous }), updatedAt: Date.now() };
      state.live.set(sessionId, next);
      state.persisted.set(sessionId, next);
      await savePersisted(state);
      return {
        cwd: resolved,
        override: true,
        ...(next.previous === undefined ? {} : { previous: next.previous }),
        ...(root === undefined ? {} : { sessionWorkspaceRoot: root }),
        note:
          "Relative paths in file tools and the bash default workdir now resolve here. " +
          "Sandbox policy, project instructions, and skills remain anchored to the session workspace root."
      };
    }
  });
}

/**
 * Register the path-rewriting shadows on one agent's own scope. Each original
 * is resolved from the agent's full view BEFORE its shadow is registered, so
 * the shadow wraps exactly what that agent would otherwise execute. Returns
 * the registration disposers.
 */
function shadowToolsOn(agent: Agent, state: CdState): (() => void)[] {
  const disposers: (() => void)[] = [];
  for (const [name, rewriter] of Object.entries(REWRITERS)) {
    const original = agent.ctx.tools.get(name, agent);
    if (original === undefined) continue;
    const boundSessionId = agent.session.id;
    disposers.push(
      agent.ctx.tools.register({
        ...original,
        async execute(args, exec) {
          const sessionId = exec.agent?.session?.id ?? boundSessionId;
          const entry = state.live.get(sessionId);
          if (entry === undefined || args === null || typeof args !== "object") return original.execute(args, exec);
          return original.execute(rewriter(args as Record<string, unknown>, entry.cwd), exec);
        }
      })
    );
  }
  return disposers;
}

/**
 * Register the runtime-context snapshot that announces an active override to
 * the model. Contributes nothing until the session actually cds somewhere.
 */
function registerContextOn(agent: Agent, state: CdState): (() => void) | undefined {
  const systemPrompt = agent.ctx.get("systemPrompt", false) as
    | { context: (context: { name: string; order: number; text: () => string }) => () => void }
    | undefined;
  if (systemPrompt === undefined) return undefined;
  const sessionId = agent.session.id;
  return systemPrompt.context({
    name: "cd-working-directory",
    order: 112,
    text: () => contextTextFor(state, sessionId, agent)
  });
}

/** Restore this session's persisted override (if any) and inherit from a spawning parent. */
async function restoreEntryFor(agent: Agent, state: CdState): Promise<void> {
  await state.ready;
  const sessionId = agent.session.id;
  if (state.live.has(sessionId)) return;
  const parentSessionId = agent.session.header?.parentSession;
  if (parentSessionId !== undefined) {
    const parentEntry = state.live.get(parentSessionId);
    if (parentEntry !== undefined) {
      const resolved = await resolveDirectory(parentEntry.cwd);
      if (resolved !== undefined) state.live.set(sessionId, { cwd: resolved, updatedAt: Date.now(), inherited: true });
      return;
    }
  }
  const persisted = state.persisted.get(sessionId);
  if (persisted === undefined) return;
  const resolved = await resolveDirectory(persisted.cwd);
  if (resolved === undefined) {
    state.persisted.delete(sessionId);
    await savePersisted(state);
    return;
  }
  state.live.set(sessionId, { ...persisted, cwd: resolved });
}

export function apply(ctx: Context): () => void {
  const stateFile = join(resolveDshHome(undefined, process.env), "dsh-cd", "state.json");
  const persistedLoad = loadPersisted(stateFile);
  const state: CdState = {
    live: new Map(),
    persisted: new Map(),
    ready: persistedLoad.then(() => undefined),
    stateFile
  };
  void persistedLoad.then((persisted) => {
    state.persisted = persisted;
  });

  const disposers: (() => void)[] = [ctx.tools.register(cdToolDefinition(state))];

  // Cover every agent (roots and delegated children), once each: the
  // listener handles agents created after plugin load, the initial scan
  // handles agents that already exist when this plugin applies. Failures
  // are contained — an agent/created listener throw would veto publication.
  const registered = new WeakSet<Agent>();
  const registerOne = (agent: Agent) => {
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      const scopedDisposers = agent.ctx.effect(() => {
        const combined = shadowToolsOn(agent, state);
        const contextDisposer = registerContextOn(agent, state);
        if (contextDisposer !== undefined) combined.push(contextDisposer);
        return () => {
          for (const disposer of combined) disposer();
        };
      }, "dsh-cd:agent-scope");
      disposers.push(scopedDisposers);
    } catch (error) {
      ctx.logger.warn(`dsh-cd: scoped registration failed for agent ${agent.session.id}: ${String(error)}`);
      return;
    }
    void restoreEntryFor(agent, state).catch((error: unknown) => {
      ctx.logger.warn(`dsh-cd: state restore failed for agent ${agent.session.id}: ${String(error)}`);
    });
  };
  disposers.push(
    ctx.on("agent/created", ({ agent }: { agent: Agent }) => {
      registerOne(agent);
      return undefined;
    })
  );
  for (const existing of ctx.agents.roots()) {
    registerOne(existing);
  }

  return () => {
    for (const disposer of disposers) disposer();
  };
}
