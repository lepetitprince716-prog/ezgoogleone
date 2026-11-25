import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export class UsageError extends Error {
  next: string;
  constructor(message: string, next = "run `aistudio help` for the command forms") {
    super(message);
    this.next = next;
  }
}

export function testOnlyNumber(name: string, raw: string | undefined): { value: number | null; note?: string } {
  if (raw === undefined) return { value: null };
  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n) && n > 0) return { value: n };
  return {
    value: null,
    note: `${name}=${JSON.stringify(raw)} is not a positive number; ignored, the production value is used (test-only variable)`,
  };
}

export const DEFAULT_SPACE = "aistudio";
const THINKING_RE = /^[a-z]+(-[a-z]+){0,2}$/;

export function thinkingLabel(v: string): string {
  if (!THINKING_RE.test(v)) {
    throw new UsageError(`--thinking takes a level such as low, medium, high, minimal or extra-high, got ${v}`);
  }
  return v.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export const TOOLS = ["search", "url", "code"] as const;
const MAX_OUT_LIMIT = 1048576;
const CHAT_RE = /^https:\/\/aistudio\.google\.com\/prompts\/([A-Za-z0-9_-]{10,})(?:[?#].*)?$/;
const YOUTUBE_RE = /^https:\/\/(www\.)?(youtube\.com\/watch\?(.*&)?v=[A-Za-z0-9_-]{6,}|youtu\.be\/[A-Za-z0-9_-]{6,})/;
const APP_RE = /^https:\/\/aistudio\.google\.com\/apps\/([A-Za-z0-9-]{8,})(?:[?#].*)?$/;
export const SIZES = ["1K", "2K", "4K"] as const;
export const ASPECTS = [
  "Auto", "1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "4:1", "1:4", "8:1", "1:8",
] as const;
const SPACE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RESERVED_SPACES = ["downloads", "global", "locks", "cancel", "spaces", "usage"] as const;

export type Req = Record<string, unknown> & { cmd: string; space: string };

export interface Ctx {
  cwd: string;
  home: string;
  now: Date;
  pid?: number;
  rand?: string;
}

type Kind = "one" | "many" | "bool";
const COMMON: Record<string, Kind> = { "--space": "one" };
const SPEC: Record<string, Record<string, Kind>> = {
  check: {},
  models: { "--refresh": "bool" },
  run: {
    "--model": "one", "--prompt": "one", "--prompt-file": "one", "--system-file": "one",
    "--thinking": "one", "--max-out": "one", "--attach": "many", "--youtube": "one",
    "--tools": "one", "--schema": "one", "--out": "one", "--timeout": "one",
  },
  send: {
    "--chat": "one", "--prompt": "one", "--prompt-file": "one", "--attach": "many",
    "--youtube": "one", "--out": "one", "--timeout": "one",
  },
  get: { "--chat": "one", "--turn": "one", "--out": "one" },
  image: {
    "--model": "one", "--prompt": "one", "--prompt-file": "one", "--attach": "many",
    "--chat": "one", "--size": "one", "--aspect": "one", "--out-dir": "one", "--timeout": "one",
  },
  speech: {
    "--text": "one", "--text-file": "one", "--voice": "one", "--out": "one",
    "--model": "one", "--timeout": "one",
  },
  "build-export": { "--app": "one", "--out-dir": "one", "--timeout": "one" },
  usage: { "--days": "one" },
  close: {},
};

export const USAGE = `usage: aistudio <command> [options]   (drives aistudio.google.com via ego-browser)
  check
  models [--refresh]
  run --model <id> (--prompt <text> | --prompt-file <f>) [--system-file <f>] [--thinking minimal|low|medium|high|extra-high]
      [--max-out <n>] [--attach <f>...] [--youtube <url>] [--tools search,url,code] [--schema <json file>] [--out <f>] [--timeout <s>]
  send --chat <url|id> (--prompt <text> | --prompt-file <f>) [--attach <f>...] [--youtube <url>] [--out <f>] [--timeout <s>]
  get --chat <url|id> [--turn last|<n>] [--out <f>]
  image --model <id> (--prompt <text> | --prompt-file <f>) [--attach <image>...] [--chat <url|id>] [--size 1K|2K|4K] [--aspect <ratio>]
      --out-dir <dir> [--timeout <s>]
  speech (--text <t> | --text-file <f>) [--voice <name>] [--model <tts id>] --out <f.wav> [--timeout <s>]
  build-export --app <https://aistudio.google.com/apps/<id>> --out-dir <new or empty dir> [--timeout <s>]
  usage [--days <n>]   (reads local usage ledger; no browser)
  close [--space <name>]
every command also takes --space <name> (default ${DEFAULT_SPACE})`;

function split(cmd: string, argv: string[]): Map<string, string[] | true> {
  const allowed = { ...COMMON, ...SPEC[cmd] };
  const got = new Map<string, string[] | true>();
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument for ${cmd}: ${a}`);
    const kind = allowed[a];
    if (!kind) throw new UsageError(`${cmd} does not take ${a}`);
    if (got.has(a) && kind !== "many") throw new UsageError(`${a} given twice`);
    i++;
    if (kind === "bool") {
      got.set(a, true);
      continue;
    }
    const vals: string[] = [];
    while (i < argv.length && !(argv[i].startsWith("--") && argv[i].length > 2)) {
      vals.push(argv[i]);
      i++;
      if (kind === "one") break;
    }
    if (!vals.length) throw new UsageError(`${a} needs a value`);
    const prev = got.get(a);
    got.set(a, Array.isArray(prev) ? [...prev, ...vals] : vals);
  }
  return got;
}

function one(m: Map<string, string[] | true>, k: string): string | undefined {
  const v = m.get(k);
  return Array.isArray(v) ? v[0] : undefined;
}

function abs(ctx: Ctx, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

function existingFile(ctx: Ctx, p: string, what: string): string {
  const f = abs(ctx, p);
  if (!existsSync(f)) throw new UsageError(`${what}: no such file: ${f}`);
  if (!statSync(f).isFile()) throw new UsageError(`${what}: not a regular file: ${f}`);
  return f;
}

// Textarea values normalize CRLF to LF; normalize inputs upfront so read-back matches.
function lf(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function readText(ctx: Ctx, p: string, what: string): string {
  return readFileSync(existingFile(ctx, p, what), "utf8");
}

function prompt(ctx: Ctx, m: Map<string, string[] | true>, inline = "--prompt", file = "--prompt-file"): string {
  const a = one(m, inline), b = one(m, file);
  if ((a === undefined) === (b === undefined)) throw new UsageError(`give exactly one of ${inline} or ${file}`);
  const text = lf(a ?? readText(ctx, b!, file));
  if (!text.trim()) throw new UsageError(`${a !== undefined ? inline : file} is empty`);
  return text;
}

function posInt(v: string | undefined, what: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(v) || Number(v) > max) {
    throw new UsageError(`${what} must be an integer from 1 to ${max}, got ${v}`);
  }
  return Number(v);
}

function chatUrl(v: string): string {
  const bare = /^[A-Za-z0-9_-]{10,}$/.test(v) ? `https://aistudio.google.com/prompts/${v}` : v;
  const m = CHAT_RE.exec(bare);
  if (!m || m[1] === "new_chat") {
    throw new UsageError(`--chat must be https://aistudio.google.com/prompts/<id> or the id, got ${v}`);
  }
  return `https://aistudio.google.com/prompts/${m[1]}`;
}

function modelId(v: string | undefined): string {
  if (!v) throw new UsageError("--model is required", "run `aistudio models` for available ids");
  if (!/^[a-z][a-z0-9.-]{2,80}$/.test(v)) {
    throw new UsageError(`--model does not look like a model id: ${v}`, "run `aistudio models` for available ids");
  }
  return v;
}

function youtube(m: Map<string, string[] | true>): string | null {
  const yt = one(m, "--youtube");
  if (yt !== undefined && !YOUTUBE_RE.test(yt)) {
    throw new UsageError(`--youtube must be a youtube.com/watch?v= or youtu.be/ URL, got ${yt}`);
  }
  return yt ?? null;
}

function emptyDir(ctx: Ctx, m: Map<string, string[] | true>): string {
  const od = one(m, "--out-dir");
  if (!od) throw new UsageError("--out-dir is required");
  const d = abs(ctx, od);
  if (existsSync(d) && !statSync(d).isDirectory()) throw new UsageError(`--out-dir is not a directory: ${d}`);
  return d;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function textOut(ctx: Ctx, m: Map<string, string[] | true>, cmd: string): string {
  const o = one(m, "--out");
  if (o) return abs(ctx, o);
  const ms = String(ctx.now.getMilliseconds()).padStart(3, "0");
  const pid = ctx.pid ?? process.pid;
  const rand = ctx.rand ?? randomBytes(3).toString("hex");
  return join(ctx.home, ".cache", "google-agent-kit", "aistudio", "runs", `${stamp(ctx.now)}.${ms}-${cmd}-${pid}-${rand}.md`);
}

function timeout(m: Map<string, string[] | true>, dflt: number): number {
  return posInt(one(m, "--timeout"), "--timeout (seconds)", 7200) ?? dflt;
}

function attachments(ctx: Ctx, m: Map<string, string[] | true>): string[] {
  const v = m.get("--attach");
  if (!Array.isArray(v)) return [];
  const files = v.map((f) => existingFile(ctx, f, "--attach"));
  const names = files.map((f) => basename(f));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new UsageError(`--attach has two files named ${dup}; the page tells chips apart by file name`);
  return files;
}

export function parseArgs(argv: string[], ctx: Ctx): Req {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") throw new UsageError(USAGE, "pick one of the commands above");
  if (!SPEC[cmd]) throw new UsageError(`unknown command: ${cmd}`);
  const m = split(cmd, rest);
  const space = one(m, "--space") ?? DEFAULT_SPACE;
  if (!SPACE_RE.test(space)) throw new UsageError(`--space must be lowercase letters, digits and dashes (max 40), got ${space}`);
  if ((RESERVED_SPACES as readonly string[]).includes(space)) {
    throw new UsageError(`--space ${space} is reserved for driver state (${RESERVED_SPACES.join(", ")}); pick another name`);
  }
  if (space.startsWith("aistudio-reset-")) {
    throw new UsageError(`--space ${space} is reserved for download-behavior reset spaces; pick another name`);
  }
  const base = { cmd, space };

  switch (cmd) {
    case "check":
      return base;
    case "close":
      return m.has("--space") ? { ...base, only: true } : base;
    case "models":
      return { ...base, refresh: m.get("--refresh") === true };
    case "run": {
      const model = modelId(one(m, "--model"));
      const thinkingArg = one(m, "--thinking");
      const thinking = thinkingArg === undefined ? null : thinkingLabel(thinkingArg);
      const toolsArg = one(m, "--tools");
      let tools: string[] = [];
      if (toolsArg !== undefined) {
        tools = toolsArg.split(",").map((t) => t.trim());
        if (tools.some((t) => !(TOOLS as readonly string[]).includes(t))) {
          throw new UsageError(`--tools takes a comma list of ${TOOLS.join(", ")}, got ${toolsArg}`);
        }
        if (new Set(tools).size !== tools.length) throw new UsageError(`--tools repeats a tool: ${toolsArg}`);
      }
      const schemaFile = one(m, "--schema");
      let schema: unknown = null;
      if (schemaFile !== undefined) {
        try {
          schema = JSON.parse(readText({ ...ctx }, schemaFile, "--schema"));
        } catch (e) {
          if (e instanceof UsageError) throw e;
          throw new UsageError(`--schema is not valid JSON: ${(e as Error).message}`);
        }
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
          throw new UsageError("--schema must hold a JSON object");
        }
      }
      const yt = youtube(m);
      const sys = one(m, "--system-file");
      const system = sys === undefined ? null : lf(readText(ctx, sys, "--system-file"));
      if (system !== null && !system.trim()) {
        throw new UsageError("--system-file is empty; omit it for a run without a system instruction");
      }
      return {
        ...base,
        model,
        prompt: prompt(ctx, m),
        system,
        thinking,
        maxOut: posInt(one(m, "--max-out"), "--max-out", MAX_OUT_LIMIT) ?? null,
        attach: attachments(ctx, m),
        youtube: yt ?? null,
        tools,
        schema,
        out: textOut(ctx, m, "run"),
        timeoutS: timeout(m, 1200),
      };
    }
    case "send":
      return {
        ...base,
        chat: chatUrl(one(m, "--chat") ?? (() => { throw new UsageError("--chat is required"); })()),
        prompt: prompt(ctx, m),
        attach: attachments(ctx, m),
        youtube: youtube(m),
        out: textOut(ctx, m, "send"),
        timeoutS: timeout(m, 1200),
      };
    case "get": {
      const c = one(m, "--chat");
      if (!c) throw new UsageError("--chat is required");
      const t = one(m, "--turn") ?? "last";
      const turn = t === "last" ? "last" : posInt(t, "--turn", 10000);
      return { ...base, chat: chatUrl(c), turn, out: textOut(ctx, m, "get") };
    }
    case "image": {
      const model = modelId(one(m, "--model"));
      const outDir = emptyDir(ctx, m);
      const c = one(m, "--chat");
      const size = one(m, "--size") ?? null;
      if (size !== null && !(SIZES as readonly string[]).includes(size)) {
        throw new UsageError(`--size takes ${SIZES.join(", ")}, got ${size}`);
      }
      const aspectArg = one(m, "--aspect");
      const aspect = aspectArg === undefined ? null : aspectArg.toLowerCase() === "auto" ? "Auto" : aspectArg;
      if (aspect !== null && !(ASPECTS as readonly string[]).includes(aspect)) {
        throw new UsageError(`--aspect takes ${ASPECTS.join(", ")}, got ${aspectArg}`);
      }
      const files = attachments(ctx, m);
      const notImage = files.find((f) => !/\.(png|jpe?g|webp|heic|heif|gif)$/i.test(f));
      if (notImage) throw new UsageError(`image --attach takes image files (png, jpg, webp, heic, gif), got ${notImage}`);
      return {
        ...base, model, prompt: prompt(ctx, m), attach: files, chat: c ? chatUrl(c) : null,
        size, aspect, outDir, timeoutS: timeout(m, 600),
      };
    }
    case "speech": {
      const text = prompt(ctx, m, "--text", "--text-file");
      const o = one(m, "--out");
      if (!o) throw new UsageError("--out <file.wav> is required");
      const out = abs(ctx, o);
      if (!/\.wav$/i.test(out)) throw new UsageError(`--out must end in .wav (the page produces 16-bit PCM WAV), got ${out}`);
      if (existsSync(out)) throw new UsageError(`--out exists, pick a new name: ${out}`);
      const voice = one(m, "--voice");
      if (voice !== undefined && !/^[A-Za-z][A-Za-z -]{0,40}$/.test(voice)) {
        throw new UsageError(`--voice must be a voice name such as Fola or Kira, got ${voice}`);
      }
      const model = one(m, "--model") ?? "gemini-3.8-flash-tts";
      if (!/^[a-z][a-z0-9.-]*-tts(-[a-z0-9.-]+)?$/.test(model) && !/-tts-preview$/.test(model)) {
        throw new UsageError(`speech --model must be a TTS model id, got ${model}`);
      }
      return { ...base, text, voice: voice ?? null, model, out, timeoutS: timeout(m, 300) };
    }
    case "build-export": {
      const a = one(m, "--app");
      if (!a) throw new UsageError("--app is required");
      const am = APP_RE.exec(a);
      if (!am) throw new UsageError(`--app must be https://aistudio.google.com/apps/<id>, got ${a}`);
      const outDir = emptyDir(ctx, m);
      if (existsSync(outDir) && readdirSync(outDir).length) {
        throw new UsageError(`--out-dir must be new or empty (the zip is unpacked into it): ${outDir}`);
      }
      return { ...base, app: `https://aistudio.google.com/apps/${am[1]}`, outDir, timeoutS: timeout(m, 180) };
    }
    case "usage":
      return { ...base, days: posInt(one(m, "--days"), "--days", 3660) ?? 7 };
  }
  throw new UsageError(`unknown command: ${cmd}`);
}

function nearestDir(p: string, what: string) {
  let d = dirname(p);
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!statSync(d).isDirectory()) throw new UsageError(`${what}: ${d} is not a directory: ${p}`, "pass a path under a folder");
  try {
    accessSync(d, constants.W_OK);
  } catch {
    throw new UsageError(`${what}: the folder ${d} is not writable: ${p}`, "pass a path under a writable folder");
  }
}

export function checkOutputs(req: Req) {
  if (typeof req.out === "string") {
    const f = req.out;
    if (existsSync(f)) {
      if (statSync(f).isDirectory()) throw new UsageError(`--out is a directory: ${f}`, "pass a file path for the answer");
      try {
        accessSync(f, constants.W_OK);
      } catch {
        throw new UsageError(`--out is not writable: ${f}`, "pass another --out");
      }
    }
    nearestDir(f, "--out");
  }
  if (typeof req.outDir === "string") {
    const d = req.outDir;
    if (existsSync(d)) {
      if (!statSync(d).isDirectory()) throw new UsageError(`--out-dir is not a directory: ${d}`);
      try {
        accessSync(d, constants.W_OK);
      } catch {
        throw new UsageError(`--out-dir is not writable: ${d}`, "pass another --out-dir");
      }
    } else nearestDir(d, "--out-dir");
  }
}
