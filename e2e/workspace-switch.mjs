/**
 * dsh-cd e2e — real workspace switching.
 *
 * Flow: GUI → New session → the model runs `cd {"path": A, "workspace": true}`
 * plus a relative write → the turn ends and the plugin relocates the session for
 * real → assert the stored log moved and was re-pinned, the workspace ledger
 * followed, the override is gone → a second turn proves the session still appends
 * (the write handle was redirected) → `/cd B` (host command) moves it again.
 *
 * Requires: a running dsh-e2e instance (DSH_E2E_PORT) and the `zstd` CLI.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { promisify } from "node:util";
import pw from "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";

const execFileP = promisify(execFile);
const E2E_HOME = process.env.DSH_E2E_HOME || "/root/.dsh-e2e";
const SESSIONS_ROOT = `${E2E_HOME}/sessions`;
const STATE_FILE = `${E2E_HOME}/dsh-cd/state.json`;
const WORKSPACES_FILE = `${E2E_HOME}/storages/workspace.json`;
const RUN = Date.now();
const DIR_A = `/tmp/dsh-cd-ws-a-${RUN}`;
const DIR_B = `/tmp/dsh-cd-ws-b-${RUN}`;
const MARKER = "dsh-cd-ws-9d2e";
const PROMPT =
  `[${MARKER}] Automated e2e test of the cd tool's real workspace switch. Execute EXACTLY these tool calls in order, ` +
  "keeping the write path RELATIVE exactly as written:\n" +
  `1. cd with path="${DIR_A}" and workspace=true\n` +
  '2. write with file_path="hello.txt" and content="ok"\n' +
  "Then reply with one short line confirming completion. Use no other tools.";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** dsh's project-directory key (mirrors the JSONL backend). */
function projectKey(cwd) {
  let readable = "";
  let separatorRun = false;
  for (const ch of cwd) {
    const code = ch.charCodeAt(0);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Every stored session on disk, with the project directory it currently sits in. */
function sessionDirs() {
  if (!existsSync(SESSIONS_ROOT)) return [];
  return readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((project) => {
      const base = `${SESSIONS_ROOT}/${project.name}`;
      return readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("session-"))
        .map((entry) => ({ project: project.name, id: entry.name, dir: `${base}/${entry.name}` }));
    });
}

/** The generation file dsh currently writes into. */
function logOf(dir) {
  const name = readdirSync(dir).find((candidate) => /^session(\.v[0-9]+)?\.jsonl(\.zstd)?$/.test(candidate) && candidate.includes(".v4.")) ??
    readdirSync(dir).find((candidate) => /^session(\.v[0-9]+)?\.jsonl(\.zstd)?$/.test(candidate));
  return name === undefined ? undefined : `${dir}/${name}`;
}

async function readLog(file) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", file], { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // partial frame while the turn is still writing
  }
}

function findSession(id) {
  return sessionDirs().find((entry) => entry.id === id);
}

async function headerCwd(entry) {
  const file = logOf(entry.dir);
  if (file === undefined) return null;
  const log = await readLog(file);
  if (log === null) return null;
  try {
    return JSON.parse(log.slice(0, log.indexOf("\n"))).cwd;
  } catch {
    return null;
  }
}

async function turnEnds(id) {
  const entry = findSession(id);
  if (entry === undefined) return 0;
  const file = logOf(entry.dir);
  const log = file === undefined ? null : await readLog(file);
  if (log === null) return 0;
  return log.split("\n").filter((line) => line.includes('"turn/end"')).length;
}

// --- prepare ----------------------------------------------------------------
for (const dir of [DIR_A, DIR_B]) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}
const port = process.env.DSH_E2E_PORT;
if (!port) {
  console.log("FAIL  DSH_E2E_PORT is unset");
  process.exit(1);
}
const url = `http://127.0.0.1:${port}/?token=${process.env.DSH_E2E_TOKEN || "e2etest"}`;

const browser = await pw.firefox.launch({ executablePath: "/root/.cache/camoufox/camoufox-bin", headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);

/** dsh 0.2 greets this profile with a preview notice and, without a provider key, an API-key dialog; both mask the UI. */
async function dismissNotice() {
  for (let round = 0; round < 8; round++) {
    if ((await page.locator('[class*="_mask_"]').count()) === 0) return;
    for (const name of ["Configure later", "Continue"]) {
      const button = page.getByRole("button", { name, exact: true });
      if ((await button.count()) > 0) await button.first().click({ timeout: 5000 }).catch(() => undefined);
    }
    await page.waitForTimeout(1200);
  }
}

async function send(text) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.fill(text);
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="Send message"]').first().click();
}

await dismissNotice();
// The GUI pre-creates a blank session on page load and may reuse it, so identity
// comes from the written marker plus a fresh log rather than from a new id.
const runStart = Date.now();
await page.locator('button[aria-label="New session"]').first().click();
await page.waitForTimeout(2500);
await send(PROMPT);
console.log("prompt sent, waiting for the turn…");

