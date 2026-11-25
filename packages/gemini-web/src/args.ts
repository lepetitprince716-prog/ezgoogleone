import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export class UsageError extends Error {
  next: string;
  constructor(message: string, next = "run `gemini-web help` for usage") {
    super(message);
    this.next = next;
  }
}

export const DEFAULT_SPACE = "gemini-web";
const SPACE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const GEMINI_URL_RE = /^https:\/\/gemini\.google\.com\/(?:app|u\/\d+\/app)(?:\/[A-Za-z0-9_-]+)?(?:[?#].*)?$/;

export const MODEL_ALIASES: Record<string, string> = {
  neon: "4 Neon",
  "4-neon": "4 Neon",
  carbon: "4 Carbon",
  "4-carbon": "4 Carbon",
  argon: "4 Argon",
  "4-argon": "4 Argon",
  hydrogen: "4 Hydrogen",
  "4-hydrogen": "4 Hydrogen",
  pro: "Pro",
  fast: "Fast",
  thinking: "Thinking",
};

export const THINKING_ALIASES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export interface Ctx {
  cwd: string;
  home: string;
  now: Date;
  pid?: number;
  rand?: string;
}

export type WebReq = Record<string, unknown> & { cmd: string; space: string };

export const USAGE = `usage: gemini-web <command> [options]   (drives gemini.google.com/app via ego-browser)
  check [--space <name>]
  verify-lock [--model <alias|label>] [--thinking low|medium|high] [--deep-research] [--space <name>]
  chat (--prompt <text> | --prompt-file <f>) [--model <alias|label>] [--thinking low|medium|high]
       [--url <gemini chat url>] [--out <f.md>] [--timeout <s>] [--keep] [--space <name>]
  deep-research start (--prompt <text> | --prompt-file <f>) [--model <alias|label>] [--thinking low|medium|high] [--space <name>]
  deep-research check (--space-id <id> | --url <gemini chat url>) --out <f.md> [--reload] [--keep] [--space <name>]
  close [--space <name>]`;

export function resolveModelLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) throw new UsageError("--model cannot be empty");
  return MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

export function resolveThinkingLabel(raw: string | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const mapped = THINKING_ALIASES[key];
  if (!mapped) throw new UsageError(`--thinking must be low, medium, or high, got ${raw}`);
  return mapped;
}

type Kind = "one" | "bool";
const COMMON: Record<string, Kind> = { "--space": "one" };
const SPECS: Record<string, Record<string, Kind>> = {
  check: {},
  "verify-lock": { "--model": "one", "--thinking": "one", "--deep-research": "bool" },
  chat: {
    "--prompt": "one", "--prompt-file": "one", "--model": "one", "--thinking": "one",
    "--url": "one", "--out": "one", "--timeout": "one", "--keep": "bool",
  },
  "deep-research:start": { "--prompt": "one", "--prompt-file": "one", "--model": "one", "--thinking": "one" },
  "deep-research:check": { "--space-id": "one", "--url": "one", "--out": "one", "--reload": "bool", "--keep": "bool" },
  close: {},
};

function parseFlags(cmd: string, argv: string[]): Map<string, string | true> {
  const allowed = { ...COMMON, ...SPECS[cmd] };
  const got = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument for ${cmd}: ${a}`);
    const kind = allowed[a];
    if (!kind) throw new UsageError(`${cmd} does not take ${a}`);
    if (got.has(a)) throw new UsageError(`${a} given twice`);
    if (kind === "bool") {
      got.set(a, true);
      continue;
    }
    const val = argv[++i];
    if (val === undefined || (val.startsWith("--") && val.length > 2)) throw new UsageError(`${a} needs a value`);
    got.set(a, val);
  }
  return got;
}

const str = (m: Map<string, string | true>, k: string): string | undefined => {
  const v = m.get(k);
  return typeof v === "string" ? v : undefined;
};

const abs = (ctx: Ctx, p: string) => (isAbsolute(p) ? p : resolve(ctx.cwd, p));

function readPrompt(ctx: Ctx, m: Map<string, string | true>): string {
  const inline = str(m, "--prompt");
  const file = str(m, "--prompt-file");
  if ((inline === undefined) === (file === undefined)) {
    throw new UsageError("give exactly one of --prompt or --prompt-file");
  }
  let text: string;
  if (file !== undefined) {
    const f = abs(ctx, file);
    if (!existsSync(f) || !statSync(f).isFile()) throw new UsageError(`--prompt-file not found: ${f}`);
    text = readFileSync(f, "utf8");
  } else {
    text = inline!;
  }
  text = text.replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new UsageError("prompt is empty");
  return text;
}

function posInt(raw: string | undefined, what: string, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > max) throw new UsageError(`${what} must be 1..${max}, got ${raw}`);
  return Number(raw);
}

function geminiUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!GEMINI_URL_RE.test(raw)) throw new UsageError(`--url must be a https://gemini.google.com/app URL, got ${raw}`);
  return raw;
}

function defaultOut(ctx: Ctx, prefix: string): string {
  const d = ctx.now;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const pid = ctx.pid ?? process.pid;
  const rand = ctx.rand ?? randomBytes(3).toString("hex");
  return join(ctx.home, ".cache", "ezgoogleone", "gemini-web", `${stamp}-${prefix}-${pid}-${rand}.md`);
}

export function parseArgs(argv: string[], ctx: Ctx): WebReq {
  let [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") throw new UsageError(USAGE, "pick a command");
  if (cmd === "deep-research") {
    const sub = rest[0];
    if (sub !== "start" && sub !== "check") {
      throw new UsageError("deep-research requires subcommand `start` or `check`");
    }
    cmd = `deep-research:${sub}`;
    rest = rest.slice(1);
  }
  if (!SPECS[cmd]) throw new UsageError(`unknown command: ${cmd}`);
  const m = parseFlags(cmd, rest);
  const space = str(m, "--space") ?? DEFAULT_SPACE;
  if (!SPACE_RE.test(space)) throw new UsageError(`--space must be lowercase letters, digits, and dashes, got ${space}`);

  if (cmd === "check") return { cmd, space };
  if (cmd === "close") return m.has("--space") ? { cmd, space, only: true } : { cmd, space };

  if (cmd === "verify-lock") {
    return {
      cmd,
      space,
      modelLabel: resolveModelLabel(str(m, "--model") ?? "neon"),
      thinkLabel: resolveThinkingLabel(str(m, "--thinking") ?? "high"),
      deepResearch: m.get("--deep-research") === true,
    };
  }

  if (cmd === "chat") {
    const outArg = str(m, "--out");
    return {
      cmd,
      space,
      prompt: readPrompt(ctx, m),
      modelLabel: resolveModelLabel(str(m, "--model")),
      thinkLabel: resolveThinkingLabel(str(m, "--thinking")),
      url: geminiUrl(str(m, "--url")),
      out: outArg ? abs(ctx, outArg) : defaultOut(ctx, "chat"),
      timeoutS: posInt(str(m, "--timeout"), "--timeout", 3600) ?? 300,
      keep: m.get("--keep") === true,
    };
  }

  if (cmd === "deep-research:start") {
    return {
      cmd,
      space,
      prompt: readPrompt(ctx, m),
      modelLabel: resolveModelLabel(str(m, "--model") ?? "neon"),
      thinkLabel: resolveThinkingLabel(str(m, "--thinking") ?? "high"),
    };
  }

  const spaceId = posInt(str(m, "--space-id"), "--space-id", 1_000_000) ?? null;
  const url = geminiUrl(str(m, "--url"));
  if (spaceId === null && url === null) throw new UsageError("deep-research check requires --space-id or --url");
  const outArg = str(m, "--out");
  if (!outArg) throw new UsageError("deep-research check requires --out <file.md>");
  return {
    cmd,
    space,
    spaceId,
    url,
    out: abs(ctx, outArg),
    reload: m.get("--reload") === true,
    keep: m.get("--keep") === true,
  };
}
