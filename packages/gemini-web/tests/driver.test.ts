import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");
const BUN = process.execPath;

const FAKE_EGO = `#!${BUN}
const src = await Bun.stdin.text();
const first = src.slice(0, src.indexOf("\\n"));
const REQ = JSON.parse(first.replace(/^const REQ = /, "").replace(/;$/, ""));

let res;
if (REQ.cmd === "check") {
  res = { ok: true, exit: 0, cmd: "check", url: "https://gemini.google.com/app", canaries: { modePicker: true, promptBox: true, toolsButton: true } };
} else if (REQ.cmd === "chat") {
  res = { ok: true, exit: 0, cmd: "chat", url: "https://gemini.google.com/app/chat123", model: REQ.modelLabel, thinking: REQ.thinkLabel, chars: 12, _text: "# Reply\\n\\nOk\\n" };
} else if (REQ.cmd === "deep-research:start") {
  res = { ok: true, exit: 0, cmd: "deep-research:start", status: "running", spaceId: 77, url: "https://gemini.google.com/app/dr99", clickedStart: true };
} else if (REQ.cmd === "deep-research:check") {
  res = { ok: true, exit: 0, cmd: "deep-research:check", status: "done", spaceId: REQ.spaceId, url: "https://gemini.google.com/app/dr99", chars: 20, _text: "# Deep Report\\n\\nDone\\n" };
} else if (REQ.cmd === "close") {
  res = { ok: true, exit: 0, cmd: "close", closed: REQ.spaces, skipped: [] };
} else {
  res = { ok: true, exit: 0, cmd: REQ.cmd };
}
console.error(JSON.stringify(res));
`;

describe("gemini-web CLI end-to-end", () => {
  test("check, chat, deep-research start/check, and close work end-to-end", () => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-web-e2e-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ego = join(bin, "ego-browser");
    writeFileSync(ego, FAKE_EGO);
    chmodSync(ego, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GEMINI_WEB_STATE_DIR: join(dir, "state") };
    const run = (args: string[]) => {
      const p = Bun.spawnSync([BUN, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
      return { exit: p.exitCode, json: JSON.parse(p.stdout.toString().trim()) };
    };

    expect(run(["check"]).json.ok).toBe(true);

    const chatOut = join(dir, "chat.md");
    const chat = run(["chat", "--prompt", "hello", "--model", "neon", "--out", chatOut]);
    expect(chat.exit).toBe(0);
    expect(readFileSync(chatOut, "utf8")).toBe("# Reply\n\nOk\n");

    const started = run(["deep-research", "start", "--prompt", "survey"]);
    expect(started.json.spaceId).toBe(77);

    const drOut = join(dir, "report.md");
    const done = run(["deep-research", "check", "--space-id", "77", "--out", drOut]);
    expect(done.exit).toBe(0);
    expect(readFileSync(drOut, "utf8")).toBe("# Deep Report\n\nDone\n");

    const closed = run(["close"]);
    expect(closed.json.closed).toEqual(["gemini-web"]);
  });
});
