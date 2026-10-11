/**
 * The user-facing `/cd` command: relocate this session's workspace for real, or
 * report where the session currently works. The command runs on the host and
 * never reaches the model, so a switch the user asks for is not narrated by the
 * agent.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { Context } from "@deepseek-ai/cordis";
import { expandHomePath } from "@deepseek-ai/dsh-home-paths";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { relocateSession, type LiveSession, type RelocateResult, type RelocateServices } from "./relocate.js";
import { savePersisted, type CdState } from "./state.js";

/** The slice of the host's command service this plugin registers into. */
interface CommandsLike {
  register(definition: {
    name: string;
    description: string;
    input?: { hint?: string; attachments?: boolean };
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): () => void;
}

export interface CdCommandDeps {
  state: CdState;
  /** Session ids currently inside a turn; a move may not run while a log is being appended to. */
  busy: ReadonlySet<string>;
  services(): RelocateServices | undefined;
  logger: { warn(message: string): void };
}

/** Register `/cd`, or return undefined when this deployment has no command service. */
export function registerCdCommand(ctx: Context, deps: CdCommandDeps): (() => void) | undefined {
  const commands = ctx.get("commands", false) as CommandsLike | undefined;
  if (commands === undefined) return undefined;
  return commands.register({
    name: "cd",
    description:
      "Switch this session's workspace. With a directory, the session is relocated there for real — sandbox root, project instructions, skills, session storage and the sidebar workspace follow. Without an argument, reports the current directory and workspace.",
    input: { hint: "[<directory>]" },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const request = invocation.rawInput.trim();
      const agent: Agent | undefined = invocation.agent;
      if (agent === undefined) return { kind: "error", text: "cd: this command needs a live session." };
      const session = agent.session;
      if (request.length === 0) return { kind: "success", text: await describeSession(deps, session) };

      if (deps.busy.has(session.id)) {
        return {
          kind: "error",
          text: "cd: this session is in the middle of a turn. A real workspace switch rewrites the session's stored log while nothing is writing to it, so wait for the reply to finish and run /cd again."
        };
      }
      const services = deps.services();
      if (services === undefined) {
        return { kind: "error", text: "cd: this dsh build exposes neither the session persistence nor the workspace registry service, so a real workspace switch is unavailable." };
      }
      const expanded = expandHomePath(request);
      const target = isAbsolute(expanded) ? expanded : resolvePath(session.header.cwd ?? process.cwd(), expanded);
      try {
        const result = await relocateSession(services, session, target);
        if (result.changed) {
          deps.state.live.delete(session.id);
          deps.state.persisted.delete(session.id);
          await savePersisted(deps.state);
        }
        return { kind: "success", text: successText(result) };
      } catch (error) {
        return { kind: "error", text: `cd: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  });
}

/** What the session currently works in, plus any override or queued switch. */
async function describeSession(deps: CdCommandDeps, session: LiveSession): Promise<string> {
  const cwd = session.header.cwd ?? "(no stored cwd)";
  const services = deps.services();
  const workspace = services === undefined ? undefined : await services.registry.resolveByPath(cwd).catch(() => undefined);
  const parts = [`This session works in ${cwd}${workspace === undefined ? "" : ` (workspace "${workspace.title}")`}.`];
  const entry = deps.state.live.get(session.id);
  if (entry !== undefined) {
    parts.push(`A path-base override is active: relative tool paths and the bash default workdir resolve against ${entry.cwd}.`);
    if (entry.relocate === true) parts.push(`A real workspace switch to ${entry.cwd} is queued and runs as soon as this turn ends.`);
    if (entry.relocateError !== undefined) parts.push(`The last real workspace switch failed: ${entry.relocateError}`);
  }
  parts.push("Run /cd <directory> to move this session's workspace there for real.");
  return parts.join(" ");
}

function successText(result: RelocateResult): string {
  if (!result.changed) return `This session already works in ${result.cwd} (workspace "${result.workspace.title}").`;
  const workspace = result.workspace.created
    ? `a new workspace "${result.workspace.title}" was created for it`
    : `it is now in the workspace "${result.workspace.title}"`;
  return (
    `Moved this session to ${result.cwd} — ${workspace}. ` +
    "The sandbox root, project instructions (AGENTS.md), skill discovery and session storage follow the session from the next call on. " +
    "Refresh the browser page (F5) if the sidebar still lists it under the old workspace."
  );
}
