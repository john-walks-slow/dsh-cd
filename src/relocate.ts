/**
 * Real workspace switching: re-pin one session's `cwd` identity.
 *
 * dsh treats `session.header.cwd` as the session's identity. It derives the
 * session's storage path from it (`<root>/<projectKey(cwd)>/<encoded id>`), gates
 * workspace membership on its canonical value, and reads the sandbox root, the
 * file tools' relative-path base and the `{{cwd}}` prompt variable from the live
 * header on every call. The host offers no API for moving a session, so this
 * module performs the move itself:
 *
 *   1. rewrite the header line of every stored generation into the target project
 *      directory. A session log is a concatenation of Zstandard frames whose
 *      first frame holds exactly the header line, so only that frame is decoded
 *      and re-encoded (checksum on, like dsh) and the remaining frames are copied
 *      byte for byte — re-compressing the whole log would break the invariant.
 *   2. swap the live `session.header` and redirect the JSONL write handle, so
 *      later appends land on the new path instead of the removed one.
 *   3. move the workspace ledger: attach the session to the target workspace
 *      (which validates the stored header), then detach it from the old one.
 *
 * Every step is reversible until the old directory is dropped, and a failure
 * rolls the session back and reports why.
 */
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** The live session of one agent; the plugin never depends on the host's Session type directly. */
export type LiveSession = Agent["session"];
export type SessionHeader = LiveSession["header"];

/** The JSONL backend bookkeeping a move must reach. dsh declares these private and offers no seam, so they are narrowed here to exactly what is used. */
interface WriteHandle {
  header?: { cwd?: string };
}
interface PersistenceLike {
  config?: { root?: string };
  flush(): Promise<void>;
  tracker?: { writers?: Map<string, WriteHandle | null> };
}
interface WorkspaceEntityLike {
  readonly path: string;
  readonly title: string;
  attachSession(sessionId: string): Promise<void>;
  detachSession(sessionId: string): Promise<void>;
}
interface RegistryLike {
  resolveByPath(path: string): Promise<WorkspaceEntityLike | undefined>;
  create(path: string, title: string): Promise<WorkspaceEntityLike>;
  indexHeader(header: SessionHeader): Promise<void>;
}

export interface RelocateServices {
  persistence: PersistenceLike;
  registry: RegistryLike;
}

export interface RelocateResult {
  /** False when the session already works in the requested directory. */
  changed: boolean;
  cwd: string;
  workspace: { path: string; title: string; created: boolean };
}

/** Canonical generation-file names: `session.jsonl`, `session.v4.jsonl.zstd`, … */
const GENERATION_FILE = /^(session(?:\.v([1-9][0-9]*))?\.jsonl)(\.zstd)?$/u;
const ZSTD_MAGIC = 4247762216;
const ZSTD_CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

/** Move one session's workspace to `targetPath`, creating the workspace record when it does not exist yet. */
export async function relocateSession(services: RelocateServices, session: LiveSession, targetPath: string): Promise<RelocateResult> {
  const id = session.id;
  const previousHeader = session.header;
  const previousCwd = previousHeader.cwd;
  if (previousCwd === undefined) throw new Error("this session stores no cwd to relocate from");
  const target = await canonicalDirectory(targetPath);
  if (target === (await canonicalDirectory(previousCwd))) {
    const existing = await services.registry.resolveByPath(target);
    return { changed: false, cwd: target, workspace: { path: target, title: existing?.title ?? basename(target), created: false } };
  }

  const root = services.persistence.config?.root;
  if (typeof root !== "string" || root.length === 0) throw new Error("this dsh build does not expose the session storage root, so a real workspace switch is unavailable");
  const writers = services.persistence.tracker?.writers;
  if (writers === undefined) throw new Error("this dsh build does not expose the session write handle, so a real workspace switch is unavailable");

  await services.persistence.flush();

  const encodedId = encodeSegment(id);
  const oldDir = join(root, projectKey(previousCwd), encodedId);
  const newDir = join(root, projectKey(target), encodedId);
  if (await isDirectory(newDir)) throw new Error(`a session directory already exists at ${newDir}`);

  const files = await generationFiles(oldDir);
  if (files.length === 0) throw new Error(`no session log found at ${oldDir}`);

  const nextHeader = { ...previousHeader, cwd: target };

  // 1. Stage the rewritten log under the target project directory; the session keeps working from the old path meanwhile.
  await mkdir(newDir, { recursive: true });
  try {
    for (const name of files) {
      const compressed = name.endsWith(".zstd");
      const source = await readFile(join(oldDir, name));
      const destination = join(newDir, name);
      await writeFile(destination, rewriteHeaderFrame(source, target, compressed));
      const written = decodeHeaderLine(await readFile(destination), compressed);
      if (written.cwd !== target || written.id !== id) throw new Error(`the rewritten log ${name} did not read back as session ${id} in ${target}`);
    }
  } catch (error) {
    await rm(newDir, { recursive: true, force: true });
    throw error;
  }

  // 2. Re-pin the live objects so this process keeps writing to the new path.
  const handle = writers.get(id) ?? undefined;
  const previousHandleHeader = handle?.header;
  (session as { header: SessionHeader }).header = nextHeader;
  if (handle !== undefined) handle.header = { ...previousHandleHeader, cwd: target };
  try {
    await services.registry.indexHeader(nextHeader);
  } catch (error) {
    await rollback();
    throw error;
  }

  // 3. Move the workspace ledger: attach to the target first, so membership never lapses.
  const existingTarget = await services.registry.resolveByPath(target);
  const workspace = existingTarget ?? (await services.registry.create(target, basename(target)));
  try {
    await workspace.attachSession(id);
  } catch (error) {
    await rollback();
    throw error;
  }
  const previousWorkspace = await services.registry.resolveByPath(previousCwd).catch(() => undefined);
  if (previousWorkspace !== undefined && previousWorkspace !== workspace) await previousWorkspace.detachSession(id);

  // 4. Drop the old directory; dsh locates a session by (cwd, id), so a leftover could only confuse a human reader.
  await rm(oldDir, { recursive: true, force: true });

  return { changed: true, cwd: target, workspace: { path: workspace.path, title: workspace.title, created: existingTarget === undefined } };

  /** Undo the in-memory re-pin and the staged files; the old directory was never touched. */
  async function rollback(): Promise<void> {
    (session as { header: SessionHeader }).header = previousHeader;
    if (handle !== undefined) handle.header = previousHandleHeader;
    await services.registry.indexHeader(previousHeader).catch(() => undefined);
    await rm(newDir, { recursive: true, force: true });
  }
}

