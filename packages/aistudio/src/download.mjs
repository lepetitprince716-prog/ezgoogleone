// Browser.setDownloadBehavior is browser-wide; serialize downloads across parallel spaces with a lock.
// Runs in both ego-browser's Node runtime and Bun tests (Node built-ins only).
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DARWIN_O_EXLOCK = 0x20;
const IS_DARWIN = process.platform === "darwin";

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.crdownload)?$/i;

export class LockTimeout extends Error {
  constructor(file, waitedMs, holder) {
    super(`the download lock ${file} stayed held for ${Math.round(waitedMs / 1000)} s${holder ? ` (holder: ${holder})` : ""}`);
    this.holder = holder;
  }
}

function readLockText(file) {
  try {
    const fd = openSync(file, constants.O_RDONLY);
    try {
      const buf = Buffer.alloc(300);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8").trim() || null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function tryOpenLock(file) {
  if (IS_DARWIN) {
    try {
      const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK | constants.O_NONBLOCK, 0o644);
      return { fd, path: file, unlinkOnRelease: false };
    } catch (e) {
      if (e?.code === "EAGAIN" || e?.code === "EWOULDBLOCK") return null;
      throw e;
    }
  }
  const lck = `${file}.lck`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lck, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o644);
      return { fd, path: lck, unlinkOnRelease: true };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const text = readLockText(lck);
      const m = text && /pid\s+(\d+)/.exec(text);
      if (m && !pidAlive(Number(m[1]))) {
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

export async function acquireLock(file, opts = {}) {
  const {
    note = "",
    waitMs = 150000,
    pollMs = 250,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  mkdirSync(dirname(file), { recursive: true });
  const t0 = now();
  let handle = tryOpenLock(file);
  while (handle === null) {
    if (now() - t0 >= waitMs) {
      const holder = readLockText(IS_DARWIN ? file : `${file}.lck`);
      throw new LockTimeout(file, now() - t0, holder);
    }
    await sleep(pollMs);
    handle = tryOpenLock(file);
  }
  try {
    ftruncateSync(handle.fd, 0);
    writeSync(handle.fd, `${note ? `${note} ` : ""}pid ${process.pid} ${new Date().toISOString()}\n`, 0);
  } catch {}
  let open = true;
  return {
    waitedMs: now() - t0,
    release() {
      if (!open) return;
      open = false;
      try {
        closeSync(handle.fd);
      } catch {}
      if (handle.unlinkOnRelease) {
        try {
          unlinkSync(handle.path);
        } catch {}
      }
    },
  };
}

export async function lockedDownload(page, dir, click, target, opts = {}) {
  const {
    lockFile,
    note = "",
    timeoutMs = 60000,
    lockWaitMs = 150000,
    settleMs = 1500,
    pollMs = 500,
    checkpoint = () => {},
    warn = () => {},
  } = opts;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!lockFile) throw new Error("lockedDownload needs opts.lockFile");
  await mkdir(dir, { recursive: true });
  const lock = await acquireLock(lockFile, { note, waitMs: lockWaitMs, sleep });
  try {
    const before = new Set(await readdir(dir));
    await page.cdp("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
    try {
      checkpoint("the download click");
      await click();
      const deadline = Date.now() + timeoutMs;
      let last = null, size = -1, since = 0;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const fresh = (await readdir(dir)).filter((f) => !before.has(f) && GUID_RE.test(f));
        const done = fresh.filter((f) => !f.endsWith(".crdownload"));
        if (done.length > 1) throw new Error(`more than one download landed in ${dir}: ${done.join(", ")}`);
        if (done.length === 1 && fresh.length === 1) {
          const f = `${dir}/${done[0]}`;
          const n = (await stat(f)).size;
          if (f === last && n === size && n > 0) {
            if (Date.now() - since >= settleMs) {
              const to = typeof target === "function" ? await target() : target;
              await rename(f, to);
              return { path: to, waitedMs: lock.waitedMs };
            }
          } else {
            last = f;
            size = n;
            since = Date.now();
          }
        }
      }
      return null;
    } finally {
      await Promise.resolve(page.cdp("Browser.setDownloadBehavior", { behavior: "default" })).catch((e) =>
        warn(`could not reset download behavior: ${String(e?.message ?? e).slice(0, 120)}`)
      );
    }
  } finally {
    lock.release();
  }
}
