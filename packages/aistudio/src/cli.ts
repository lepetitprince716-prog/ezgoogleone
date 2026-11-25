import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { checkOutputs, parseArgs, testOnlyNumber, UsageError, type Req } from "./args.ts";
import { LEDGER_CMDS, ledgerLine, parseLedger, summarise } from "./ledger.mjs";
import {
  holderPid,
  PAGE_STALE_MS,
  pageRunning,
  resolveCacheDir,
  resolveStateDir,
  tryLock,
  unlock,
  withRegistry,
  writeAtomic,
  type LockHandle,
} from "./lock.ts";
import { BEAT_MS, markerStale } from "./pagestate.mjs";
import { acquireLock, LockTimeout } from "./download.mjs";

const SRC = import.meta.dir;
const STATE = resolveStateDir("aistudio", "AISTUDIO_STATE_DIR");
const CACHE = resolveCacheDir("aistudio");
const LOCKS = join(STATE, "locks");
const GLOBAL = join(STATE, "global");
const DOWNLOAD_LOCK = join(GLOBAL, "downloads.lock");
const DOWNLOAD_CMDS = ["image", "speech", "build-export"];
const SPACES = join(STATE, "spaces.json");
const MODELS = process.env.AISTUDIO_MODELS_CACHE?.trim() || join(CACHE, "models.json");
const LEDGER = join(STATE, "usage.jsonl");
const CANCELS = join(STATE, "cancel");

const testOnly = (name: string): number | null => {
  const k = testOnlyNumber(name, process.env[name]);
  if (k.note) process.stderr.write(`${k.note}\n`);
  return k.value;
};

const HARD_STOP_AFTER_MS = testOnly("AISTUDIO_HARD_STOP_AFTER_MS") ?? 20000;
const STOP_SETTLE_MS = testOnly("AISTUDIO_STOP_SETTLE_MS") ?? 15000;
const GUARD_MARGIN_S = 600;
const TEST_GUARD_S = testOnly("AISTUDIO_TEST_GUARD_S");
const RESET_LOCK_WAIT_MS = testOnly("AISTUDIO_TEST_RESET_LOCK_WAIT_MS") ?? 10000;
const MODELS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const NO_EGO = "install ego-browser on PATH and ensure your shell can reach it (`ego-browser doctor`)";

type Out = Record<string, unknown> & { ok: boolean; exit: number };

class Exit {
  constructor(readonly out: Out) {}
}

function fail(exit: number, error: string, next: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(`${error}\nnext: ${next}\n`);
  throw new Exit({ ok: false, exit, error, next, ...extra });
}

function readJson<T>(f: string, dflt: T): T {
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return dflt;
  }
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const lockFile = (space: string) => join(LOCKS, `${space}.lock`);
const pageMarker = (space: string) => join(LOCKS, `${space}.page`);

function trySpace(space: string): { handle: LockHandle } | { why: string } {
  const f = lockFile(space);
  let handle: LockHandle | null;
  try {
    handle = tryLock(f);
  } catch (e) {
    fail(1, `could not open lock ${f}: ${errText(e)}`, "check that the state folder is writable");
  }
  if (handle === null) {
    const pid = holderPid(f);
    return { why: `driver ${pid ? `pid ${pid}` : "(pid not written yet)"} holds ${f}` };
  }
  const page = pageRunning(pageMarker(space));
  if (page) {
    unlock(handle);
    return {
      why: `a page script is still running on it (marker ${pageMarker(space)} updated ${page.ageMs} ms ago${page.note ? `: ${page.note}` : ""})`,
    };
  }
  return { handle };
}

function takeSpace(space: string): LockHandle {
  const r = trySpace(space);
  if ("why" in r) {
    fail(
      1,
      `space ${space} is busy: ${r.why}`,
      `wait for it to finish (a page marker goes stale ${PAGE_STALE_MS / 1000} s after its script stops), or pass --space <another name>`
    );
  }
  return r.handle;
}