/** Resolve `path` to its real path, refusing anything that is not a directory. */
async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`"${path}" is not a directory`);
  return canonical;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The stored generation files of one session directory, in readdir order. */
async function generationFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => GENERATION_FILE.test(name));
}

/**
 * Replace the header line inside one stored log, keeping every later frame byte
 * for byte. The generation's own header object is patched, so a historical
 * generation keeps its format fields and only its `cwd` changes.
 */
function rewriteHeaderFrame(file: Buffer, cwd: string, compressed: boolean): Buffer {
  const decoded = decodeHeaderFrame(file, compressed);
  if (decoded === undefined) throw new Error("the stored log has no header line");
  const header = { ...decoded, cwd };
  const line = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  if (!compressed) return Buffer.concat([line, file.subarray(file.indexOf(0x0a) + 1)]);
  return Buffer.concat([zstdCompressSync(line, ZSTD_CHECKSUM), file.subarray(firstZstdFrameEnd(file))]);
}

/** Parse the header line out of one stored log (frame one only, for compressed logs), or undefined when there is none. */
function decodeHeaderLine(file: Buffer, compressed: boolean): Record<string, unknown> {
  const decoded = decodeHeaderFrame(file, compressed);
  if (decoded === undefined) throw new Error("the stored log has no header line");
  return decoded;
}

function decodeHeaderFrame(file: Buffer, compressed: boolean): Record<string, unknown> | undefined {
  const text = compressed
    ? zstdDecompressSync(file.subarray(0, firstZstdFrameEnd(file))).toString("utf8")
    : file.subarray(0, file.indexOf(0x0a) + 1).toString("utf8");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.length === 0 || line.includes("\n")) throw new Error("the stored log's first frame is not a single header line");
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object") throw new Error("the stored log header is not an object");
  return value as Record<string, unknown>;
}

/** End offset of the first Zstandard frame, located the same way dsh locates it (frame header + block headers + optional checksum). */
function firstZstdFrameEnd(buffer: Buffer): number {
  if (buffer.length < 5 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) throw new Error("the stored log is not a Zstandard frame");
  const descriptor = buffer.readUInt8(4);
  if ((descriptor & 24) !== 0) throw new Error("the stored log has a reserved frame-header bit set");
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 32) !== 0;
  const checksum = (descriptor & 4) !== 0;
  const dictionaryFlag = descriptor & 3;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  let offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  for (;;) {
    if (buffer.length - offset < 3) throw new Error("the stored log ends inside a Zstandard block header");
    const blockHeader = buffer.readUIntLE(offset, 3);
    offset += 3;
    const blockType = (blockHeader >>> 1) & 3;
    if (blockType === 3) throw new Error("the stored log has a reserved Zstandard block type");
    offset += blockType === 1 ? 1 : blockHeader >>> 3;
    if (offset > buffer.length) throw new Error("the stored log ends inside a Zstandard block");
    if ((blockHeader & 1) !== 0) break;
  }
  if (checksum) offset += 4;
  if (offset > buffer.length) throw new Error("the stored log ends inside its Zstandard checksum");
  return offset;
}

/** Read the first line of a stored log, rejecting a log that has none. */
/**
 * Build the readable project-directory key for one session path. Ported verbatim
 * from the JSONL backend: filesystem and drive separators fold into `-`, unsafe
 * code units escape as `~XXXX`, and the key is bounded for filesystem limits.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
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

/** Encode one session id into its directory name. Ported verbatim from the JSONL backend. */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}
