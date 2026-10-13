/**
 * The runtime-context snapshot text that announces an active working-directory
 * override — and a queued real workspace switch — to the model.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { isAbsolute, relative } from "node:path";
import type { CdState } from "./state.js";

export function sessionCwdOf(agent: Agent | undefined): string | undefined {
  return agent?.session?.header?.cwd;
}

/** The workspace-relative form of `target` when it sits inside `root` (`undefined` for the root itself or anything outside it). */
function workspaceRelative(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}

/**
 * What the model needs to know while an override is active: which base tool
 * arguments use, which base its own reply paths use, whether a real workspace
 * switch is queued, and whether the last switch attempt failed.
 */
export function contextTextFor(state: CdState, sessionId: string, agent: Agent | undefined): string {
  const entry = state.live.get(sessionId);
  if (entry === undefined) return "";
  const root = sessionCwdOf(agent);
  const insideRoot = root === undefined ? undefined : workspaceRelative(root, entry.cwd);
  const parts = [
    `[dsh-cd] Working-directory override active for this session: ${entry.cwd}.`,
    "Relative paths in read/write/edit/glob/grep/read_image/present and the bash tool's default workdir resolve against it; other tools need absolute paths.",
    "Markdown links, images, and file mentions in your visible reply use a different base: they resolve against the session workspace root" +
      (root === undefined ? "" : ` (${root})`) +
      ", so write them workspace-relative" +
      (insideRoot === undefined ? "" : ` (a file at ${entry.cwd}/report.md is written "${insideRoot}/report.md")`) +
      " or absolute — reply paths written relative to the override will not open."
  ];
  if (entry.relocate === true) {
    parts.push(
      `A real workspace switch to ${entry.cwd} is queued: as soon as this turn ends the session is relocated there for good — sandbox root, project instructions (AGENTS.md), skill discovery, session storage and the sidebar workspace all follow, and this override stops being needed.`
    );
  } else if (entry.needsConsent === true) {
    parts.push(
      `A real workspace switch to ${entry.cwd} was requested but is NOT scheduled: it changes where this session is stored and which sandbox root, project instructions and skills apply to it, so it needs the user's explicit agreement first. Ask the user, and only after they agree call cd again with workspace: true and confirmed: true.`
    );
  } else if (root !== undefined) {
    parts.push("The session workspace root still anchors sandbox policy, project instructions (AGENTS.md), skills, and session storage.");
  }
  if (entry.relocateError !== undefined) {
    parts.push(
      `The last real workspace switch failed: ${entry.relocateError} The override above is still in effect; report the problem to the user instead of retrying blindly.`
    );
  }
  return parts.join(" ");
}
