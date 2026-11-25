import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkOutputs, parseArgs, testOnlyNumber, thinkingLabel, UsageError } from "../src/args.ts";

const baseCtx = () => {
  const dir = mkdtempSync(join(tmpdir(), "aistudio-args-"));
  return { dir, ctx: { cwd: dir, home: dir, now: new Date("2026-11-25T10:00:00.123Z"), pid: 4242, rand: "abc123" } };
};

describe("parseArgs", () => {
  test("parses run with full options and normalizes CRLF", () => {
    const { dir, ctx } = baseCtx();
    const pFile = join(dir, "prompt.txt");
    const sFile = join(dir, "sys.txt");
    const aFile = join(dir, "doc.pdf");
    const schemaFile = join(dir, "schema.json");
    writeFileSync(pFile, "hello\r\nworld\r");
    writeFileSync(sFile, "be brief\r\n");
    writeFileSync(aFile, "pdf");
    writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }));

    const req = parseArgs(
      [
        "run",
        "--model", "gemini-4-neon",
        "--prompt-file", "prompt.txt",
        "--system-file", "sys.txt",
        "--thinking", "extra-high",
        "--max-out", "32768",
        "--attach", "doc.pdf",
        "--youtube", "https://youtu.be/dQw4w9WgXcQ",
        "--tools", "search,code",
        "--schema", "schema.json",
        "--space", "lane-1",
      ],
      ctx
    );

    expect(req.cmd).toBe("run");
    expect(req.model).toBe("gemini-4-neon");
    expect(req.prompt).toBe("hello\nworld\n");
    expect(req.system).toBe("be brief\n");
    expect(req.thinking).toBe("Extra High");
    expect(req.maxOut).toBe(32768);
    expect(req.attach).toEqual([aFile]);
    expect(req.youtube).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(req.tools).toEqual(["search", "code"]);
    expect(req.space).toBe("lane-1");
    expect(String(req.out)).toContain(".cache/ezgoogleone/aistudio/runs/");
  });

  test("rejects reserved spaces, duplicate filenames, and bad chat ids", () => {
    const { dir, ctx } = baseCtx();
    expect(() => parseArgs(["check", "--space", "downloads"], ctx)).toThrow(UsageError);
    expect(() => parseArgs(["check", "--space", "aistudio-reset-1"], ctx)).toThrow(UsageError);
    expect(() => parseArgs(["send", "--chat", "new_chat", "--prompt", "hi"], ctx)).toThrow(UsageError);

    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "dup.txt"), "1");
    writeFileSync(join(dir, "b", "dup.txt"), "2");
    expect(() =>
      parseArgs(["run", "--model", "gemini-4-hydrogen", "--prompt", "x", "--attach", "a/dup.txt", "b/dup.txt"], ctx)
    ).toThrow(/two files named dup.txt/);
  });

  test("parses send, get, image, speech, build-export, close, usage", () => {
    const { dir, ctx } = baseCtx();
    const img = join(dir, "ref.png");
    writeFileSync(img, "png");
    expect(parseArgs(["send", "--chat", "abcd12345678", "--prompt", "next"], ctx).chat).toBe(
      "https://aistudio.google.com/prompts/abcd12345678"
    );
    expect(parseArgs(["get", "--chat", "abcd12345678", "--turn", "2"], ctx).turn).toBe(2);
    expect(
      parseArgs(["image", "--model", "gemini-nano-banana-2.1", "--prompt", "cat", "--attach", "ref.png", "--aspect", "auto", "--size", "2K", "--out-dir", "imgs"], ctx)
    ).toMatchObject({ aspect: "Auto", size: "2K" });
    expect(parseArgs(["speech", "--text", "hi", "--voice", "Kira", "--out", "out.wav"], ctx)).toMatchObject({
      voice: "Kira",
      model: "gemini-3.8-flash-tts",
    });
    expect(parseArgs(["build-export", "--app", "https://aistudio.google.com/apps/abc12345", "--out-dir", "export"], ctx).app).toBe(
      "https://aistudio.google.com/apps/abc12345"
    );
    expect(parseArgs(["close"], ctx).only).toBeUndefined();
    expect(parseArgs(["close", "--space", "lane-1"], ctx).only).toBe(true);
    expect(parseArgs(["usage", "--days", "14"], ctx).days).toBe(14);
  });

  test("rejects non-empty build-export dir, existing speech wav, directory --out", () => {
    const { dir, ctx } = baseCtx();
    const full = join(dir, "full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "1");
    expect(() => parseArgs(["build-export", "--app", "https://aistudio.google.com/apps/abc12345", "--out-dir", "full"], ctx)).toThrow(UsageError);

    const wav = join(dir, "exists.wav");
    writeFileSync(wav, "RIFF");
    expect(() => parseArgs(["speech", "--text", "hi", "--out", "exists.wav"], ctx)).toThrow(UsageError);

    const req = parseArgs(["run", "--model", "gemini-4-hydrogen", "--prompt", "hi", "--out", "full"], ctx);
    expect(() => checkOutputs(req)).toThrow(/is a directory/);
  });

  test("validates thinkingLabel and testOnlyNumber", () => {
    expect(thinkingLabel("extra-high")).toBe("Extra High");
    expect(() => thinkingLabel("HIGH")).toThrow(UsageError);
    expect(testOnlyNumber("X", undefined)).toEqual({ value: null });
    expect(testOnlyNumber("X", "12.5")).toEqual({ value: 12.5 });
    expect(testOnlyNumber("X", "abc").value).toBeNull();
    expect(testOnlyNumber("X", "0").value).toBeNull();
  });
});
