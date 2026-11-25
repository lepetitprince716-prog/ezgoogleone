const FINISH_BY_NUMBER = {
  0: "unknown",
  1: "stop",
  2: "max_tokens",
  3: "safety",
  4: "recitation",
  5: "other",
  6: "other",
  7: "safety",
  8: "safety",
  9: "safety",
  10: "other",
  11: "safety",
};
const FINISH_BY_NAME = {
  FINISH_REASON_UNSPECIFIED: "unknown",
  STOP: "stop",
  MAX_TOKENS: "max_tokens",
  SAFETY: "safety",
  RECITATION: "recitation",
  OTHER: "other",
  LANGUAGE: "other",
  BLOCKLIST: "safety",
  PROHIBITED_CONTENT: "safety",
  SPII: "safety",
  MALFORMED_FUNCTION_CALL: "other",
  IMAGE_SAFETY: "safety",
};

export const FINISH_NAMES = ["stop", "max_tokens", "safety", "recitation", "other", "unknown"];

export function normaliseFinish(raw) {
  if (raw === null || raw === undefined) return "unknown";
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return "unknown";
    return FINISH_BY_NUMBER[raw] ?? "other";
  }
  if (typeof raw === "string") {
    const k = raw.trim().toUpperCase();
    if (/^\d+$/.test(k)) return normaliseFinish(Number(k));
    return FINISH_BY_NAME[k] ?? "other";
  }
  return "unknown";
}

export function exitForFinish(finish) {
  if (finish === "safety" || finish === "recitation") return 5;
  if (finish === "max_tokens") return 6;
  return 0;
}

export function usageOf(u) {
  if (!Array.isArray(u)) return null;
  const n = (v) => (typeof v === "number" ? v : null);
  return { prompt: n(u[0]), output: n(u[1]), total: n(u[2]), cached: n(u[3]), tool_prompt: n(u[7]), thoughts: n(u[9]) };
}

export function parseGenerate(bodyText) {
  const b = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
  if (!Array.isArray(b) || !Array.isArray(b[0])) throw new Error("GenerateContent body: expected [[chunks...]]");
  const chunks = b[0];
  let text = "", thoughts = "", finish = null, usage = null, responseId = null, media = 0;
  const code = [];
  for (const ch of chunks) {
    const cand = ch?.[0]?.[0];
    const parts = cand?.[0]?.[0] || [];
    for (const p of parts) {
      if (!Array.isArray(p)) continue;
      if (Array.isArray(p[7])) code.push({ kind: "code", lang: p[7][0], text: p[7][1] });
      if (Array.isArray(p[8])) code.push({ kind: "result", outcome: p[8][0], text: p[8][1] });
      if (Array.isArray(p[2]) && typeof p[2][0] === "string" && p[2][0].includes("/")) media++;
      if (typeof p[1] !== "string") continue;
      if (p[12] === 1) thoughts += p[1];
      else text += p[1];
    }
    if (cand?.[1] != null) finish = cand[1];
    if (ch?.[2]) usage = ch[2];
    if (ch?.[7]) responseId = ch[7];
  }
  return { text, thoughts, code, finish, usage, responseId, media, chunks: chunks.length };
}

export function parseBodies(bodies) {
  const parsed = [];
  const errors = [];
  for (const body of bodies) {
    try {
      parsed.push(parseGenerate(body));
    } catch (e) {
      errors.push(String(e?.message ?? e).slice(0, 200));
    }
  }
  if (!parsed.length) return { available: false, errors };
  const last = parsed[parsed.length - 1];
  return {
    available: true,
    errors,
    requests: parsed.length,
    text: parsed.map((p) => p.text).join(""),
    thoughts: parsed.map((p) => p.thoughts).join(""),
    code: parsed.flatMap((p) => p.code),
    media: parsed.reduce((a, p) => a + p.media, 0),
    finishRaw: last.finish,
    finish: normaliseFinish(last.finish),
    usage: sumUsage(parsed.map((p) => usageOf(p.usage))),
    responseId: last.responseId,
  };
}

export function sumUsage(list) {
  const us = list.filter((u) => u && typeof u === "object");
  if (!us.length) return null;
  const out = {};
  for (const k of ["prompt", "output", "total", "cached", "tool_prompt", "thoughts"]) {
    const vs = us.map((u) => u[k]).filter((v) => typeof v === "number");
    out[k] = vs.length ? vs.reduce((x, y) => x + y, 0) : null;
  }
  return out;
}

const norm = (s) => String(s).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

export function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return norm(a) === norm(b);
}

