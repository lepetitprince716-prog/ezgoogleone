export const LEDGER_CMDS = ["run", "send", "image", "speech"];
const PACIFIC = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function pacificDate(d) {
  return PACIFIC.format(d instanceof Date ? d : new Date(d));
}

export function tokensOf(u) {
  if (!u || typeof u !== "object") return 0;
  if (typeof u.total === "number") return u.total;
  return ["prompt", "output", "thoughts", "tool_prompt"].reduce(
    (a, k) => a + (typeof u[k] === "number" ? u[k] : 0),
    0
  );
}

export function ledgerLine(req, o, now) {
  const line = {
    t: now.toISOString(),
    pt: pacificDate(now),
    cmd: req.cmd,
    model: (typeof o.model === "string" && o.model) || req.model || null,
    space: req.space,
    exit: o.exit,
    finish: o.finish ?? null,
    usage: o.usage ?? null,
    elapsedS: o.elapsedS ?? null,
    chat: o.chat ?? null,
  };
  if (typeof o.sent === "boolean") line.reached = o.sent;
  if (typeof o.chatSaved === "boolean") line.chatSaved = o.chatSaved;
  if (o.httpStatus != null) line.httpStatus = o.httpStatus;
  if (o.uiText) line.uiText = String(o.uiText).slice(0, 1000);
  if (o.exit === 4) line.limitText = String(o.uiText || o.error || "").slice(0, 1000);
  return line;
}

export function parseLedger(text) {
  const lines = [];
  let bad = 0;
  for (const l of String(text).split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o.t === "string" && typeof o.cmd === "string") lines.push(o);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { lines, bad };
}

export function reachedModel(l) {
  if (typeof l.reached === "boolean") return l.reached;
  if (l.usage && typeof l.usage === "object") return true;
  if (l.exit === 0 || l.exit === 5 || l.exit === 6) return true;
  if (l.exit === 4) return !/^over the model's context/.test(String(l.limitText ?? ""));
  return false;
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function summarise(lines, { days = 7, now = new Date() } = {}) {
  const today = pacificDate(now);
  const from = addDays(today, -(days - 1));
  const rows = new Map();
  for (const l of lines) {
    const pt = l.pt || pacificDate(l.t);
    if (pt < from || pt > today) continue;
    const model = l.model || "?";
    const k = `${pt}\t${model}`;
    if (!rows.has(k)) {
      rows.set(k, {
        day: pt,
        model,
        runs: 0,
        notReached: 0,
        ok: 0,
        tokens: 0,
        byCmd: {},
        limitHits: [],
        firstLimitUtc: null,
      });
    }
    const r = rows.get(k);
    if (reachedModel(l)) r.runs++;
    else r.notReached++;
    if (l.exit === 0) r.ok++;
    r.tokens += tokensOf(l.usage);
    r.byCmd[l.cmd] = (r.byCmd[l.cmd] || 0) + 1;
    if (l.exit === 4) {
      r.limitHits.push({ t: l.t, cmd: l.cmd, text: l.limitText || l.uiText || null, httpStatus: l.httpStatus ?? null });
      if (!r.firstLimitUtc || l.t < r.firstLimitUtc) r.firstLimitUtc = l.t;
    }
  }
  const out = [...rows.values()].sort((a, b) =>
    a.day === b.day ? a.model.localeCompare(b.model) : a.day.localeCompare(b.day)
  );
  for (const r of out) r.limitHits.sort((a, b) => a.t.localeCompare(b.t));
  const firstLimitByModel = {};
  for (const r of out) {
    if (r.firstLimitUtc) {
      (firstLimitByModel[r.model] ||= []).push({
        pacificDay: r.day,
        utc: r.firstLimitUtc,
        utcDate: r.firstLimitUtc.slice(0, 10),
      });
    }
  }
  return { from, to: today, timeZone: "America/Los_Angeles (reset boundary unconfirmed)", rows: out, firstLimitByModel };
}