function remember(space: string) {
  try {
    withRegistry(SPACES, (s) => s.add(space));
  } catch (e) {
    fail(1, `could not update space registry ${SPACES}: ${errText(e)}`, "check that the state folder is writable");
  }
}

function cachedModels(): Out | null {
  if (!existsSync(MODELS)) return null;
  const c = readJson<{ fetched?: string; models?: unknown[] } | null>(MODELS, null);
  const t = c?.fetched ? Date.parse(c.fetched) : NaN;
  if (!c || !Array.isArray(c.models) || !c.models.length || !Number.isFinite(t) || Date.now() - t > MODELS_MAX_AGE_MS) return null;
  return { ok: true, exit: 0, cmd: "models", source: "cache", fetched: c.fetched, file: MODELS, count: c.models.length, models: c.models };
}

let activeStop: ((reason: string) => void) | null = null;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function finishSpace(space: string): Promise<Record<string, unknown>> {
  return egoCall(
    `const STOP = ${JSON.stringify({ space })};
const e = (await listTaskSpaces()).find((s) => s.name === STOP.space);
let r;
if (!e) r = { finished: false, why: "not open" };
else if (e.ownership !== "agent") r = { finished: false, why: "with the user (" + e.ownership + "); not taken over" };
else {
  try {
    await (await taskSpace(e.id)).finish({ keep: [] });
    r = { finished: true, id: e.id };
  } catch (x) {
    r = { finished: false, id: e.id, why: String(x?.message ?? x).slice(0, 200) };
  }
}
console.log(JSON.stringify({ aistudioHardStop: r }));
`,
    "aistudioHardStop"
  );
}

async function resetDownloads(): Promise<Record<string, unknown>> {
  const note = `reset after a hard stop, driver pid ${process.pid}`;
  let lock: { release(): void } | null = null;
  let lockNote: string | null = null;
  try {
    lock = await acquireLock(DOWNLOAD_LOCK, { note, waitMs: 0 });
  } catch (e) {
    if (!(e instanceof LockTimeout)) return { ran: false, why: `could not open download lock ${DOWNLOAD_LOCK}: ${errText(e)}` };
    const holder = String((e as LockTimeout & { holder?: string }).holder ?? "");
    if (new RegExp(`driver pid ${process.pid}( |$)`).test(holder)) {
      lockNote = "the stopped page still holds the download lock; reset without it";
    } else {
      try {
        lock = await acquireLock(DOWNLOAD_LOCK, { note, waitMs: RESET_LOCK_WAIT_MS });
      } catch {
        return {
          ran: false,
          why: `another driver holds the download lock (${holder || "holder unknown"}); it resets behavior when its download ends`,
        };
      }
    }
  }
  try {
    const space = `aistudio-reset-${process.pid}-${randomBytes(3).toString("hex")}`;
    const r = await egoCall(
      `const RESET = ${JSON.stringify({ space })};
let r;
let task = null;
try {
  task = await taskSpace(RESET.space);
  const page = await task.newPage();
  await page.cdp("Browser.setDownloadBehavior", { behavior: "default" });
  r = { ran: true, space: RESET.space };
} catch (x) {
  r = { ran: false, space: RESET.space, why: String(x?.message ?? x).slice(0, 200) };
}
if (task) {
  try {
    await task.finish({ keep: [] });
    r.finished = true;
  } catch (x) {
    r.finished = false;
    r.finishWhy = String(x?.message ?? x).slice(0, 200);
  }
}
console.log(JSON.stringify({ aistudioDownloadReset: r }));
`,
      "aistudioDownloadReset"
    );
    let registered = false;
    if (r.finished !== true) {
      try {
        withRegistry(SPACES, (reg) => reg.add(space));
        registered = true;
      } catch (e) {
        process.stderr.write(`could not register reset space ${space} for close: ${errText(e)}\n`);
      }
    }
    return { ran: r.ran === true, ...r, ...(registered ? { registered: true } : {}), ...(lockNote ? { lock: lockNote } : {}) };
  } finally {
    lock?.release();
  }
}

