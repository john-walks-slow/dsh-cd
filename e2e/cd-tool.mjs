/**
 * dsh-cd e2e — full behavioral test through the GUI.
 *
 * Flow: open e2e GUI → New session → instruct the model to cd to
 * /tmp/dsh-cd-e2e and then use RELATIVE paths for write/read and a workdir-less
 * bash pwd. Assert on the filesystem, the session log (which records the
 * model's original relative arguments), and the plugin state file.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import pw from "/root/projects/camoufox-mcp/node_modules/playwright-core/index.js";

const execFileP = promisify(execFile);
const E2E_HOME = process.env.DSH_E2E_HOME || "/root/.dsh-e2e";
const SESSIONS_ROOT = `${E2E_HOME}/sessions`;
const STATE_FILE = `${E2E_HOME}/dsh-cd/state.json`;
const TARGET_DIR = "/tmp/dsh-cd-e2e";
const MARKER = "dsh-cd-e2e-7f3a";
const PROMPT =
  `[${MARKER}] Automated e2e test of the cd tool. Execute EXACTLY these five tool calls in order, ` +
  "with EXACTLY these arguments — keep file paths RELATIVE exactly as written (do not turn them into absolute paths), " +
  "and do not pass a workdir to bash:\n" +
  '1. cd with path="/tmp/dsh-cd-e2e"\n' +
  '2. write with file_path="hello.txt" and content="ok"\n' +
  '3. bash with command="pwd" and NO workdir parameter\n' +
  '4. read with file_path="hello.txt"\n' +
  "5. cd with the path argument omitted (query current directory)\n" +
  "After all five calls, reply with one short line confirming completion. Use no other tools.";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function listSessionFiles() {
  const out = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const proj = `${SESSIONS_ROOT}/${d.name}`;
      return readdirSync(proj, { withFileTypes: true })
        .filter((s) => s.isDirectory() && s.name.startsWith("session-"))
        .map((s) => `${proj}/${s.name}/session.v3.jsonl.zstd`);
    });
  return out.filter(existsSync);
}

async function readLog(file) {
  try {
    const { stdout } = await execFileP("zstd", ["-dc", file], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // partial frame while the turn is still writing
  }
}

function parseEvents(log) {
  return log.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// --- prepare ---------------------------------------------------------------
rmSync(TARGET_DIR, { recursive: true, force: true });
mkdirSync(TARGET_DIR, { recursive: true });
if (existsSync(STATE_FILE)) {
  const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  parsed.entries = (parsed.entries || []).filter((e) => e.cwd !== TARGET_DIR);
  writeFileSync(STATE_FILE, JSON.stringify(parsed, null, 2) + "\n");
}

const owner = existsSync("/tmp/dsh-e2e.owner.json") ? JSON.parse(readFileSync("/tmp/dsh-e2e.owner.json", "utf8")) : {};
const port = process.env.DSH_E2E_PORT || owner.port;
if (!port) {
  console.log("FAIL  no e2e port (DSH_E2E_PORT unset, no owner record)");
  process.exit(1);
}
const url = `http://127.0.0.1:${port}/?token=e2etest`;

// --- GUI: new session + prompt ----------------------------------------------
const browser = await pw.firefox.launch({ executablePath: "/root/.cache/camoufox/camoufox-bin", headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(2000);
const baseline = new Set(listSessionFiles()); // BEFORE the click: "New session" creates the blank session file
await page.locator('button[aria-label="New session"]').first().click();
await page.waitForTimeout(2500);
const composer = page.locator('[contenteditable="true"]').first();
await composer.waitFor({ state: "visible", timeout: 15000 });
await composer.fill(PROMPT);
await page.locator('button[aria-label="Send message"]').first().click();
console.log("prompt sent, waiting for the turn…");

// --- poll for my session and turn completion --------------------------------
let sessionFile = null;
const deadline = Date.now() + 420000;
while (Date.now() < deadline && sessionFile === null) {
  for (const f of listSessionFiles()) {
    if (baseline.has(f)) continue;
    const log = await readLog(f);
    if (log && log.includes(MARKER)) { sessionFile = f; break; }
  }
  if (sessionFile === null) await new Promise((r) => setTimeout(r, 3000));
}
if (sessionFile === null) {
  console.log("FAIL  session with marker not found");
  await browser.close();
  process.exit(1);
}
console.log(`session log: ${sessionFile}`);

let events = [];
let turnDone = false;
while (Date.now() < deadline && !turnDone) {
  const log = await readLog(sessionFile);
  if (log) {
    events = parseEvents(log);
    if (events.some((e) => e.type === "turn/end")) turnDone = true;
  }
  if (!turnDone) await new Promise((r) => setTimeout(r, 4000));
}
await new Promise((r) => setTimeout(r, 3000));
const log = await readLog(sessionFile);
events = parseEvents(log);
await browser.close();

if (!turnDone) {
  console.log("FAIL  turn did not complete within timeout");
  process.exit(1);
}

// --- extract data ------------------------------------------------------------
const header = events.find((e) => e.type === "session");
const sessionId = header?.id;
const sessionCwd = header?.cwd;
const calls = events.filter((e) => e.type === "tool/call").map((e) => e.data);
const resultsByCall = new Map(events.filter((e) => e.type === "tool/result").map((e) => [e.data.message?.source?.callId, e.data]));

function callArgs(call) {
  try { return JSON.parse(call.arguments); } catch { return {}; }
}
function callResultText(call) {
  const r = resultsByCall.get(call.callId);
  return (r?.message?.content || []).map((c) => (c.content || []).map((x) => x.text || "").join("")).join("\n");
}

console.log(`session ${sessionId} cwd=${sessionCwd}`);
console.log("tool calls:", calls.map((c) => `${c.name}(${Object.keys(callArgs(c)).join(",")})`).join(" → "));

// --- assertions ---------------------------------------------------------------
const cdSet = calls.filter((c) => c.name === "cd");
const cdToTarget = cdSet.find((c) => callArgs(c).path === TARGET_DIR);
const cdQuery = cdSet.find((c) => callArgs(c).path === undefined);
const writeCall = calls.find((c) => c.name === "write");
const bashCall = calls.find((c) => c.name === "bash");
const readCall = calls.find((c) => c.name === "read");

check("cd tool exists and accepted the target", cdToTarget !== undefined, cdToTarget ? callResultText(cdToTarget).slice(0, 160) : "no cd call with path=" + TARGET_DIR);
if (cdToTarget) {
  const out = callResultText(cdToTarget);
  check("cd reports override active", /"override"\s*:\s*true/.test(out) && out.includes(TARGET_DIR), out.slice(0, 160));
}
check("write used the RELATIVE path", writeCall !== undefined && callArgs(writeCall).file_path === "hello.txt", writeCall ? `file_path=${JSON.stringify(callArgs(writeCall).file_path)}` : "no write call");
check("bash ran without workdir", bashCall !== undefined && callArgs(bashCall).workdir === undefined, bashCall ? `workdir=${JSON.stringify(callArgs(bashCall).workdir)}` : "no bash call");
if (bashCall) {
  const out = callResultText(bashCall);
  check("bash pwd resolved to the override dir", out.includes(TARGET_DIR), out.slice(0, 120).replace(/\n/g, "\\n"));
}
check("read used the RELATIVE path", readCall !== undefined && callArgs(readCall).file_path === "hello.txt", readCall ? `file_path=${JSON.stringify(callArgs(readCall).file_path)}` : "no read call");
if (readCall) {
  const out = callResultText(readCall);
  check("read resolved the relative file", out.includes("ok"), out.slice(0, 120).replace(/\n/g, "\\n"));
}
check("cd query returned override state", cdQuery !== undefined && callResultText(cdQuery).includes(TARGET_DIR), cdQuery ? callResultText(cdQuery).slice(0, 160) : "no cd query call");

const helloFile = `${TARGET_DIR}/hello.txt`;
check("file created inside override dir", existsSync(helloFile) && readFileSync(helloFile, "utf8") === "ok", existsSync(helloFile) ? `content=${JSON.stringify(readFileSync(helloFile, "utf8"))}` : `${helloFile} missing`);
check("file NOT created in session workspace root", !existsSync(`${sessionCwd}/hello.txt`), `${sessionCwd}/hello.txt`);

if (existsSync(STATE_FILE)) {
  const state = readFileSync(STATE_FILE, "utf8");
  check("state.json has an entry for this session", state.includes(sessionId) && state.includes(TARGET_DIR));
} else {
  check("state.json has an entry for this session", false, `${STATE_FILE} missing`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\nALL ${results.length} ASSERTIONS PASSED` : `\n${failed.length}/${results.length} ASSERTIONS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
