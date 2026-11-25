import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { holderPid, lockBlocking, tryLock, unlock, withRegistry } from "../src/lock.ts";

describe("cross-platform locking parity", () => {
  test("POSIX lock enforces mutual exclusion, bounded lockBlocking timeout, and stale-PID eviction", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-posix-"));
    const f = join(dir, "space.lock");

    const h1 = tryLock(f, { isDarwin: false });
    expect(h1).not.toBeNull();
    expect(holderPid(f, { isDarwin: false })).toBe(process.pid);
    expect(tryLock(f, { isDarwin: false })).toBeNull();

    const t0 = Date.now();
    expect(() => lockBlocking(f, 90, { isDarwin: false })).toThrow(/timed out/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(Date.now() - t0).toBeLessThan(2000);

    unlock(h1);
    const h2 = tryLock(f, { isDarwin: false });
    expect(h2).not.toBeNull();
    unlock(h2);

    // Dead PID in lockfile is reclaimed automatically.
    writeFileSync(`${f}.lck`, "999999\n");
    const h3 = tryLock(f, { isDarwin: false });
    expect(h3).not.toBeNull();
    expect(holderPid(f, { isDarwin: false })).toBe(process.pid);
    unlock(h3);

    const reg = join(dir, "spaces.json");
    withRegistry(reg, (s) => s.add("alpha"), { isDarwin: false });
    expect(withRegistry(reg, (s) => [...s], { isDarwin: false })).toEqual(["alpha"]);
  });

  if (process.platform === "darwin") {
    test("Darwin O_EXLOCK enforces mutual exclusion and bounded lockBlocking timeout", () => {
      const dir = mkdtempSync(join(tmpdir(), "lock-darwin-"));
      const f = join(dir, "space.lock");

      const h1 = tryLock(f, { isDarwin: true });
      expect(h1).not.toBeNull();
      expect(holderPid(f, { isDarwin: true })).toBe(process.pid);
      expect(tryLock(f, { isDarwin: true })).toBeNull();

      const t0 = Date.now();
      expect(() => lockBlocking(f, 90, { isDarwin: true })).toThrow(/timed out/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
      expect(Date.now() - t0).toBeLessThan(2000);

      unlock(h1);
      const h2 = lockBlocking(f, 200, { isDarwin: true });
      expect(h2).not.toBeNull();
      unlock(h2);
    });
  }
});