async function egoCall(script: string, key: string): Promise<Record<string, unknown>> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["ego-browser", "nodejs"], { stdin: Buffer.from(script), stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { finished: false, ran: false, why: `could not start ego-browser: ${errText(e)}` };
  }
  const t = setTimeout(() => p.kill(), 30000);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(t);
  for (const l of `${o}\n${e}`.split("\n").reverse()) {
    try {
      const v = JSON.parse(l.trim());
      if (v && typeof v === "object" && v[key] && typeof v[key] === "object") return v[key];
    } catch {}
  }
  return { finished: false, ran: false, why: `ego-browser printed no answer (exit ${p.exitCode}): ${`${o}${e}`.trim().slice(-200)}` };
}

async function drive(req: Req, opts: { cancelFile?: string } = {}): Promise<Out> {
  const engine = readFileSync(join(SRC, "page.mjs"), "utf8");
  const marker = pageMarker(req.space);
  const cancelFile = opts.cancelFile ?? null;
  const guardS = TEST_GUARD_S ?? (typeof req.timeoutS === "number" ? req.timeoutS : 300) + GUARD_MARGIN_S;
  const payload = {
    ...req,
    libDir: SRC,
    downloadLock: DOWNLOAD_LOCK,
    pageMarker: req.cmd === "close" ? null : marker,
    cancelFile,
    driverPid: process.pid,
    guardS,
  };
  // ego-browser writes piped script console.log output to stderr; parse both streams and keep only the final result JSON.
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["ego-browser", "nodejs"], {
      stdin: Buffer.from(`const REQ = ${JSON.stringify(payload)};\n${engine}`),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, exit: 1, error: `could not start ego-browser: ${errText(e)}`, next: NO_EGO, sent: false };
  }

  let stopping: { reason: string; at: number } | null = null;
  let hardStop: Record<string, unknown> | null = null;
  let downloadReset: Record<string, unknown> | null = null;
  let stopDone: Promise<void> = Promise.resolve();
  const exited = proc.exited.then(() => true);

  const stop = (reason: string) => {
    if (stopping) {
      process.stderr.write(`${reason}: already stopping (${stopping.reason})\n`);
      return;
    }
    stopping = { reason, at: Date.now() };
    if (!cancelFile) {
      proc.kill();
      return;
    }
    try {
      mkdirSync(dirname(cancelFile), { recursive: true });
      writeFileSync(cancelFile, `${reason} ${new Date().toISOString()} driver pid ${process.pid}\n`);
    } catch (e) {
      process.stderr.write(`could not write cancel file ${cancelFile}: ${errText(e)}\n`);
    }
    process.stderr.write(`${reason}: asked page to stop (${cancelFile}); hard stop in ${HARD_STOP_AFTER_MS / 1000} s if still running\n`);
    stopDone = (async () => {
      if (await Promise.race([exited, sleepMs(HARD_STOP_AFTER_MS).then(() => false)])) return;
      if (pageRunning(marker)) {
        process.stderr.write(`page still running; finishing space ${req.space}\n`);
        hardStop = await finishSpace(req.space);
        process.stderr.write(`hard stop: ${JSON.stringify(hardStop)}\n`);
        const until = Date.now() + STOP_SETTLE_MS;
        while (Date.now() < until && pageRunning(marker) && !(await Promise.race([exited, sleepMs(500).then(() => false)]))) {}
        if (DOWNLOAD_CMDS.includes(req.cmd)) {
          downloadReset = await resetDownloads();
          process.stderr.write(`download behavior reset: ${JSON.stringify(downloadReset)}\n`);
        }
      }
      if (!(await Promise.race([exited, sleepMs(5000).then(() => false)]))) proc.kill();
    })();
  };

  activeStop = stop;
  const guard = setTimeout(() => stop(`ego-browser did not finish within ${guardS} s`), guardS * 1000);
  let last: Out | null = null;
  let sentSeen = false;

  const onLine = (line: string) => {
    const l = line.trim();
    if (l.startsWith("{")) {
      try {
        const o = JSON.parse(l);
        if (o && typeof o === "object" && o.aistudioEvent === "sent") {
          sentSeen = true;
          return;
        }
        if (o && typeof o === "object" && typeof o.ok === "boolean" && typeof o.exit === "number") {
          last = o;
          return;
        }
      } catch {}
    }
    if (l) process.stderr.write(line + "\n");
  };

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf) onLine(buf);
  };

  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  clearTimeout(guard);
  activeStop = null;
  await stopDone;

  let r: Out;
  if (!last) {
    r = {
      ok: false,
      exit: 1,
      cmd: req.cmd,
      error: `ego-browser exited with code ${code} and printed no result`,
      next: NO_EGO,
      ...(sentSeen ? { sent: true } : {}),
    };
  } else {
    r = last;
    if (code !== 0 && code !== r.exit) {
      process.stderr.write(`note: ego-browser exit code ${code}, page reported exit ${r.exit}; using page exit\n`);
    }
    if (sentSeen && typeof r.sent !== "boolean") r.sent = true;
  }

  if (!stopping) return r;
  const s: { reason: string; at: number } = stopping;
  const spaces = req.cmd === "close" ? ((req.spaces as string[] | undefined) ?? []) : [req.space];
  const judged = await Promise.all(spaces.map(async (sp) => [sp, await markerStale(pageMarker(sp), { beatMs: BEAT_MS })] as const));
  const running = judged.filter(([, j]) => !j.stopped).map(([sp]) => sp);
  const pageStopped = req.cmd === "close" ? Object.fromEntries(judged.map(([sp, j]) => [sp, j.stopped])) : running.length === 0;
  if (!running.length && cancelFile) {
    try {
      unlinkSync(cancelFile);
    } catch {}
  }
  const extra: Record<string, unknown> = {
    interrupted: s.reason,
    pageStopped,
    ...(hardStop ? { hardStop } : {}),
    ...(hardStop && DOWNLOAD_CMDS.includes(req.cmd) ? { downloadReset: downloadReset ?? { ran: false, why: "not reached" } } : {}),
  };
  if (r.ok) return { ...r, ...extra };
  const next = running.length
    ? req.cmd === "close"
      ? `a page script may still run on ${running.join(", ")}; check those spaces in ego-browser, then run close again`
      : `the page script may still run: marker ${marker} still beats; inspect space ${req.space} in ego-browser or restart it`
    : req.cmd === "close"
      ? "close was stopped; run close again to see what remains"
      : "the page script ended; run again when ready (a sent request may still save its chat on the site)";
  return { ...r, ...extra, ok: false, exit: 1, error: r.error && last ? r.error : `stopped (${s.reason})`, next };
}

