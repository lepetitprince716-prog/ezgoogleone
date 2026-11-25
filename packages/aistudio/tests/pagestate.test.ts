import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Interrupted, markerStale, startPageState } from "../src/pagestate.mjs";

describe("pagestate heartbeat and cancel", () => {
  test("creates marker, detects cancel at checkpoint, and cleans up on stop", () => {
    const dir = mkdtempSync(join(tmpdir(), "aistudio-ps-"));
    const marker = join(dir, "a.page");
    const cancel = join(dir, "a.cancel");

    const life = startPageState({ marker, cancelFile: cancel, note: "test", beatMs: 50 });
    expect(existsSync(marker)).toBe(true);
    expect(() => life.checkpoint("before")).not.toThrow();

    writeFileSync(cancel, "SIGTERM");
    expect(() => life.checkpoint("Run")).toThrow(Interrupted);

    life.stop();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(cancel)).toBe(false);
  });

  test("markerStale reports stopped when marker stays unchanged and running when it moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aistudio-stale-"));
    const marker = join(dir, "m.page");
    writeFileSync(marker, "beat 1");

    const quiet = await markerStale(marker, { beatMs: 40, beats: 2, pollMs: 15 });
    expect(quiet.stopped).toBe(true);

    const timer = setInterval(() => writeFileSync(marker, `beat ${Date.now()}`), 20);
    try {
      const moving = await markerStale(marker, { beatMs: 60, beats: 2, pollMs: 15 });
      expect(moving.stopped).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
