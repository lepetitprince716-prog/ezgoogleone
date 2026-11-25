import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, lockedDownload, LockTimeout } from "../src/download.mjs";

describe("download lock and CDP download", () => {
  test("serializes lock holders and times out when held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aistudio-dl-"));
    const lockFile = join(dir, "downloads.lock");
    const first = await acquireLock(lockFile, { note: "first", waitMs: 500, pollMs: 20 });
    try {
      await expect(acquireLock(lockFile, { note: "second", waitMs: 80, pollMs: 20 })).rejects.toThrow(LockTimeout);
    } finally {
      first.release();
    }
    const second = await acquireLock(lockFile, { note: "second", waitMs: 500, pollMs: 20 });
    second.release();
  });

  test("waits for GUID download to settle, renames it, and resets behavior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aistudio-dl2-"));
    const outDir = join(dir, "out");
    const lockFile = join(dir, "downloads.lock");
    const cdpCalls: unknown[] = [];
    const page = {
      cdp: async (method: string, params: unknown) => {
        cdpCalls.push({ method, params });
      },
    };
    const guid = "12345678-1234-1234-1234-1234567890ab";
    const target = join(outDir, "final.png");

    const res = await lockedDownload(
      page,
      outDir,
      async () => {
        writeFileSync(join(outDir, `${guid}.crdownload`), "partial");
        setTimeout(() => {
          writeFileSync(join(outDir, guid), "PNGDATA");
          try {
            require("node:fs").unlinkSync(join(outDir, `${guid}.crdownload`));
          } catch {}
        }, 30);
      },
      target,
      { lockFile, timeoutMs: 2000, settleMs: 60, pollMs: 20 }
    );

    expect(res?.path).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("PNGDATA");
    expect(cdpCalls).toHaveLength(2);
    expect((cdpCalls[1] as { params: { behavior: string } }).params.behavior).toBe("default");
  });
});