function finishText(req: Req, o: Out): Out {
  if (!("_text" in o) && !("_pageText" in o)) return o;
  const { _text, _pageText, ...rest } = o;
  const out = req.out as string;
  const pageOut = `${out}.page.md`;
  const conflict = typeof _pageText === "string" && _pageText.length > 0;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, String(_text ?? ""));
    if (conflict) writeFileSync(pageOut, _pageText as string);
  } catch (e) {
    return {
      ...rest,
      ok: false,
      exit: 1,
      error: `could not write ${out}: ${errText(e)}`,
      next: "free disk space or pass another --out; the chat is saved on the site",
      out: null,
    };
  }
  const r: Out = { ...rest, out, bytes: statSync(out).size };
  if (!conflict) return r;
  return {
    ...r,
    ok: false,
    exit: 1,
    pageOut,
    pageBytes: statSync(pageOut).size,
    error: `the page text and network text disagree${r.exit && r.exit !== 1 ? ` (page reported exit ${r.exit})` : ""}`,
    next: `compare ${out} (network text) with ${pageOut} (page text); \`aistudio get --chat\` reads the turn again`,
  };
}

function finishModels(o: Out): Out {
  if (!o.ok || !Array.isArray(o.models)) return o;
  const fetched = new Date().toISOString();
  try {
    writeAtomic(MODELS, JSON.stringify({ fetched, source: "aistudio model picker, filter All", models: o.models }, null, 1) + "\n");
  } catch (e) {
    return {
      ...o,
      ok: false,
      exit: 1,
      source: "picker",
      fetched,
      file: null,
      error: `could not write models cache ${MODELS}: ${errText(e)}`,
      next: "check that the cache folder is writable; the list is in this JSON",
    };
  }
  return { ...o, source: "picker", fetched, file: MODELS };
}

