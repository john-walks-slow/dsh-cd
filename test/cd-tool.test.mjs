/**
 * Behavior tests for the `cd` tool's consent gate: a real workspace switch
 * changes the session's identity, so it is only queued when the same call
 * carries `confirmed: true`; without it the call re-bases paths and tells the
 * model to ask the user first.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cdToolDefinition } from "../dist/index.js";
import { createCdState } from "../dist/state.js";

const SERVICES = () => ({ persistence: { config: { root: "/tmp" } }, registry: {} });

/** A tool instance plus the fake calling session it acts on. */
function harness(state, sessionId, root, services = SERVICES) {
  return { tool: cdToolDefinition(state, services), exec: { agent: { session: { id: sessionId, header: { cwd: root } } } } };
}

test("cd refuses a real workspace switch until the call carries confirmed", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-root-")));
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-target-")));
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const state = createCdState(join(stateDir, "state.json"));
  const { tool, exec } = harness(state, "session-consent", root);

  const refused = await tool.execute({ path: target, workspace: true }, exec);
  assert.equal(refused.workspaceSwitchNeedsConsent, true);
  assert.equal(refused.workspaceSwitchQueued, undefined, "nothing is queued without the user's agreement");
  assert.equal(refused.override, true, "the path re-base still applies");
  assert.match(refused.note, /needs the user's explicit agreement/);
  assert.match(refused.note, /confirmed: true/);
  assert.equal(state.live.get("session-consent").relocate, undefined);
  assert.equal(state.live.get("session-consent").needsConsent, true);

  const queried = await tool.execute({}, exec);
  assert.equal(queried.workspaceSwitchNeedsConsent, true, "a later query repeats that the switch is waiting");
  assert.match(queried.note, /waiting for the user's agreement/);

  const agreed = await tool.execute({ path: target, workspace: true, confirmed: true }, exec);
  assert.equal(agreed.workspaceSwitchQueued, true);
  assert.equal(agreed.workspaceSwitchNeedsConsent, undefined);
  assert.equal(state.live.get("session-consent").relocate, true);
  assert.equal(state.live.get("session-consent").needsConsent, undefined, "the agreement supersedes the pending request");
});

test("a plain cd never mentions consent or relocation", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-root-")));
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-target-")));
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const state = createCdState(join(stateDir, "state.json"));
  const { tool, exec } = harness(state, "session-plain", root, () => undefined);

  const result = await tool.execute({ path: target }, exec);
  assert.equal(result.override, true);
  assert.equal(result.workspaceSwitchQueued, undefined);
  assert.equal(result.workspaceSwitchNeedsConsent, undefined);
  assert.match(result.note, /keeps its workspace/);
  assert.equal(state.live.get("session-plain").relocate, undefined);
});

test("a git worktree target is not treated specially", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-root-")));
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-worktree-")));
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const state = createCdState(join(stateDir, "state.json"));
  const { tool, exec } = harness(state, "session-worktree", root);

  // A worktree is where a plain path switch is normally wanted, so it gets the same gate: no exemption.
  const result = await tool.execute({ path: target, workspace: true }, exec);
  assert.equal(result.workspaceSwitchNeedsConsent, true);
  assert.equal(result.workspaceSwitchQueued, undefined);
});
