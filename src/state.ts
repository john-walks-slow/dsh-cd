/**
 * Per-session working-directory state: the live overrides and their durable copy.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One session's state. `inherited` entries are spawn-time snapshots and are never persisted. */
export interface CwdEntry {
  cwd: string;
  previous?: string;
  updatedAt: number;
  inherited?: true;
}

export interface CdState {
  /** Live entries keyed by session id; created here or restored from disk. */
  readonly live: Map<string, CwdEntry>;
  /** Durable entries keyed by session id (inherited entries excluded). */
  readonly persisted: Map<string, CwdEntry>;
  /** Resolves once the durable entries have been read. */
  readonly ready: Promise<void>;
  readonly stateFile: string;
}

const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createCdState(stateFile: string): CdState {
  const persisted = new Map<string, CwdEntry>();
  const ready = loadPersisted(stateFile).then((entries) => {
    for (const [sessionId, entry] of entries) persisted.set(sessionId, entry);
  });
  return { live: new Map(), persisted, ready, stateFile };
}

/**
 * Read the durable entries, tolerating a missing or malformed file. Entries are
 * rebuilt field by field, so files written by older versions — which also
 * carried the real-workspace-switch fields `relocate`, `needsConsent` and
 * `relocateError` — load as plain overrides instead of failing.
 */
async function loadPersisted(stateFile: string): Promise<Map<string, CwdEntry>> {
  let raw: string;
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = new Map<string, CwdEntry>();
    if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)) {
      for (const entry of (parsed as { entries: unknown[] }).entries) {
        if (entry === null || typeof entry !== "object") continue;
        const { sessionId, cwd, previous, updatedAt } = entry as { sessionId?: unknown; cwd?: unknown; previous?: unknown; updatedAt?: unknown };
        if (typeof sessionId !== "string" || typeof cwd !== "string") continue;
        entries.set(sessionId, {
          cwd,
          ...(typeof previous === "string" ? { previous } : {}),
          updatedAt: typeof updatedAt === "number" ? updatedAt : 0
        });
      }
    }
    return entries;
  } catch (error) {
    console.warn(`dsh-cd: ignoring malformed state file ${stateFile}: ${String(error)}`);
    return new Map();
  }
}

/** Write the durable entries atomically (tmp + rename), pruning entries untouched for 30 days. */
export async function savePersisted(state: CdState): Promise<void> {
  await state.ready;
  const now = Date.now();
  const entries: object[] = [];
  for (const [sessionId, entry] of state.persisted) {
    if (now - entry.updatedAt > PERSIST_MAX_AGE_MS) continue;
    entries.push({
      sessionId,
      ...(entry.previous === undefined ? {} : { previous: entry.previous }),
      cwd: entry.cwd,
      updatedAt: entry.updatedAt
    });
  }
  await mkdir(dirname(state.stateFile), { recursive: true });
  const tempFile = `${state.stateFile}.tmp`;
  await writeFile(tempFile, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  await rename(tempFile, state.stateFile);
}
