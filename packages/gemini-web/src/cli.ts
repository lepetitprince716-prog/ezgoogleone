import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs, UsageError, type WebReq } from "./args.ts";
import { holderPid, resolveStateDir, tryLock, unlock, withRegistry, type LockHandle } from "../../aistudio/src/lock.ts";

const SRC = import.meta.dir;
const STATE = resolveStateDir("gemini-web", "GEMINI_WEB_STATE_DIR");
const LOCKS = join(STATE, "locks");
const SPACES = join(STATE, "spaces.json");
const NO_EGO = "install ego-browser on PATH and ensure your shell can reach it (`ego-browser doctor`)";

type Out = Record<string, unknown> & { ok: boolean; exit: number };

class Exit {
  constructor(readonly out: Out) {}
}

function fail(exit: number, error: string, next: string): never {
  process.stderr.write(`${error}\nnext: ${next}\n`);
  throw new Exit({ ok: false, exit, error, next });
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const lockFile = (space: string) => join(LOCKS, `${space}.lock`);

async function drive(req: WebReq): Promise<Out> {
  const engine = readFileSync(join(SRC, "page.mjs"), "utf8");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["ego-browser", "nodejs"], {
      stdin: Buffer.from(`const REQ = ${JSON.stringify(req)};\n${engine}`),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, exit: 1, cmd: req.cmd, error: `could not start ego-browser: ${errText(e)}`, next: NO_EGO };
  }

  let last: Out | null = null;
  const onLine = (line: string) => {
    const l = line.trim();
    if (l.startsWith("{")) {
      try {
        const o = JSON.parse(l);
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
  if (!last) {
    return { ok: false, exit: 1, cmd: req.cmd, error: `ego-browser exited with code ${code} and printed no result`, next: NO_EGO };
  }
  return last;
}

function writeOut(req: WebReq, o: Out): Out {
  if (!("_text" in o)) return o;
  const { _text, ...rest } = o;
  const out = req.out as string;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, String(_text ?? ""));
  } catch (e) {
    return { ...rest, ok: false, exit: 1, error: `could not write ${out}: ${errText(e)}`, next: "pass a writable --out path" };
  }
  return { ...rest, out, bytes: statSync(out).size };
}

async function main(): Promise<Out> {
  let req: WebReq;
  try {
    req = parseArgs(process.argv.slice(2), { cwd: process.cwd(), home: homedir(), now: new Date() });
  } catch (e) {
    if (e instanceof UsageError) fail(2, e.message, e.next);
    throw e;
  }

  if (req.cmd === "close") {
    const names = req.only ? [req.space] : withRegistry(SPACES, (s) => [...s].sort());
    const held = new Map<string, LockHandle>();
    const busy: string[] = [];
    try {
      for (const s of names) {
        const h = tryLock(lockFile(s));
        if (h) held.set(s, h);
        else busy.push(s);
      }
      const free = [...held.keys()];
      if (!free.length) return { ok: true, exit: 0, cmd: "close", closed: [], busy, note: "no idle space to close" };
      const o = await drive({ ...req, spaces: free });
      const closed = Array.isArray(o.closed) ? (o.closed as string[]) : [];
      if (closed.length) withRegistry(SPACES, (s) => closed.forEach((c) => s.delete(c)));
      return { ...o, busy };
    } finally {
      for (const h of held.values()) unlock(h);
    }
  }

  const handle = tryLock(lockFile(req.space));
  if (!handle) {
    const pid = holderPid(lockFile(req.space));
    fail(1, `space ${req.space} is busy${pid ? ` (pid ${pid})` : ""}`, "wait for the running command or pass --space <name>");
  }
  try {
    withRegistry(SPACES, (s) => s.add(req.space));
    const res = await drive(req);
    return writeOut(req, res);
  } finally {
    unlock(handle);
  }
}

let out: Out;
try {
  out = await main();
} catch (e) {
  if (e instanceof Exit) out = e.out;
  else {
    process.stderr.write(`${String((e as Error)?.stack ?? e)}\n`);
    out = { ok: false, exit: 1, error: `driver error: ${errText(e)}`, next: "read stderr above and run again" };
  }
}
await Bun.write(Bun.stdout, JSON.stringify(out) + "\n");
process.exit(out.exit);
