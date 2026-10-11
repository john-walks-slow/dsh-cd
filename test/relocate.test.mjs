/**
 * Behavior tests for the workspace-switch engine (`src/relocate.ts`).
 *
 * The engine rewrites stored session logs in place, so every assertion here is
 * about invariants dsh relies on: frame one holds exactly the header line, later
 * frames survive byte for byte, the log lands in the target project directory,
 * and a failure leaves the session exactly where it was.
 *
 * Node's own Zstandard decoder stops after the first frame (`zstdDecompressSync`
 * and even the stream), which is why dsh scans frames by hand. The whole-log
 * checks therefore shell out to the `zstd` CLI, the reference decoder, and skip
 * when it is not installed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { encodeSegment, projectKey, relocateSession } from "../dist/relocate.js";

const execFileP = promisify(execFile);
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zstdCompressSync(Buffer.from(text, "utf8"), CHECKSUM);
const headerLine = (id, cwd) => JSON.stringify({ type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd });

/** Decode every concatenated frame through the `zstd` CLI, or undefined when it is not installed. */
async function decodeLog(path) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** A persistence + workspace-registry pair with just enough behavior to observe the engine. */
function harness({ root, session, previousPath, failAttach = false }) {
  const calls = [];
  const handle = { header: { ...session.header } };
  const writers = new Map([[session.id, handle]]);
  const workspaces = new Map();
  const entity = (path) => ({
    path,
    title: path.split("/").pop() || path,
    attachSession: async (id) => {
      if (failAttach) throw new Error("attach refused");
      calls.push(`attach:${path}:${id}`);
    },
    detachSession: async (id) => calls.push(`detach:${path}:${id}`)
  });
  if (previousPath !== undefined) workspaces.set(previousPath, entity(previousPath));
  return {
    calls,
    handle,
    writers,
    services: {
      persistence: {
        config: { root },
        flush: async () => calls.push("flush"),
        tracker: { writers }
      },
      registry: {
        resolveByPath: async (path) => workspaces.get(path),
        create: async (path) => {
          calls.push(`create:${path}`);
          const created = entity(path);
          workspaces.set(path, created);
          return created;
        },
        indexHeader: async (header) => calls.push(`index:${header.cwd}`)
      }
    }
  };
}

/** Build a temp session root with one stored log for `session`. */
async function fixture({ id, cwd, events, compressed = true, names = ["session.v4.jsonl.zstd"] }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-")));
  await mkdir(cwd, { recursive: true });
  const dir = join(root, "sessions", projectKey(cwd), encodeSegment(id));
  await mkdir(dir, { recursive: true });
  const header = Buffer.from(`${headerLine(id, cwd)}\n`, "utf8");
  const body = Buffer.from(events.join(""), "utf8");
  const contents = compressed ? Buffer.concat([frame(header.toString("utf8")), ...events.map((event) => frame(event))]) : Buffer.concat([header, body]);
  for (const name of names) await writeFile(join(dir, name), contents);
  return { root, dir, contents, sessionsRoot: join(root, "sessions") };
}

test("project directory keys match dsh's on-disk encoding", () => {
  assert.equal(projectKey("/root"), "--root--");
  assert.equal(projectKey("/root/projects/dsh-cd"), "--root-projects-dsh-cd--");
  assert.equal(
    projectKey("/root/.local/share/codeg/chat-sessions/2026-08-27/10f7e2d17f65415b98282dc32d07bd24"),
    "--root-.local-share-codeg-chat-sessions-2026-08-27-10f7e2d17f65415b98282dc32d07bd24--"
  );
  assert.equal(encodeSegment("session-a9b1e6d9-0b86-4e78-976f-0da1b11819b7"), "session-a9b1e6d9-0b86-4e78-976f-0da1b11819b7");
  assert.equal(encodeSegment("a/b"), "a~002Fb");
  assert.equal(encodeSegment(".."), "~002E~002E");
});