function record(req: Req, o: Out) {
  try {
    if (!LEDGER_CMDS.includes(req.cmd)) return;
    mkdirSync(STATE, { recursive: true });
    appendFileSync(LEDGER, JSON.stringify(ledgerLine(req, o, new Date())) + "\n");
  } catch (e) {
    process.stderr.write(`could not append to usage ledger ${LEDGER}: ${(e as Error).message}\n`);
  }
}

function usageSummary(req: Req): Out {
  if (!existsSync(LEDGER)) {
    return { ok: true, exit: 0, cmd: "usage", file: LEDGER, note: "no ledger yet: no run, send, image or speech has finished", rows: [] };
  }
  const { lines, bad } = parseLedger(readFileSync(LEDGER, "utf8"));
  const s = summarise(lines, { days: req.days as number, now: new Date() });
  for (const r of s.rows) {
    process.stderr.write(
      `${r.day}  ${r.model.padEnd(28)} runs ${String(r.runs).padStart(3)}  not sent ${String(r.notReached).padStart(3)}  tokens ${String(r.tokens).padStart(9)}  limit hits ${r.limitHits.length}${r.firstLimitUtc ? `  first ${r.firstLimitUtc}` : ""}\n`
    );
  }
  return { ok: true, exit: 0, cmd: "usage", file: LEDGER, lines: lines.length, badLines: bad, ...s };
}

function listFiles(dir: string, skip: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && f !== skip) out.push({ path: relative(dir, f), bytes: statSync(f).size });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function finishExport(req: Req, o: Out): Out {
  if (!o.ok || typeof o.zip !== "string") return o;
  const outDir = req.outDir as string;
  let names: ReturnType<typeof Bun.spawnSync>;
  let meta: ReturnType<typeof Bun.spawnSync>;
  try {
    names = Bun.spawnSync(["unzip", "-Z1", o.zip]);
    meta = Bun.spawnSync(["unzip", "-Z", o.zip]);
  } catch (e) {
    return { ...o, ok: false, exit: 1, error: `unzip is not available on PATH: ${errText(e)}`, next: "install Info-ZIP `unzip` and unpack the kept zip manually" };
  }
  if (names.exitCode !== 0 || meta.exitCode !== 0) {
    return { ...o, ok: false, exit: 1, error: `download is not a readable zip: ${names.stderr.toString().trim().slice(0, 200)}`, next: "run again; the zip is kept at the zip path" };
  }
  const entries = names.stdout.toString().split("\n").filter(Boolean);
  const unsafe = entries.find((n) => n.startsWith("/") || n.split("/").includes(".."));
  if (unsafe) return { ...o, ok: false, exit: 1, error: `zip holds an unsafe path: ${unsafe}; not unpacked`, next: "inspect the zip manually" };
  const symlinkLine = meta.stdout.toString().split("\n").find((l) => /^l[rwxstST-]{9}\s/.test(l));
  if (symlinkLine) {
    return { ...o, ok: false, exit: 1, error: `zip holds a symlink entry: ${symlinkLine.trim().slice(0, 160)}; not unpacked`, next: "inspect the zip manually" };
  }
  const u = Bun.spawnSync(["unzip", "-q", "-n", o.zip, "-d", outDir]);
  if (u.exitCode !== 0) {
    return { ...o, ok: false, exit: 1, error: `unzip failed: ${u.stderr.toString().trim().slice(0, 200)}`, next: "the zip is kept; unpack it manually" };
  }
  const files = listFiles(outDir, o.zip);
  const tree = Array.isArray(o.tree) ? (o.tree as string[]) : [];
  const inZip = new Set(files.map((f) => f.path));
  const missing = tree.filter((t) => !inZip.has(t));
  const extra = files.map((f) => f.path).filter((p) => !tree.includes(p));
  const r: Out = { ...o, count: files.length, files, treeCheck: { treeFiles: tree.length, missingFromZip: missing, extraInZip: extra } };
  if (missing.length) {
    r.warnings = [...((o.warnings as string[] | undefined) ?? []), `files in Code view tree but not in zip: ${missing.join(", ")}`];
  }
  return r;
}