function firstDiff(a, b) {
  const x = norm(a), y = norm(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

export function chooseText({ copy = null, edit = null, network = null } = {}) {
  const has = (s) => typeof s === "string" && s.length > 0;
  const dom = [];
  if (has(copy)) dom.push({ method: "copy", text: copy });
  if (has(edit)) dom.push({ method: "edit", text: edit });
  const primary = dom[0] ?? null;
  if (typeof network === "string") {
    if (!primary) {
      return {
        text: network,
        method: has(network) ? "network" : "none",
        crosscheck: { against: "network", match: !has(network), note: has(network) ? "copy and edit were empty" : "all empty" },
      };
    }
    const n = flat(network);
    if (!n) {
      return {
        text: primary.text,
        method: primary.method,
        crosscheck: { against: "network", match: false, note: "the network text was empty; the page text was kept" },
      };
    }
    const equal = dom.find((d) => flat(d.text) === n);
    if (equal) {
      return {
        text: equal.text,
        method: equal.method,
        crosscheck: {
          against: "network",
          match: true,
          ...(equal === primary ? {} : { note: `${primary.method} differed from network; ${equal.method} matched` }),
        },
      };
    }
    for (const d of dom) {
      const t = flat(d.text);
      if (n.startsWith(t)) {
        return {
          text: network,
          method: "network",
          crosscheck: {
            against: "network",
            match: false,
            note: `the ${d.method} text is a prefix of the network text; the longer network text was written`,
            primary: d.method,
            primaryChars: d.text.length,
            networkChars: network.length,
          },
        };
      }
      if (t.startsWith(n)) {
        return {
          text: d.text,
          method: d.method,
          crosscheck: {
            against: "network",
            match: false,
            note: `the network text is a prefix of the ${d.method} text; the longer page text was written`,
            primaryChars: d.text.length,
            networkChars: network.length,
          },
        };
      }
    }
    return {
      text: network,
      method: "network",
      pageText: primary.text,
      crosscheck: {
        against: "network",
        match: false,
        conflict: true,
        primary: primary.method,
        primaryChars: primary.text.length,
        networkChars: network.length,
        diffAt: firstDiff(primary.text, network),
      },
    };
  }
  if (!primary) return { text: "", method: "none", crosscheck: { against: null, match: false, note: "no extraction produced text" } };
  if (primary.method === "copy" && has(edit)) {
    return {
      text: copy,
      method: "copy",
      crosscheck: { against: "edit", match: sameText(copy, edit), ...(sameText(copy, edit) ? {} : { diffAt: firstDiff(copy, edit) }) },
    };
  }
  return {
    text: primary.text,
    method: primary.method,
    crosscheck: { against: null, match: false, note: "network unavailable and only one DOM method produced text" },
  };
}

const LIGATURE = /^[a-z]+(_[a-z]+)*$/;
const BADGES = new Set(["New", "Paid", "Preview"]);
export function parseModelLines(lines) {
  const ls = lines.map((l) => String(l).trim()).filter(Boolean);
  const idAt = ls.findIndex((l) => /^[a-z][a-z0-9]*(-[a-z0-9.]+)+$/.test(l));
  if (idAt < 0) return null;
  const id = ls[idAt];
  let name = null;
  for (let i = idAt - 1; i >= 0; i--) {
    if (LIGATURE.test(ls[i]) || BADGES.has(ls[i])) continue;
    name = ls[i];
    break;
  }
  return { id, name, kind: modelKind(id) };
}

export function modelKind(id) {
  if (/-tts\b/.test(id) || /-tts-/.test(id)) return "speech";
  if (/image|nano-banana/.test(id)) return "image";
  if (/live/.test(id)) return "live";
  if (/^lyria/.test(id)) return "music";
  if (/omni|genie|veo/.test(id)) return "video";
  if (/deep-research|antigravity/.test(id)) return "agent";
  if (/transcribe/.test(id)) return "transcribe";
  return "chat";
}

export function imageDims(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length > 24 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) {
    const w = (u[16] << 24) | (u[17] << 16) | (u[18] << 8) | u[19];
    const h = (u[20] << 24) | (u[21] << 16) | (u[22] << 8) | u[23];
    return { type: "png", width: w >>> 0, height: h >>> 0 };
  }
  if (u.length > 4 && u[0] === 0xff && u[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xff) { i++; continue; }
      const m = u[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (u[i + 2] << 8) | u[i + 3];
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
        return { type: "jpeg", height: (u[i + 5] << 8) | u[i + 6], width: (u[i + 7] << 8) | u[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }
  if (u.length > 30 && String.fromCharCode(...u.subarray(0, 4)) === "RIFF" && String.fromCharCode(...u.subarray(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...u.subarray(12, 16));
    if (kind === "VP8X") {
      return {
        type: "webp",
        width: 1 + (u[24] | (u[25] << 8) | (u[26] << 16)),
        height: 1 + (u[27] | (u[28] << 8) | (u[29] << 16)),
      };
    }
    if (kind === "VP8 ") return { type: "webp", width: (u[26] | (u[27] << 8)) & 0x3fff, height: (u[28] | (u[29] << 8)) & 0x3fff };
    if (kind === "VP8L") {
      const b = u[21] | (u[22] << 8) | (u[23] << 16) | (u[24] << 24);
      return { type: "webp", width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

export function wavInfo(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const s = (o, n) => String.fromCharCode(...u.subarray(o, o + n));
  if (u.length < 44 || s(0, 4) !== "RIFF" || s(8, 4) !== "WAVE") return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let i = 12, fmt = null, dataLen = null;
  while (i + 8 <= u.length) {
    const id = s(i, 4), len = dv.getUint32(i + 4, true);
    if (id === "fmt ") {
      fmt = {
        channels: dv.getUint16(i + 10, true),
        sampleRate: dv.getUint32(i + 12, true),
        byteRate: dv.getUint32(i + 16, true),
        bits: dv.getUint16(i + 22, true),
      };
    }
    if (id === "data") { dataLen = Math.min(len, u.length - i - 8); break; }
    i += 8 + len + (len % 2);
  }
  // Compute duration from sampleRate/channels/bits: AI Studio TTS WAV headers report double byteRate.
  const frame = fmt ? fmt.channels * Math.ceil(fmt.bits / 8) : 0;
  if (!fmt || dataLen === null || !frame || !fmt.sampleRate) return null;
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bits: fmt.bits,
    seconds: Math.round((dataLen / (fmt.sampleRate * frame)) * 1000) / 1000,
    headerByteRate: fmt.byteRate,
  };
}

export function stripKey(v, key) {
  if (Array.isArray(v)) return v.map((x) => stripKey(x, key));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== key).map(([k, x]) => [k, stripKey(x, key)]));
  }
  return v;
}

export function sameSchema(a, b) {
  const canon = (v) => JSON.stringify(sortKeys(stripKey(v, "propertyOrdering")));
  return canon(a) === canon(b);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function exitForUiError(text) {
  return /\blimits?\b|quota|exhausted|\brate\b|rate.?limit|tomorrow|exceeded|too many requests/i.test(String(text)) ? 4 : 1;
}

export const CHAT_URL_RE = /^https:\/\/aistudio\.google\.com\/prompts\/(?!new_chat)[A-Za-z0-9_-]{10,}$/;
export const CHAT_MISSING_NEXT = "the files are complete, but the chat link is missing: find the chat in History (https://aistudio.google.com/library)";
export const LATE_SAVE_WARNING = "the chat URL turned into /prompts/<id> only after the 60 s wait; read again at the end";
export const END_URL_WARNING = "the chat link was read from the page URL at the end of the command; no 60 s save wait ran before it";
const STALE_SAVE = /^the chat URL did not turn into \/prompts\/<id>/;

export function settleChat(result, url, warnings = [], opts = {}) {
  const waited = opts.waited === true;
  const last = typeof url === "string" ? url.split(/[?#]/)[0] : null;
  const valid = (u) => typeof u === "string" && CHAT_URL_RE.test(u);
  const r = { ...result };
  let w = [...warnings];
  if (valid(r.chat)) {
    r.chatSaved = true;
    if (valid(last) && last !== r.chat) w.push(`the page URL at the end (${last}) is not the chat reported (${r.chat})`);
  } else if (valid(last)) {
    r.chat = last;
    r.chatSaved = true;
    w = w.filter((x) => !STALE_SAVE.test(x));
    w.push(waited ? LATE_SAVE_WARNING : END_URL_WARNING);
  } else {
    r.chat = null;
    r.chatSaved = false;
    if (r.ok) r.next = CHAT_MISSING_NEXT;
  }
  return { result: r, warnings: w };
}

export const END_URL_CMDS = ["run", "send", "image"];
export const END_URL_TIMEOUT_MS = 5000;

export async function endChatRead({ cmd, page, result, sent, warnings = [], waited = false, timeoutMs = END_URL_TIMEOUT_MS }) {
  if (!END_URL_CMDS.includes(cmd) || !page || result.interrupted || !("chat" in result || sent)) return null;
  let url = null;
  let timer;
  try {
    url = await Promise.race([page.url(), new Promise((r) => (timer = setTimeout(() => r(null), timeoutMs)))]);
  } catch {
    url = null;
  } finally {
    clearTimeout(timer);
  }
  return settleChat(result, url, warnings, { waited });
}
