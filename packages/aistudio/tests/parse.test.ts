import { describe, expect, test } from "bun:test";
import {
  chooseText,
  endChatRead,
  exitForFinish,
  exitForUiError,
  imageDims,
  modelKind,
  normaliseFinish,
  parseBodies,
  parseGenerate,
  parseModelLines,
  sameSchema,
  settleChat,
  sumUsage,
  wavInfo,
} from "../src/parse.mjs";

function makeChunk({ text = "", thought = "", finish = null, usage = null, code = null, result = null } = {}) {
  const parts = [];
  if (thought) parts.push([null, thought, null, null, null, null, null, null, null, null, null, null, 1]);
  if (text) parts.push([null, text]);
  if (code) parts.push([null, null, null, null, null, null, null, code]);
  if (result) parts.push([null, null, null, null, null, null, null, null, result]);
  return [[[[parts], finish]], null, usage, null, null, null, null, "resp-1"];
}

describe("parse helpers", () => {
  test("normaliseFinish and exitForFinish map numeric and string enums", () => {
    expect(normaliseFinish(1)).toBe("stop");
    expect(normaliseFinish(2)).toBe("max_tokens");
    expect(normaliseFinish(4)).toBe("recitation");
    expect(normaliseFinish("SAFETY")).toBe("safety");
    expect(normaliseFinish("2")).toBe("max_tokens");
    expect(normaliseFinish(null)).toBe("unknown");
    expect(exitForFinish("stop")).toBe(0);
    expect(exitForFinish("safety")).toBe(5);
    expect(exitForFinish("recitation")).toBe(5);
    expect(exitForFinish("max_tokens")).toBe(6);
  });

  test("parseGenerate and parseBodies join chunks and sum usage", () => {
    const b1 = JSON.stringify([[
      makeChunk({ thought: "plan ", text: "Hello " }),
      makeChunk({ text: "world", code: ["PYTHON", "print(1)"], result: ["OUTCOME_OK", "1\n"], finish: 2, usage: [10, 20, 30, 0, null, null, null, 2, null, 5] }),
    ]]);
    const b2 = JSON.stringify([[
      makeChunk({ text: "!", finish: 1, usage: [5, 10, 15, 0, null, null, null, 0, null, 3] }),
    ]]);

    const one = parseGenerate(b1);
    expect(one.text).toBe("Hello world");
    expect(one.thoughts).toBe("plan ");
    expect(one.code).toHaveLength(2);

    const multi = parseBodies([b1, b2]);
    expect(multi.available).toBe(true);
    expect(multi.text).toBe("Hello world!");
    expect(multi.finish).toBe("stop");
    expect(multi.usage).toEqual({ prompt: 15, output: 30, total: 45, cached: 0, tool_prompt: 2, thoughts: 8 });
    expect(sumUsage([null, undefined])).toBeNull();
  });

  test("chooseText resolves match, prefix truncation, and conflict", () => {
    expect(chooseText({ copy: "Hello\nworld", edit: "Hello\nworld", network: "Hello  world" })).toMatchObject({
      method: "copy",
      crosscheck: { against: "network", match: true },
    });
    expect(chooseText({ copy: "Hello", edit: null, network: "Hello world!" })).toMatchObject({
      method: "network",
      text: "Hello world!",
    });
    const conflict = chooseText({ copy: "alpha beta", edit: null, network: "gamma delta" });
    expect(conflict.pageText).toBe("alpha beta");
    expect(conflict.crosscheck.conflict).toBe(true);
  });

  test("parseModelLines, modelKind, sameSchema, exitForUiError", () => {
    expect(parseModelLines(["spark", "New", "Gemini 4 Neon", "gemini-4-neon", "Fast reasoning"])).toEqual({
      id: "gemini-4-neon",
      name: "Gemini 4 Neon",
      kind: "chat",
    });
    expect(modelKind("gemini-3.8-flash-tts")).toBe("speech");
    expect(modelKind("gemini-nano-banana-2.1")).toBe("image");
    expect(modelKind("lyria-3.5")).toBe("music");
    expect(modelKind("gemini-omni-1.2-flash")).toBe("video");

    expect(
      sameSchema(
        { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } },
        { properties: { a: { type: "number" }, b: { type: "string" } }, propertyOrdering: ["a", "b"], type: "object" }
      )
    ).toBe(true);

    expect(exitForUiError("You have reached your daily quota limit")).toBe(4);
    expect(exitForUiError("Unexpected internal error")).toBe(1);
  });

  test("settleChat and endChatRead recover late-saved URLs", async () => {
    const s = settleChat({ ok: true, exit: 0, chat: null }, "https://aistudio.google.com/prompts/chat12345678?foo=1", ["the chat URL did not turn into /prompts/<id> within 60 s"], { waited: true });
    expect(s.result.chat).toBe("https://aistudio.google.com/prompts/chat12345678");
    expect(s.result.chatSaved).toBe(true);

    const miss = settleChat({ ok: true, exit: 0, chat: null }, "https://aistudio.google.com/prompts/new_chat");
    expect(miss.result.chatSaved).toBe(false);
    expect(miss.result.next).toContain("History");

    const end = await endChatRead({
      cmd: "run",
      page: { url: async () => "https://aistudio.google.com/prompts/chat99999999" },
      result: { ok: true, exit: 0, chat: null },
      sent: true,
      waited: false,
    });
    expect(end?.result.chatSaved).toBe(true);
  });
});

describe("synthetic media headers", () => {
  test("parses synthetic PNG, JPEG (with EXIF), WebP (VP8X/VP8/VP8L), and WAV with wrong byteRate", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 1280, false);
    new DataView(png.buffer).setUint32(20, 720, false);
    expect(imageDims(png)).toEqual({ type: "png", width: 1280, height: 720 });

    const jpg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x11, 0x00,
    ]);
    expect(imageDims(jpg)).toEqual({ type: "jpeg", width: 800, height: 600 });

    const vp8x = new Uint8Array(32);
    vp8x.set(Buffer.from("RIFF"), 0);
    vp8x.set(Buffer.from("WEBP"), 8);
    vp8x.set(Buffer.from("VP8X"), 12);
    vp8x[24] = 0xff; vp8x[25] = 0x03; vp8x[26] = 0x00;
    vp8x[27] = 0xdf; vp8x[28] = 0x01; vp8x[29] = 0x00;
    expect(imageDims(vp8x)).toEqual({ type: "webp", width: 1024, height: 480 });

    const dataBytes = 48000;
    const wav = new Uint8Array(44 + dataBytes);
    const dv = new DataView(wav.buffer);
    wav.set(Buffer.from("RIFF"), 0);
    dv.setUint32(4, 36 + dataBytes, true);
    wav.set(Buffer.from("WAVE"), 8);
    wav.set(Buffer.from("fmt "), 12);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 24000, true);
    dv.setUint32(28, 96000, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    wav.set(Buffer.from("data"), 36);
    dv.setUint32(40, dataBytes, true);

    expect(wavInfo(wav)).toEqual({
      channels: 1,
      sampleRate: 24000,
      bits: 16,
      seconds: 1,
      headerByteRate: 96000,
    });
  });
});
