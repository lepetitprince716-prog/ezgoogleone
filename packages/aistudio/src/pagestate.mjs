// Runs both inside ego-browser's persistent Node runtime and in Bun tests (Node built-ins only).
// ego-browser executes page scripts inside a long-lived runtime where killing the CLI client does not
// terminate the script; heartbeat + cancel file provide cooperative shutdown and stale-page detection.
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Interrupted extends Error {
  constructor(where, cancelFile) {
    super(`interrupted before ${where}: the driver asked the page to stop (${cancelFile})`);
    this.where = where;
  }
}

const rm = (f) => {
  try {
    unlinkSync(f);
  } catch {}
};

export const BEAT_MS = 2000;

export function startPageState(opts) {
  const {
    marker = null,
    cancelFile = null,
    note = "",
    beatMs = BEAT_MS,
    maxLifeMs = 3600000,
    afterCancelMs = 60000,
    now = Date.now,
  } = opts ?? {};
  const t0 = now();
  let cancelledAt = null;
  let beats = 0;
  let timer = null;
  const seeCancel = () => {
    if (cancelledAt === null && cancelFile && existsSync(cancelFile)) cancelledAt = now();
    return cancelledAt !== null;
  };
  const halt = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (marker) rm(marker);
  };
  const beat = () => {
    seeCancel();
    const t = now();
    if (t - t0 > maxLifeMs || (cancelledAt !== null && t - cancelledAt > afterCancelMs)) {
      halt();
      return;
    }
    if (!marker) return;
    try {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, `${note} beat ${new Date(t).toISOString()}\n`);
      beats++;
    } catch {}
  };
  beat();
  timer = setInterval(beat, beatMs);
  timer.unref?.();
  return {
    checkpoint(where) {
      if (seeCancel()) throw new Interrupted(where, cancelFile);
    },
    cancelled: seeCancel,
    beats: () => beats,
    stop() {
      halt();
      if (cancelFile) rm(cancelFile);
    },
  };
}

export function markerTime(marker) {
  try {
    return statSync(marker).mtimeMs;
  } catch {
    return null;
  }
}

export async function markerStale(marker, opts = {}) {
  const { beatMs = BEAT_MS, beats = 2, pollMs = 250, now = Date.now } = opts;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = now();
  const first = markerTime(marker);
  if (first === null) return { stopped: true, why: "no marker", watchedMs: 0 };
  while (now() - t0 < beats * beatMs) {
    await sleep(pollMs);
    const t = markerTime(marker);
    if (t === null) return { stopped: true, why: "marker removed", watchedMs: now() - t0 };
    if (t !== first) return { stopped: false, why: "marker moved", watchedMs: now() - t0 };
  }
  return { stopped: true, why: `marker unchanged for ${beats} beats`, watchedMs: now() - t0 };
}