const deadline = Date.now() + 420000;
let session = null;
let round = 0;
while (Date.now() < deadline && session === null) {
  const candidates = sessionDirs();
  for (const entry of candidates) {
    const file = logOf(entry.dir);
    if (file === undefined || statSync(file).mtimeMs < runStart - 10000) continue;
    const log = await readLog(file);
    if (log?.includes(MARKER)) {
      session = entry;
      break;
    }
  }
  if (session === null) {
    if (round++ % 5 === 0) {
      console.log(`  waiting… ${candidates.map((entry) => `${entry.project}/${entry.id}`).join(" ") || "(no sessions yet)"}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
if (session === null) {
  console.log("FAIL  session with the marker not found");
  await browser.close();
  process.exit(1);
}
const sessionId = session.id;
const startProject = session.project;
console.log(`session ${sessionId} starts in ${startProject}`);

/** Poll until `probe` returns a truthy value, or the deadline passes. */
async function waitFor(probe, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) return undefined;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

await waitFor(() => turnEnds(sessionId).then((count) => count >= 1), 420000);
const firstTurnTools = [];
{
  const entry = findSession(sessionId);
  const file = logOf(entry.dir);
  for (const line of (await readLog(file)).split("\n")) {
    if (line.includes('"tool/call"')) firstTurnTools.push(line);
  }
}
check("the model called cd and write", firstTurnTools.some((line) => line.includes('"cd"')) && firstTurnTools.some((line) => line.includes('"write"')));

// --- the relocation runs at the turn end ------------------------------------
const relocated = await waitFor(() => {
  const entry = findSession(sessionId);
  return entry !== undefined && entry.project === projectKey(DIR_A) ? entry : undefined;
}, 60000);
check("the stored log moved into the target workspace directory", relocated !== undefined, relocated?.project ?? findSession(sessionId)?.project);
check("the stored header names the target directory", relocated !== undefined && (await headerCwd(relocated)) === DIR_A, relocated ? String(await headerCwd(relocated)) : "not relocated");
check("the original session directory is gone", !existsSync(`${SESSIONS_ROOT}/${startProject}/${sessionId}`), `${SESSIONS_ROOT}/${startProject}/${sessionId}`);
check("the relative write landed in the new directory", existsSync(`${DIR_A}/hello.txt`) && readFileSync(`${DIR_A}/hello.txt`, "utf8") === "ok");
const workspaces = existsSync(WORKSPACES_FILE) ? readFileSync(WORKSPACES_FILE, "utf8") : "";
check("the workspace ledger lists the session under the new directory", workspaces.includes(DIR_A) && workspaces.includes(sessionId));
const state = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8") : "";
check("the override was cleared after the real switch", !state.includes(sessionId), state.replace(/\s+/g, " ").slice(0, 140));

// --- second turn: the relocated session must still be appendable ------------
if (relocated === undefined) {
  await browser.close();
  console.log(`\n${results.filter((result) => !result.ok).length}/${results.length} ASSERTIONS FAILED (relocation never happened)`);
  process.exit(1);
}
const sizeBefore = statSync(logOf(relocated.dir)).size;
await send(`[${MARKER}] Reply with exactly: second turn ok. Use no tools.`);
await waitFor(() => turnEnds(sessionId).then((count) => count >= 2), 300000);
await new Promise((r) => setTimeout(r, 2000));
const after = findSession(sessionId);
check("the session is still stored under the target directory", after?.project === projectKey(DIR_A), after?.project);
check("the log grew after the relocation", after !== undefined && statSync(logOf(after.dir)).size > sizeBefore, after ? `${sizeBefore} → ${statSync(logOf(after.dir)).size}` : "log missing");
check("no stale session directory was recreated", !existsSync(`${SESSIONS_ROOT}/${startProject}/${sessionId}`));

// --- the host command moves the same session again -------------------------
await send(`/cd ${DIR_B}`);
const moved = await waitFor(() => {
  const entry = findSession(sessionId);
  return entry !== undefined && entry.project === projectKey(DIR_B) ? entry : undefined;
}, 60000);
check("the /cd command relocated the session", moved !== undefined, moved?.project ?? findSession(sessionId)?.project);
check("the stored header names the command's directory", moved !== undefined && (await headerCwd(moved)) === DIR_B, moved ? String(await headerCwd(moved)) : "not relocated");
if (moved !== undefined) {
  const log = await readLog(logOf(moved.dir));
  check("the session log records the command result", log !== null && log.includes("Moved this session to"), log === null ? "unreadable" : log.includes("Moved this session to") ? "found" : "missing");
}
await browser.close();

const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `\nALL ${results.length} ASSERTIONS PASSED` : `\n${failed.length}/${results.length} ASSERTIONS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
