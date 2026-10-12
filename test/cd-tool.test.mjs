/**
 * Behavior tests for the `cd` tool's path-base override: it re-bases relative
 * paths for one session, `-` returns to the previous directory, cd-ing back to
 * the session workspace root clears the override, and the state file survives a
 * restart. State files written by older versions, which also carried the
 * retired workspace-switch fields, must load as plain overrides.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { cdToolDefinition } from "../dist/index.js";
import { createCdState } from "../dist/state.js";

/** A tool instance plus the fake calling session it acts on. */
function harness(state, sessionId, root) {
  return { tool: cdToolDefinition(state), exec: { agent: { session: { id: sessionId, header: { cwd: root } } } } };
}

async function makeDirs(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-root-")));
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-target-")));
  const nested = await realpath(await mkdtemp(join(target, "nested-")));
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-state-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return { root, target, nested, stateDir };
}

test("cd re-bases relative paths, returns with '-', and reports the current directory", async (t) => {
  const { root, target, nested, stateDir } = await makeDirs(t);
  const state = createCdState(join(stateDir, "state.json"));
  const { tool, exec } = harness(state, "session-one", root);

  const first = await tool.execute({ path: target }, exec);
  assert.equal(first.override, true);
  assert.equal(first.cwd, target);
  assert.equal(first.previous, root);
  assert.equal(first.sessionWorkspaceRoot, root);
  assert.match(first.note, /keeps its workspace/);
  assert.equal(state.live.get("session-one").cwd, target);

  // A relative path resolves against the override, not the session workspace root.
  const relative = await tool.execute({ path: basename(nested) }, exec);
  assert.equal(relative.cwd, nested, `expected ${basename(nested)} to resolve inside ${target}`);
  assert.equal(relative.previous, target);

  const back = await tool.execute({ path: "-" }, exec);
  assert.equal(back.cwd, target);
  assert.equal(back.previous, nested);

  const query = await tool.execute({}, exec);
  assert.equal(query.cwd, target);
  assert.equal(query.override, true);
  assert.equal(query.previous, nested);
  assert.match(query.note, /resolve against/);
});

test("cd back to the session workspace root clears the override", async (t) => {
  const { root, target, stateDir } = await makeDirs(t);
  const stateFile = join(stateDir, "state.json");
  const state = createCdState(stateFile);
  const { tool, exec } = harness(state, "session-clear", root);

  await tool.execute({ path: target }, exec);
  const cleared = await tool.execute({ path: root }, exec);
  assert.equal(cleared.cwd, root);
  assert.equal(cleared.override, false);
  assert.match(cleared.note, /Override cleared/);
  assert.equal(state.live.get("session-clear"), undefined);
  assert.equal(state.persisted.get("session-clear"), undefined);

  const onDisk = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(onDisk.entries, []);

  const query = await tool.execute({}, exec);
  assert.equal(query.override, false);
  assert.match(query.note, /No override/);
});

test("cd rejects a non-directory target and a '-' without a previous directory", async (t) => {
  const { root, stateDir } = await makeDirs(t);
  const state = createCdState(join(stateDir, "state.json"));
  const { tool, exec } = harness(state, "session-errors", root);

  await assert.rejects(() => tool.execute({ path: join(root, "missing") }, exec), /does not resolve to an existing directory/);
  await assert.rejects(() => tool.execute({ path: "-" }, exec), /no previous directory/);
  await assert.rejects(() => tool.execute({ path: "" }, exec), /non-empty string/);
});

test("overrides persist across a restart, ignoring retired workspace-switch fields", async (t) => {
  const { root, target, stateDir } = await makeDirs(t);
  const stateFile = join(stateDir, "state.json");

  const first = harness(createCdState(stateFile), "session-restart", root);
  await first.tool.execute({ path: target }, first.exec);
  const written = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(written.entries.length, 1);
  assert.deepEqual(Object.keys(written.entries[0]).sort(), ["cwd", "previous", "sessionId", "updatedAt"]);

  // An older file still carries the retired real-workspace-switch fields
  // (relocate / needsConsent / relocateError): they must be dropped, not fatal.
  const historical = { ...written.entries[0], relocate: true, needsConsent: true, relocateError: "attach refused" };
  await writeFile(stateFile, `${JSON.stringify({ entries: [historical] }, null, 2)}\n`, "utf8");

  const restarted = createCdState(stateFile);
  await restarted.ready;
  const restored = restarted.persisted.get("session-restart");
  assert.equal(restored.cwd, target);
  assert.equal(restored.previous, root);
  assert.deepEqual(Object.keys(restored).sort(), ["cwd", "previous", "updatedAt"], "the retired fields are not carried over");
});