async function close(req: Req): Promise<Out> {
  const names = req.only ? [req.space] : withRegistry(SPACES, (s) => [...s].sort());
  const held = new Map<string, LockHandle>();
  const busy: string[] = [];
  const why: Record<string, string> = {};
  try {
    for (const s of names) {
      const r = trySpace(s);
      if ("handle" in r) held.set(s, r.handle);
      else {
        busy.push(s);
        why[s] = r.why;
      }
    }
    if (req.only && busy.length) fail(1, `space ${req.space} is busy: ${why[req.space]}`, "wait for the driver to finish, then close the space");
    const free = [...held.keys()];
    if (!free.length) return { ok: true, exit: 0, cmd: "close", closed: [], busy, note: "no idle space to close" };
    const o = await drive({ ...req, spaces: free });
    const skipped = Array.isArray(o.skipped) ? (o.skipped as { space?: string; why?: string }[]) : [];
    const gone = new Set<string>([
      ...(Array.isArray(o.closed) ? (o.closed as string[]) : []),
      ...skipped.filter((k) => k.why === "not open" && typeof k.space === "string").map((k) => k.space as string),
    ]);
    if (gone.size) {
      try {
        withRegistry(SPACES, (s) => {
          for (const g of gone) s.delete(g);
        });
      } catch (e) {
        process.stderr.write(`could not update space registry ${SPACES}: ${errText(e)}\n`);
      }
    }
    return { ...o, busy, ...(busy.length ? { busyWhy: why } : {}) };
  } finally {
    for (const h of held.values()) unlock(h);
  }
}

async function main(): Promise<Out> {
  let req: Req;
  try {
    req = parseArgs(process.argv.slice(2), { cwd: process.cwd(), home: homedir(), now: new Date() });
    checkOutputs(req);
  } catch (e) {
    if (e instanceof UsageError) fail(2, e.message, e.next);
    throw e;
  }

  if (req.cmd === "usage") return usageSummary(req);
  if (req.cmd === "models" && !req.refresh) {
    const c = cachedModels();
    if (c) return c;
  }

  let pageEnded = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (activeStop) return activeStop(sig);
      const o: Out = {
        ok: false,
        exit: 1,
        cmd: req.cmd,
        interrupted: sig,
        ...(req.cmd === "close" ? {} : { pageStopped: true }),
        error: `stopped by ${sig} ${pageEnded ? "after the page ended, before files were written" : "before the page started"}`,
        next: "run again",
      };
      void Bun.write(Bun.stdout, JSON.stringify(o) + "\n").then(() => process.exit(1));
    });
  }
  if (req.cmd === "close") return await close(req);

  const handle = takeSpace(req.space);
  const cancelFile = join(CANCELS, `${req.space}-${process.pid}-${randomBytes(3).toString("hex")}`);
  let result: Out;
  try {
    remember(req.space);
    result = await drive(req, { cancelFile });
  } finally {
    pageEnded = true;
    unlock(handle);
  }
  if (req.cmd === "models") result = finishModels(result);
  if (req.cmd === "run" || req.cmd === "send" || req.cmd === "get") result = finishText(req, result);
  if (req.cmd === "build-export") result = finishExport(req, result);
  record(req, result);
  return result;
}

let out: Out;
try {
  out = await main();
} catch (e) {
  if (e instanceof Exit) out = e.out;
  else {
    process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
    out = { ok: false, exit: 1, error: `driver error: ${errText(e)}`, next: "read stderr above; run again or report the error" };
  }
}
// Await stdout flush before process.exit so large JSON payloads are never truncated on pipes.
await Bun.write(Bun.stdout, JSON.stringify(out) + "\n");
process.exit(out.exit);
