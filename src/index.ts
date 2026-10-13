/**
 * dsh-cd — session working-directory control for DeepSeek Harness.
 *
 * Two capabilities, one engine:
 *
 * - **Path-base override** (default): a model-facing `cd` tool switches the base
 *   that relative paths resolve against — the file tools
 *   (read/write/edit/glob/grep/read_image/present) and the bash tool's default
 *   workdir — without moving the session. Per-session, announced through a
 *   cache-safe runtime-context snapshot, persisted across restarts.
 * - **Real workspace switch** (`cd {"workspace": true}`, or the user-facing `/cd`
 *   command): the session is relocated for good, so its sandbox root, project
 *   instructions, skill discovery, storage path and sidebar workspace all follow.
 *
 * Mechanism: the harness derives per-call defaults from the frozen session header
 * (`session.header.cwd`) and the `tools/pre-execute` waterfall explicitly cannot
 * rewrite tool arguments, so dsh-cd shadows the affected tools in each agent's own
 * scope (documented registry behavior: scoped registrations shadow inherited
 * definitions) and rewrites only path-like arguments. A real switch additionally
 * re-pins that identity, which the host offers no API for — see `relocate.ts`.
 */
import { defineTool, type ParameterSchemaSpec, type ToolCallView, type ToolDefinition, type ValueSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { registerCdCommand } from "./command.js";
import { contextTextFor, sessionCwdOf } from "./context.js";
import { relocateSession, type LiveSession, type RelocateServices } from "./relocate.js";
import { createCdState, savePersisted, type CdState, type CwdEntry } from "./state.js";

export const inject = ["tools", "agents"];

const CD_PARAMETERS: ParameterSchemaSpec = {
  path: {
    type: "string",
    description:
      "Target directory: absolute, relative to the current working directory, or starting with ~. '-' switches back to the previous directory. Omit to show the current working directory. Passing the session workspace root clears the override."
  },
  workspace: {
    type: "boolean",
    description:
      "Relocate the session to `path` for good instead of only re-basing relative paths: as soon as this turn ends the session belongs to that directory — its sandbox root, project instructions (AGENTS.md), skill discovery, session storage and the sidebar workspace all follow, and a workspace record is created if the directory has none. This is a permanent change of the session's identity, so it only takes effect after the user has explicitly agreed: ask them first, then repeat the call with `confirmed: true`. A call without that agreement still re-bases relative paths for now, and reports that the switch is waiting. Omit it for a temporary detour, and also for work inside a git worktree, where a plain path switch is normally what you want."
  },
  confirmed: {
    type: "boolean",
    description:
      "Only pass true once the user has explicitly agreed, in this conversation, to moving this session's working directory to `path` for good. It is the record of their agreement, so never set it on your own initiative: the switch is what decides where the session is stored and which sandbox root, project instructions and skills apply to it."
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
    workspaceSwitchQueued: { type: "boolean" },
    workspaceSwitchNeedsConsent: { type: "boolean" },
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

/** The `cd` tool, bound to one state store. Exported so the consent gate can be tested without a host. */
export function cdToolDefinition(state: CdState, services: () => RelocateServices | undefined): ToolDefinition {
  return defineTool({
    name: "cd",
    description:
      "Change this session's working directory. By default this only re-bases relative paths: the file tools (read, write, edit, glob, grep, read_image, present) and the bash tool's default workdir resolve against `path`, while the session keeps its workspace — sandbox policy, project instructions (AGENTS.md), skills and session storage stay where they were. Pass `workspace: true` when the work is moving there for good: this turn still uses the new directory, and the session is relocated for real as soon as the turn ends, so its sandbox root, project instructions, skills, session storage and sidebar workspace all follow. A real switch changes the session's identity and therefore needs the user's explicit agreement: ask them, and only then repeat the call with `confirmed: true` — without it the call just re-bases paths and reports that the switch is waiting. `path` may be absolute, relative to the current working directory, or start with ~; '-' switches back to the previous directory; omit it to show the current working directory.",
    parameters: CD_PARAMETERS,
    output: { schema: CWD_VIEW_SCHEMA, render: renderValue },
    presentCall(args: unknown): ToolCallView | undefined {
      const path = (args as { path?: unknown } | null | undefined)?.path;
      const wants = (args as { workspace?: unknown } | null | undefined)?.workspace === true;
      const confirmed = (args as { confirmed?: unknown } | null | undefined)?.confirmed === true;
      const suffix = wants ? (confirmed ? "  (real workspace switch)" : "  (workspace switch awaiting the user's agreement)") : "";
      return {
        card: "generic" as const,
        title: `cd ${typeof path === "string" ? path : ""}${suffix}`.trim(),
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
      const wantsWorkspace = (args as { workspace?: unknown }).workspace === true;
      const confirmed = (args as { confirmed?: unknown }).confirmed === true;
      // A real switch changes the session's identity, so it only runs once the user's agreement is on record.
      const relocating = wantsWorkspace && confirmed;

      if (requested === undefined) {
        const queued = entry?.relocate === true;
        return {
          cwd: entry?.cwd ?? root ?? process.cwd(),
          override: entry !== undefined,
          ...(entry?.previous === undefined ? {} : { previous: entry.previous }),
          ...(root === undefined ? {} : { sessionWorkspaceRoot: root }),
          ...(queued ? { workspaceSwitchQueued: true } : {}),
          ...(entry?.needsConsent === true ? { workspaceSwitchNeedsConsent: true } : {}),
          note:
            entry === undefined
              ? "No override: relative paths resolve against the session workspace root."
              : `Relative paths in the file tools and the bash default workdir resolve against ${entry.cwd}.` +
                (queued ? ` A real workspace switch to ${entry.cwd} is queued and runs as soon as this turn ends.` : "") +
                (entry.needsConsent === true
                  ? ` A real workspace switch to ${entry.cwd} is waiting for the user's agreement: ask them, and only after they agree call cd again with workspace: true and confirmed: true.`
                  : "") +
                (entry.relocateError === undefined ? "" : ` The last real workspace switch failed: ${entry.relocateError}`)
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

      if (relocating && services() === undefined) {
        throw new Error(
          "cd: a real workspace switch needs the session persistence and workspace registry services, which this dsh build does not expose; use a plain cd or the /cd command."
        );
      }

      const previous = entry?.cwd ?? root;
      const next: CwdEntry = {
        cwd: resolved,
        ...(previous === undefined ? {} : { previous }),
        updatedAt: Date.now(),
        ...(relocating ? { relocate: true as const } : {}),
        ...(wantsWorkspace && !confirmed ? { needsConsent: true as const } : {})
      };
      state.live.set(sessionId, next);
      state.persisted.set(sessionId, next);
      await savePersisted(state);

      return {
        cwd: resolved,
        override: true,
        ...(next.previous === undefined ? {} : { previous: next.previous }),
        ...(root === undefined ? {} : { sessionWorkspaceRoot: root }),
        ...(relocating ? { workspaceSwitchQueued: true } : {}),
        ...(next.needsConsent === true ? { workspaceSwitchNeedsConsent: true } : {}),
        note: relocating
          ? `Relative paths in the file tools and the bash default workdir now resolve against ${resolved}, and a real workspace switch to it is queued: as soon as this turn ends the session is relocated there for good — its sandbox root, project instructions (AGENTS.md), skill discovery, session storage and sidebar workspace all move with it, and a workspace record is created if that directory has none. Finish anything that depends on the old workspace in this turn; afterwards the override is gone because relative paths and reply paths finally share one base.`
          : wantsWorkspace
            ? `Relative paths in the file tools and the bash default workdir now resolve against ${resolved}, but the session was NOT relocated: a real workspace switch needs the user's explicit agreement first. Ask the user whether this session should move its workspace to ${resolved} for good, and only after they agree call cd again with workspace: true and confirmed: true. Reply paths keep resolving against the session workspace root until then.`
            : `Relative paths in the file tools and the bash default workdir now resolve against ${resolved}. This session keeps its workspace: sandbox policy, project instructions (AGENTS.md), skills and session storage stay${root === undefined ? "" : ` at ${root}`}, so keep writing reply paths workspace-relative or absolute.`
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
  /** Session ids inside a turn: a real switch rewrites the stored log, so it must never run while one is writing. */
  const busy = new Set<string>();

  const services = (): RelocateServices | undefined => {
    const persistence = ctx.get("sessionPersistence", false) as RelocateServices["persistence"] | undefined;
    const registry = ctx.get("workspaceRegistry", false) as RelocateServices["registry"] | undefined;
    return persistence === undefined || registry === undefined ? undefined : { persistence, registry };
  };

  const hasLiveChildren = (sessionId: string): boolean => {
    for (const agent of ctx.agents.list()) {
      if (agent.session?.header?.parentSession === sessionId) return true;
    }
    return false;
  };

  /**
   * Apply a queued real workspace switch, if the session is idle. Failures keep
   * the override (the session still works) and are announced to the model on its
   * next turn; a busy session or a running subagent simply defers to the next
   * turn end.
   */
  const settleRelocation = async (session: LiveSession): Promise<void> => {
    const entry = state.live.get(session.id);
    if (entry?.relocate !== true || busy.has(session.id) || hasLiveChildren(session.id)) return;
    const host = services();
    if (host === undefined) {
      state.live.set(session.id, { ...entry, relocateError: "this dsh build exposes neither the session persistence nor the workspace registry service" });
      return;
    }
    try {
      const result = await relocateSession(host, session, entry.cwd);
      state.live.delete(session.id);
      state.persisted.delete(session.id);
      await savePersisted(state);
      ctx.logger.info(`dsh-cd: session ${session.id} relocated to ${result.cwd}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`dsh-cd: workspace switch failed for session ${session.id}: ${message}`);
      state.live.set(session.id, { ...entry, relocateError: message });
      await savePersisted(state).catch(() => undefined);
    }
  };

  const disposers: (() => void)[] = [ctx.tools.register(cdToolDefinition(state, services))];

  disposers.push(
    ctx.on("session/event", (session: LiveSession, event: { type: string }) => {
      if (event.type === "turn/start") busy.add(session.id);
      else if (event.type === "turn/end") {
        busy.delete(session.id);
        void settleRelocation(session);
      }
    })
  );

  const disposeCommand = registerCdCommand(ctx, { state, busy, services, logger: ctx.logger });
  if (disposeCommand === undefined) ctx.logger.warn("dsh-cd: no command service available; /cd is not registered");
  else disposers.push(disposeCommand);

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
