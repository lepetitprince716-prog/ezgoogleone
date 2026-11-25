import {
  closeSync,
  constants,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// macOS <fcntl.h> O_EXLOCK (0x20); Node does not export it and Linux reuses 0x20 for O_NOCTTY/other flags.
const DARWIN_O_EXLOCK = 0x20;
const IS_DARWIN = process.platform === "darwin";

export const PAGE_STALE_MS = 8000;

export interface LockHandle {
  fd: number;
  cleanupPath?: string;
}

export function resolveStateDir(sub: string, envOverride?: string): string {
  const custom = envOverride && process.env[envOverride]?.trim();
  if (custom) return custom;
  const xdg = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(xdg, "google-agent-kit", sub);
}

export function resolveCacheDir(sub: string, envOverride?: string): string {
  const custom = envOverride && process.env[envOverride]?.trim();
  if (custom) return custom;
  const xdg = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(xdg, "google-agent-kit", sub);
}

export function writeAtomic(f: string, data: string): void {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, f);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function holderPid(file: string): number | null {
  try {
    const raw = readFileSync(IS_DARWIN ? file : `${file}.lck`, "utf8").trim();
    const n = Number(raw.split(/\s+/)[0]);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function tryLock(file: string): LockHandle | null {
  mkdirSync(dirname(file), { recursive: true });
  if (IS_DARWIN) {
    let fd: number;
    try {
      // Never unlink a flock file: doing so lets two openers lock separate inodes.
      fd = openSync(file, constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK | constants.O_NONBLOCK, 0o644);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
      throw e;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`, 0);
    return { fd };
  }

  const lck = `${file}.lck`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lck, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o644);
      writeSync(fd, `${process.pid}\n`, 0);
      return { fd, cleanupPath: lck };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = holderPid(file);
      if (pid !== null && !pidAlive(pid)) {
        try {
          unlinkSync(lck);
        } catch {}
        continue;
      }
      return null;
    }
  }
  return null;
}

export function lockBlocking(file: string, timeoutMs = 15000): LockHandle {
  mkdirSync(dirname(file), { recursive: true });
  if (IS_DARWIN) {
    const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK, 0o644);
    return { fd };
  }
  const deadline = Date.now() + timeoutMs;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const h = tryLock(file);
    if (h) return h;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${file}`);
    Atomics.wait(sab, 0, 0, 25);
  }
}

export function unlock(handle: LockHandle | null): void {
  if (!handle) return;
  try {
    closeSync(handle.fd);
  } catch {}
  if (handle.cleanupPath) {
    try {
      unlinkSync(handle.cleanupPath);
    } catch {}
  }
}

export function pageRunning(marker: string, now = Date.now()): { ageMs: number; note: string } | null {
  let st;
  try {
    st = statSync(marker);
  } catch {
    return null;
  }
  const ageMs = now - st.mtimeMs;
  if (ageMs > PAGE_STALE_MS) return null;
  let note = "";
  try {
    note = readFileSync(marker, "utf8").trim().slice(0, 200);
  } catch {}
  return { ageMs: Math.max(0, Math.round(ageMs)), note };
}

function readSpaces(f: string): string[] {
  try {
    const v = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function withRegistry<T>(f: string, fn: (spaces: Set<string>) => T): T {
  const h = lockBlocking(`${f}.lock`);
  try {
    const s = new Set(readSpaces(f));
    const before = JSON.stringify([...s].sort());
    const r = fn(s);
    const after = [...s].sort();
    if (JSON.stringify(after) !== before) writeAtomic(f, JSON.stringify(after, null, 1) + "\n");
    return r;
  } finally {
    unlock(h);
  }
}
