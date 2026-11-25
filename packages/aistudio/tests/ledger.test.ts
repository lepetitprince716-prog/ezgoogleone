import { describe, expect, test } from "bun:test";
import { ledgerLine, pacificDate, parseLedger, reachedModel, summarise, tokensOf } from "../src/ledger.mjs";

describe("usage ledger", () => {
  test("records lines, parses partial corruption, and summarizes per Pacific day", () => {
    const now = new Date("2026-11-25T18:00:00Z");
    const l1 = ledgerLine(
      { cmd: "run", model: "gemini-4-neon", space: "aistudio" },
      { ok: true, exit: 0, sent: true, model: "gemini-4-neon", finish: "stop", usage: { prompt: 100, output: 50, total: 150 }, elapsedS: 4.2, chat: "https://aistudio.google.com/prompts/chat12345678", chatSaved: true },
      now
    );
    const l2 = ledgerLine(
      { cmd: "run", model: "gemini-4-neon", space: "aistudio" },
      { ok: false, exit: 4, sent: true, uiText: "quota exceeded", httpStatus: 429 },
      new Date("2026-11-25T19:00:00Z")
    );
    const l3 = ledgerLine(
      { cmd: "run", model: "gemini-4-neon", space: "aistudio" },
      { ok: false, exit: 1, sent: false, error: "not sent" },
      new Date("2026-11-25T19:05:00Z")
    );

    const parsed = parseLedger(`${JSON.stringify(l1)}\nnot-json\n${JSON.stringify(l2)}\n${JSON.stringify(l3)}\n`);
    expect(parsed.bad).toBe(1);
    expect(parsed.lines).toHaveLength(3);

    const s = summarise(parsed.lines, { days: 7, now });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({
      day: pacificDate(now),
      model: "gemini-4-neon",
      runs: 2,
      notReached: 1,
      ok: 1,
      tokens: 150,
      firstLimitUtc: "2026-11-25T19:00:00.000Z",
    });
    expect(tokensOf({ prompt: 10, output: 20, thoughts: 5 })).toBe(35);
    expect(reachedModel({ exit: 4, limitText: "over the model's context" })).toBe(false);
    expect(reachedModel({ exit: 4, limitText: "daily limit reached" })).toBe(true);
  });
});
