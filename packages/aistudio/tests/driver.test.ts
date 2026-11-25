import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");
const BUN = process.execPath;

const FAKE_EGO = `#!${BUN}
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const src = await Bun.stdin.text();
const first = src.slice(0, src.indexOf("\\n"));
const log = process.env.FAKE_EGO_LOG;
const flagFor = (space) => join(dirname(log), "finished-" + space);

if (first.startsWith("const STOP = ")) {
  const STOP = JSON.parse(first.replace(/^const STOP = /, "").replace(/;$/, ""));
  if (log) appendFileSync(log, JSON.stringify({ ev: "hardstop", space: STOP.space }) + "\\n");
  writeFileSync(flagFor(STOP.space), "1");
  console.log(JSON.stringify({ aistudioHardStop: { finished: true, id: 1 } }));
  process.exit(0);
}

const REQ = JSON.parse(first.replace(/^const REQ = /, "").replace(/;$/, ""));
if (log) appendFileSync(log, JSON.stringify({ ev: "start", cmd: REQ.cmd, space: REQ.space }) + "\\n");
const sleepMs = Number(process.env.FAKE_EGO_SLEEP_MS ?? 0);
if (sleepMs > 0) await Bun.sleep(sleepMs);

if (process.env.FAKE_EGO_PAGE === "obey") {
  if (REQ.pageMarker) writeFileSync(REQ.pageMarker, "beat");
  console.error(JSON.stringify({ aistudioEvent: "sent" }));
  while (!(REQ.cancelFile && existsSync(REQ.cancelFile))) await Bun.sleep(50);
  if (REQ.pageMarker) rmSync(REQ.pageMarker, { force: true });
  rmSync(REQ.cancelFile, { force: true });
  console.error(JSON.stringify({ ok: false, exit: 1, cmd: REQ.cmd, interrupted: true, sent: true, error: "interrupted before a wait" }));
  process.exit(0);
}

let result;
if (REQ.cmd === "models") {
  result = { ok: true, exit: 0, cmd: "models", count: 1, models: [{ id: "gemini-4-neon", name: "Gemini 4 Neon", kind: "chat" }] };
} else if (REQ.cmd === "close") {
  result = { ok: true, exit: 0, cmd: "close", closed: REQ.spaces, skipped: [] };
} else if (REQ.cmd === "run") {
  result = {
    ok: true,
    exit: 0,
    cmd: "run",
    chat: "https://aistudio.google.com/prompts/fakechat0001",
    chatSaved: true,
    model: REQ.model,
    finish: "stop",
    usage: { total: 42 },
    sent: true,
    method: "copy",
    crosscheck: { against: "network", match: true },
    _text: "answer for " + REQ.prompt,
  };
} else if (REQ.cmd === "build-export") {
  result = { ok: true, exit: 0, cmd: "build-export", app: REQ.app, outDir: REQ.outDir, zip: process.env.FAKE_EGO_ZIP, zipBytes: 128, tree: [] };
} else {
  result = { ok: true, exit: 0, cmd: REQ.cmd };
}
console.error(JSON.stringify(result));
`;

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "aistudio-e2e-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const ego = join(bin, "ego-browser");
  writeFileSync(ego, FAKE_EGO);
  chmodSync(ego, 0o755);
  const stateDir = join(dir, "state");
  const modelsCache = join(dir, "cache", "models.json");
  const log = join(dir, "ego.log");
  return {
    dir,
    stateDir,
    modelsCache,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AISTUDIO_STATE_DIR: stateDir,
      AISTUDIO_MODELS_CACHE: modelsCache,
      FAKE_EGO_LOG: log,
    },
  };
}

function runCli(args: string[], env: Record<string, string | undefined>) {
  const p = Bun.spawnSync([BUN, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const raw = p.stdout.toString().trim();
  return { exit: p.exitCode, json: JSON.parse(raw), stderr: p.stderr.toString() };
}

describe("aistudio CLI end-to-end", () => {
  test("run writes answer, records XDG usage ledger, models uses cache, and close clears spaces", () => {
    const sb = makeSandbox();
    const out = join(sb.dir, "ans.md");
    const r = runCli(["run", "--model", "gemini-4-neon", "--prompt", "ping", "--out", out], sb.env);
    expect(r.exit).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("answer for ping");
    expect(existsSync(join(sb.stateDir, "usage.jsonl"))).toBe(true);

    const u = runCli(["usage", "--days", "1"], sb.env);
    expect(u.exit).toBe(0);
    expect(u.json.rows[0].runs).toBe(1);
    expect(u.json.rows[0].tokens).toBe(42);

    const m1 = runCli(["models"], sb.env);
    expect(m1.json.source).toBe("picker");
    expect(existsSync(sb.modelsCache)).toBe(true);

    const m2 = runCli(["models"], sb.env);
    expect(m2.json.source).toBe("cache");

    const c = runCli(["close"], sb.env);
    expect(c.exit).toBe(0);
    expect(c.json.closed).toEqual(["aistudio"]);
  });

  test("rejects concurrent driver on the same space with exit 1", async () => {
    const sb = makeSandbox();
    const out1 = join(sb.dir, "a.md");
    const out2 = join(sb.dir, "b.md");
    const p1 = Bun.spawn([BUN, CLI, "run", "--model", "gemini-4-neon", "--prompt", "one", "--out", out1], {
      env: { ...sb.env, FAKE_EGO_SLEEP_MS: "700" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(150);
    const r2 = runCli(["run", "--model", "gemini-4-neon", "--prompt", "two", "--out", out2], sb.env);
    const [o1, code1] = await Promise.all([new Response(p1.stdout).text(), p1.exited]);
    expect(code1).toBe(0);
    expect(JSON.parse(o1).ok).toBe(true);
    expect(r2.exit).toBe(1);
    expect(r2.json.error).toContain("is busy");
  });

  test("stops cleanly on SIGTERM via cancel file", async () => {
    const sb = makeSandbox();
    const out = join(sb.dir, "sig.md");
    const p = Bun.spawn([BUN, CLI, "run", "--model", "gemini-4-neon", "--prompt", "stopme", "--out", out], {
      env: { ...sb.env, FAKE_EGO_PAGE: "obey", AISTUDIO_HARD_STOP_AFTER_MS: "2000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(250);
    p.kill("SIGTERM");
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(code).toBe(1);
    const res = JSON.parse(stdout.trim());
    expect(res.interrupted).toBe("SIGTERM");
    expect(res.pageStopped).toBe(true);
  });

  test("build-export refuses symlink entries inside downloaded zip", () => {
    const sb = makeSandbox();
    const outDir = join(sb.dir, "export");
    const zipPath = join(sb.dir, "symlink.zip");
    const mk = Bun.spawnSync([
      "python3",
      "-c",
      "import sys, zipfile; zf = zipfile.ZipFile(sys.argv[1], 'w'); zi = zipfile.ZipInfo('evil_link'); zi.create_system = 3; zi.external_attr = 0o120777 << 16; zf.writestr(zi, '/tmp'); zf.close()",
      zipPath,
    ]);
    expect(mk.exitCode).toBe(0);

    const r = runCli(["build-export", "--app", "https://aistudio.google.com/apps/abc12345", "--out-dir", outDir], {
      ...sb.env,
      FAKE_EGO_ZIP: zipPath,
    });
    expect(r.exit).toBe(1);
    expect(r.json.error).toContain("symlink entry");
  });
});