test("relocateSession rewrites frame one and keeps every later frame byte for byte", async (t) => {
  const id = "session-1111-2222";
  const events = ['{"seq":1,"type":"turn/start"}\n', '{"seq":2,"type":"turn/end"}\n'];
  const oldCwd = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-old-")));
  const { root, dir, sessionsRoot } = await fixture({ id, cwd: oldCwd, events });
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-new-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(oldCwd, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const originalHeader = { type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd };
  const session = { id, header: { ...originalHeader } };
  const { services, calls, handle } = harness({ root: sessionsRoot, session, previousPath: oldCwd });

  const result = await relocateSession(services, session, target);

  assert.equal(result.changed, true);
  assert.equal(result.cwd, target);
  assert.equal(result.workspace.created, true);
  assert.equal(existsSync(dir), false, "the old session directory is gone");
  const moved = join(sessionsRoot, projectKey(target), encodeSegment(id), "session.v4.jsonl.zstd");
  assert.equal(existsSync(moved), true, "the log moved into the target project directory");

  const rewritten = await readFile(moved);
  const expected = Buffer.concat([frame(`${headerLine(id, target)}\n`), ...events.map((event) => frame(event))]);
  assert.deepEqual(rewritten, expected, "only the header frame changed; event frames are identical");
  assert.equal(zstdDecompressSync(rewritten).toString("utf8"), `${headerLine(id, target)}\n`, "frame one is exactly the header line");
  const decoded = await decodeLog(moved);
  if (decoded !== undefined) assert.equal(decoded, `${headerLine(id, target)}\n${events.join("")}`, "the reference decoder reads the whole log back");

  assert.equal(handle.header.cwd, target, "the write handle follows the session");
  assert.equal(session.header.cwd, target, "the live session follows");
  assert.equal(originalHeader.cwd, oldCwd, "the previous header object is left untouched");
  assert.deepEqual(calls, ["flush", `index:${target}`, `create:${target}`, `attach:${target}:${id}`, `detach:${oldCwd}:${id}`]);
});

test("relocateSession handles an uncompressed log", async (t) => {
  const id = "session-3333-4444";
  const events = ['{"seq":1,"type":"turn/start"}\n'];
  const oldCwd = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-old-")));
  const { root, sessionsRoot } = await fixture({ id, cwd: oldCwd, events, compressed: false, names: ["session.jsonl"] });
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-new-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(oldCwd, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const session = { id, header: { type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd } };
  const { services } = harness({ root: sessionsRoot, session, previousPath: oldCwd });
  await relocateSession(services, session, target);

  const moved = join(sessionsRoot, projectKey(target), encodeSegment(id), "session.jsonl");
  assert.equal(await readFile(moved, "utf8"), `${headerLine(id, target)}\n${events.join("")}`);
});

test("relocateSession rewrites every stored generation", async (t) => {
  const id = "session-5555-6666";
  const events = ['{"seq":1,"type":"turn/end"}\n'];
  const oldCwd = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-old-")));
  const { root, sessionsRoot } = await fixture({ id, cwd: oldCwd, events, names: ["session.jsonl.zstd", "session.v4.jsonl.zstd"] });
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-new-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(oldCwd, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const session = { id, header: { type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd } };
  const { services } = harness({ root: sessionsRoot, session, previousPath: oldCwd });
  await relocateSession(services, session, target);

  const dir = join(sessionsRoot, projectKey(target), encodeSegment(id));
  assert.deepEqual((await readdir(dir)).sort(), ["session.jsonl.zstd", "session.v4.jsonl.zstd"]);
  for (const name of await readdir(dir)) {
    assert.equal(zstdDecompressSync(await readFile(join(dir, name))).toString("utf8"), `${headerLine(id, target)}\n`);
  }
});

test("a failed attach rolls the session back untouched", async (t) => {
  const id = "session-7777-8888";
  const events = ['{"seq":1,"type":"turn/end"}\n'];
  const oldCwd = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-old-")));
  const { root, dir, sessionsRoot } = await fixture({ id, cwd: oldCwd, events });
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-new-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(oldCwd, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const session = { id, header: { type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd } };
  const { services, handle } = harness({ root: sessionsRoot, session, previousPath: oldCwd, failAttach: true });

  await assert.rejects(() => relocateSession(services, session, target), /attach refused/);
  assert.equal(session.header.cwd, oldCwd, "the live session is back where it started");
  assert.equal(handle.header.cwd, oldCwd, "the write handle is back where it started");
  assert.equal(existsSync(dir), true, "the original log is untouched");
  assert.equal(existsSync(join(sessionsRoot, projectKey(target), encodeSegment(id))), false, "the staged copy is removed");
});

test("relocating to the current directory changes nothing", async (t) => {
  const id = "session-9999-0000";
  const oldCwd = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-old-")));
  const { root, sessionsRoot } = await fixture({ id, cwd: oldCwd, events: [] });
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(oldCwd, { recursive: true, force: true }));

  const session = { id, header: { type: "session", version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd: oldCwd } };
  const { services, calls } = harness({ root: sessionsRoot, session, previousPath: oldCwd });
  const result = await relocateSession(services, session, oldCwd);

  assert.equal(result.changed, false);
  assert.deepEqual(calls, []);
});

test("a real dsh session log survives the rewrite", async (t) => {
  const found = await findRealLog();
  if (found === undefined) return t.skip("no stored session log on this machine");
  const id = found.header.id;
  const oldCwd = found.header.cwd;
  if (typeof id !== "string" || typeof oldCwd !== "string") return t.skip("stored log carries no cwd");

  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-")));
  const dir = join(root, "sessions", projectKey(oldCwd), encodeSegment(id));
  await mkdir(dir, { recursive: true });
  const originalPath = join(dir, found.name);
  await writeFile(originalPath, found.bytes);
  const originalText = await decodeLog(originalPath);
  if (originalText === undefined) return t.skip("the zstd CLI is not installed");
  const target = await realpath(await mkdtemp(join(tmpdir(), "dsh-cd-new-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(target, { recursive: true, force: true }));

  const session = { id, header: { ...found.header } };
  const { services } = harness({ root: join(root, "sessions"), session, previousPath: oldCwd });
  await relocateSession(services, session, target);

  const moved = join(root, "sessions", projectKey(target), encodeSegment(id), found.name);
  const rewritten = await readFile(moved);
  const expectedHeader = JSON.stringify({ ...found.header, cwd: target });
  assert.equal(zstdDecompressSync(rewritten).toString("utf8"), `${expectedHeader}\n`, "frame one is the patched header alone");
  assert.equal(await decodeLog(moved), `${expectedHeader}\n${originalText.slice(originalText.indexOf("\n") + 1)}`, "every event survived");
});

/** The newest-format stored log this machine has, decoded just far enough to know its identity. */
async function findRealLog() {
  const sessions = join(homedir(), ".dsh", "sessions");
  let projects;
  try {
    projects = await readdir(sessions, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const wanted of ["session.v4.jsonl.zstd", "session.jsonl.zstd"]) {
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      let entries;
      try {
        entries = await readdir(join(sessions, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(sessions, project.name, entry.name, wanted);
        if (!existsSync(path)) continue;
        const bytes = await readFile(path);
        try {
          const header = JSON.parse(zstdDecompressSync(bytes).toString("utf8"));
          if (typeof header?.id === "string") return { name: wanted, bytes, header };
        } catch {
          continue;
        }
      }
    }
  }
  return undefined;
}
