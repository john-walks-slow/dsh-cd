/**
 * dsh-cd — session working-directory control for DeepSeek Harness.
 *
 * One capability: a model-facing `cd` tool switches the base that relative
 * paths resolve against — the file tools
 * (read/write/edit/glob/grep/read_image/present) and the bash tool's default
 * workdir — without moving the session. Per-session, announced through a
 * cache-safe runtime-context snapshot, persisted across restarts.
 *
 * Moving the session itself (its identity, storage path, sandbox root and
 * workspace membership) is not this plugin's job: dsh-manage-session provides
 * that as `session_move`, `/move` and `/cd`.
 *
 * Mechanism: the harness derives per-call defaults from the frozen session header
 * (`session.header.cwd`) and the `tools/pre-execute` waterfall explicitly cannot
 * rewrite tool arguments, so dsh-cd shadows the affected tools in each agent's own
 * scope (documented registry behavior: scoped registrations shadow inherited
 * definitions) and rewrites only path-like arguments.
 */
import { defineTool, type ParameterSchemaSpec, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { contextTextFor, sessionCwdOf } from "./context.js";
import { createCdState, savePersisted, type CdState, type CwdEntry } from "./state.js";

export const inject = ["tools", "agents"];

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

/** The `cd` tool, bound to one state store. Exported so the override behavior can be tested without a host. */
export function cdToolDefinition(state: CdState): ToolDefinition {
  return defineTool({
    name: "cd",
    description:
      "Change this session's working directory. This only re-bases relative paths: the file tools (read, write, edit, glob, grep, read_image, present) and the bash tool's default workdir resolve against `path`, while the session keeps its workspace — sandbox policy, project instructions (AGENTS.md), skills and session storage stay where they were. `path` may be absolute, relative to the current working directory, or start with ~; '-' switches back to the previous directory; omit it to show the current working directory.",
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
          note:
            entry === undefined
              ? "No override: relative paths resolve against the session workspace root."
              : `Relative paths in the file tools and the bash default workdir resolve against ${entry.cwd}.`
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
          note: "Override cleared: relative paths resolve against the session workspace root again, which is also this session's workspace."
        };
      }

      const previous = entry?.cwd ?? root;
      const next: CwdEntry = {
        cwd: resolved,
        ...(previous === undefined ? {} : { previous }),
        updatedAt: Date.now()
      };
      state.live.set(sessionId, next);
      state.persisted.set(sessionId, next);
      await savePersisted(state);

      return {
        cwd: resolved,
        override: true,
        ...(next.previous === undefined ? {} : { previous: next.previous }),
        ...(root === undefined ? {} : { sessionWorkspaceRoot: root }),
        note: `Relative paths in the file tools and the bash default workdir now resolve against ${resolved}. This session keeps its workspace: sandbox policy, project instructions (AGENTS.md), skills and session storage stay${root === undefined ? "" : ` at ${root}`}, so keep writing reply paths workspace-relative or absolute.`
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
  const state = createCdState(stateFile);

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
