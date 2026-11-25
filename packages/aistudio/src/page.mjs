// Piped into `ego-browser nodejs` with `const REQ = {...};` prepended by cli.ts.
const P = await import(`file://${REQ.libDir}/parse.mjs`);
const PS = await import(`file://${REQ.libDir}/pagestate.mjs`);
const DL = await import(`file://${REQ.libDir}/download.mjs`);

const life = PS.startPageState({
  marker: REQ.pageMarker ?? null,
  cancelFile: REQ.cancelFile ?? null,
  note: `${REQ.cmd} driver pid ${REQ.driverPid ?? "?"}`,
  maxLifeMs: ((typeof REQ.guardS === "number" ? REQ.guardS : (typeof REQ.timeoutS === "number" ? REQ.timeoutS : 300) + 600) + 300) * 1000,
});
const checkpoint = (where) => life.checkpoint(where);

let sent = false;
function markSent() {
  sent = true;
  console.log(JSON.stringify({ aistudioEvent: "sent" }));
}

const lf = (t) => String(t).replace(/\r\n?/g, "\n");
const ORIGIN = "https://aistudio.google.com";
const SEL = {
  modelId: 'button.model-selector-card [data-test-id="model-name"]',
  prompt: 'textarea[placeholder="Start typing a prompt to see what our models can do"]',
  thinking: '[role="combobox"][aria-label="Thinking Level"]',
  maxOut: 'input[name="maxOutputTokens"]',
  account: 'button[aria-label^="Google Account:"]',
  plan: 'button[aria-label^="Google Account:"] .navbar-badge',
  siButton: 'button[aria-label="System instructions"]',
  siText: 'textarea[placeholder="Optional tone and style instructions for the model"]',
  siTitle: 'input[placeholder="Title"]',
  closePanel: 'button[aria-label="Close panel"]',
  pickerSearch: 'input[placeholder="Search for a model or agent"]',
  schemaText: 'textarea[aria-label="Enter a JSON schema"]',
  schemaSave: 'button[aria-label="Save the current schema"]',
  schemaEdit: 'button[aria-label="Edit JSON schema"]',
  contextCounter: "span.v3-token-count-value",
};
const SWITCH = {
  search: "Grounding with Google Search",
  url: "Browse the url context",
  code: "Code execution",
  schema: "Structured outputs",
};
const GENERATE = /MakerSuiteService\/GenerateContent$/;
const CREATE_SI = "+ Create new instruction";
const SI_PREFIX = "aistudio-driver";
const SI_TITLE = REQ.space === "aistudio" ? SI_PREFIX : `${SI_PREFIX}:${REQ.space}`;

const sleep = async (ms) => {
  checkpoint("a wait");
  await new Promise((r) => setTimeout(r, ms));
  checkpoint("a wait");
};
const note = (...a) => console.error(...a);
const t0 = Date.now();
const warnings = [];
const uiTexts = new Set();
let httpStatus = null;

class Fail extends Error {
  constructor(exit, message, next, extra = {}) {
    super(message);
    this.exit = exit;
    this.next = next;
    this.extra = extra;
  }
}
const uiChanged = (what, extra = {}) =>
  new Fail(3, `UI changed: ${what}`, "AI Studio DOM changed; update selectors in packages/aistudio/src/page.mjs", extra);

function print(o) {
  console.log(JSON.stringify(o));
}

async function openSpace(name) {
  const entry = (await listTaskSpaces()).find((s) => s.name === name);
  if (entry && entry.ownership !== "agent") {
    throw new Fail(7, `space ${name} (id ${entry.id}) is with the user (ownership ${entry.ownership})`, "finish or hand back the space in ego-browser, then run again");
  }
  const task = entry ? await taskSpace(entry.id) : await taskSpace(name);
  let page = (await task.pages())[0];
  if (!page) {
    const tabs = await task.tabs();
    page = tabs.length ? await task.adopt(tabs[0].page) : await task.newPage();
  }
  return { task, page };
}

async function goto(page, url) {
  try {
    await page.goto(url, { timeout: 60000 });
  } catch (e) {
    note(`goto slow (${String(e?.message ?? e).slice(0, 120)}); retrying with 90 s`);
    try {
      await page.goto(url, { timeout: 90000 });
    } catch (e2) {
      throw new Fail(1, `could not load ${url}: ${String(e2?.message ?? e2).slice(0, 200)}`, "check your network connection and run again");
    }
  }
  const at = await page.url();
  if (/accounts\.google\.com/.test(at)) {
    throw new Fail(7, "not signed in: redirected to accounts.google.com", "sign in to Google inside ego-browser, then run again");
  }
  return at;
}

const exists = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
async function need(page, sel, what, timeout = 30000) {
  try {
    await page.waitForSelector(sel, { timeout });
  } catch {
    throw uiChanged(`${what} missing (${sel})`);
  }
}

async function readState(page) {
  return page.evaluate(({ SEL, SWITCH }) => {
    const q = (s) => document.querySelector(s);
    const sw = {};
    for (const [k, label] of Object.entries(SWITCH)) {
      const b = q(`button[role="switch"][aria-label="${label}"]`);
      sw[k] = b ? b.getAttribute("aria-checked") === "true" : null;
    }
    const mo = q(SEL.maxOut);
    return {
      url: location.href,
      model: q(SEL.modelId)?.innerText.trim() ?? null,
      thinking: q(SEL.thinking)?.innerText.trim().split("\n")[0] ?? null,
      maxOut: mo ? Number(mo.value) : null,
      maxOutMax: mo && mo.max ? Number(mo.max) : null,
      switches: sw,
      searchChip: !!q('button[aria-label="Remove Grounding with Google Search"]'),
      si: q(SEL.siButton)?.innerText.trim() ?? null,
    };
  }, { SEL, SWITCH });
}

async function comboOptions(page, sel) {
  await page.evaluate((s) => document.querySelector(s).click(), sel);
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  const opts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((o) => o.innerText.trim().replace(/\s+/g, " ")));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="option"]'), undefined, { timeout: 5000 }).catch(() => {});
  return opts;
}

async function pickOption(page, comboSel, option) {
  await page.evaluate((s) => document.querySelector(s).click(), comboSel);
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  const ok = await page.evaluate((o) => {
    const opt = [...document.querySelectorAll('[role="option"]')].find((x) => x.innerText.trim().replace(/\s+/g, " ") === o);
    if (!opt) return false;
    opt.click();
    return true;
  }, option);
  if (!ok) {
    await page.keyboard.press("Escape");
    return false;
  }
  await page.waitForFunction(() => !document.querySelector('[role="option"]'), undefined, { timeout: 5000 }).catch(() => {});
  return true;
}

async function setSwitch(page, key, on) {
  const label = SWITCH[key];
  const sel = `button[role="switch"][aria-label="${label}"]`;
  const cur = await page.evaluate((s) => {
    const all = document.querySelectorAll(s);
    return all.length === 1 ? all[0].getAttribute("aria-checked") : all.length ? "many" : null;
  }, sel);
  if (cur === null) {
    if (!on) return;
    throw new Fail(2, `this model has no ${label} switch`, "pick a model that offers the tool, or omit it from --tools");
  }
  if (cur === "many") throw uiChanged(`switch ${label} matches more than once`);
  if ((cur === "true") === on) return;
  await page.evaluate((s) => document.querySelector(s).click(), sel);
  try {
    await page.waitForFunction(({ s, v }) => document.querySelector(s)?.getAttribute("aria-checked") === v, { s: sel, v: String(on) }, { timeout: 5000 });
  } catch {
    const got = await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-checked"), sel);
    throw new Fail(3, `switch ${label} did not read back: wanted ${on}, got ${got}`, "tool may conflict with other settings; retry without it", { wanted: on, got });
  }
}

const readSiStore = (page) => page.evaluate(() => {
  try {
    return JSON.parse(localStorage.getItem("aistudio_all_system_instructions") || "[]");
  } catch {
    return null;
  }
});

const userOwnedSi = (list) => JSON.stringify((list || []).filter((s) => typeof s?.title === "string" && !s.title.startsWith(SI_PREFIX)));

async function siPanel(page) {
  await page.evaluate((s) => document.querySelector(s)?.click(), SEL.siButton);
  await need(page, SEL.siText, "system instruction textarea", 10000);
  await sleep(500);
  return page.evaluate(({ SEL }) => {
    const ta = document.querySelector(SEL.siText);
    const pane = ta.closest(".cdk-overlay-pane") || document;
    const cb = pane.querySelector('[role="combobox"]');
    return { text: ta.value, title: document.querySelector(SEL.siTitle)?.value ?? null, combo: cb ? cb.innerText.trim().replace(/\s+/g, " ") : null };
  }, { SEL });
}
const SI_COMBO = `.cdk-overlay-pane:has(${SEL.siText}) [role="combobox"]`;

async function closeSiPanel(page) {
  await page.evaluate(({ SEL }) => document.querySelector(SEL.siText)?.closest(".cdk-overlay-pane")?.querySelector(SEL.closePanel)?.click() ?? document.querySelector(SEL.closePanel)?.click(), { SEL });
  await page.waitForFunction((s) => !document.querySelector(s), SEL.siText, { timeout: 5000 }).catch(() => {});
}

async function setSystem(page, raw) {
  const text = raw === null ? null : lf(raw);
  const before = await readSiStore(page);
  const userBefore = userOwnedSi(before);
  let st = await siPanel(page);
  if (st.combo === null) throw uiChanged("system instruction title combobox missing");
  const comboIsCreate = st.combo.replace(/\s+/g, "") === CREATE_SI.replace(/\s+/g, "");
  if (!comboIsCreate && st.combo !== SI_TITLE) {
    await closeSiPanel(page);
    throw new Fail(3, `system instruction is "${st.combo}", not empty or ${SI_TITLE}; nothing typed`, "open a new chat manually once to reset it");
  }
  if (text === null) {
    if (!comboIsCreate || st.text.trim()) {
      await closeSiPanel(page);
      throw new Fail(3, `new chat carries a system instruction (${st.combo}, ${st.text.length} chars); refusing to run`, "clear the default instruction in AI Studio");
    }
    await closeSiPanel(page);
    return null;
  }
  const ours = (before || []).some((s) => s.title === SI_TITLE);
  if (ours && comboIsCreate) {
    const opts = await comboOptions(page, SI_COMBO);
    if (!opts.includes(SI_TITLE)) throw uiChanged(`system instruction ${SI_TITLE} is stored but not offered (options: ${opts.join(" | ")})`);
    if (!(await pickOption(page, SI_COMBO, SI_TITLE))) throw uiChanged(`could not select system instruction ${SI_TITLE}`);
    await page.waitForFunction(({ s, t }) => document.querySelector(s)?.value === t, { s: SEL.siTitle, t: SI_TITLE }, { timeout: 5000 }).catch(() => {});
  } else if (!ours) {
    await page.fill(SEL.siTitle, SI_TITLE);
  }
  st = await siPanel(page);
  if (st.combo !== SI_TITLE && !(st.title === SI_TITLE && !ours)) {
    await closeSiPanel(page);
    throw new Fail(3, `system instruction title reads "${st.combo}" / "${st.title}", wanted ${SI_TITLE}; nothing typed`, "update system instruction selectors");
  }
  await page.fill(SEL.siText, text);
  let stored = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    stored = ((await readSiStore(page)) || []).find((s) => s.title === SI_TITLE);
    if (stored && stored.text === text) break;
  }
  st = await siPanel(page);
  await closeSiPanel(page);
  const after = await readSiStore(page);
  if (userOwnedSi(after) !== userBefore) warnings.push("a non-driver stored system instruction changed during this run; verify manually");
  const dup = (after || []).filter((s) => s.title === SI_TITLE).length;
  if (dup > 1) warnings.push(`${dup} stored instructions are titled ${SI_TITLE}`);
  if (st.text !== text || !stored || stored.text !== text) {
    throw new Fail(3, `system instruction did not read back (panel ${st.text.length} chars, store ${stored ? stored.text.length : "none"}, wanted ${text.length})`, "update system instruction selectors");
  }
  return SI_TITLE;
}

async function setSchema(page, schema) {
  await setSwitch(page, "schema", true);
  if (!(await page.waitForSelector(SEL.schemaText, { timeout: 4000 }).then(() => true, () => false))) {
    if (!(await exists(page, 'button[role="tab"], [role="tab"]'))) {
      await page.evaluate((s) => document.querySelector(s)?.click(), SEL.schemaEdit);
    }
  }
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.innerText.trim() === "Code Editor")?.click());
  await need(page, SEL.schemaText, "schema code editor", 8000);
  const text = JSON.stringify(schema, null, 2);
  await page.fill(SEL.schemaText, text);
  await page.evaluate((s) => document.querySelector(s)?.click(), SEL.schemaSave);
  await page.waitForFunction((s) => !document.querySelector(s), SEL.schemaText, { timeout: 8000 }).catch(() => {});
  if (await exists(page, SEL.schemaText)) await page.evaluate(() => document.querySelector('button[aria-label="close"]')?.click());
  await page.evaluate((s) => document.querySelector(s)?.click(), SEL.schemaEdit);
  await need(page, SEL.schemaText, "schema editor on reopen", 8000);
  await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.innerText.trim() === "Code Editor")?.click());
  await sleep(400);
  const got = await page.evaluate((s) => document.querySelector(s)?.value ?? null, SEL.schemaText);
  await page.evaluate(() => document.querySelector('button[aria-label="close"]')?.click());
  await page.waitForFunction((s) => !document.querySelector(s), SEL.schemaText, { timeout: 5000 }).catch(() => {});
  let parsed = null;
  try {
    parsed = JSON.parse(got);
  } catch {}
  if (!parsed || !P.sameSchema(parsed, schema)) {
    throw new Fail(3, "schema did not read back from Structured outputs dialog", "update schema dialog selectors", { got: String(got).slice(0, 300) });
  }
}

async function attachFiles(page, files) {
  if (!files.length) return [];
  // Upload files requires trusted page.click user activation; DOM click inside evaluate opens no file chooser.
  const item = '[role="menu"] button[aria-label="Upload files"]';
  const chooserP = page.waitForFileChooser({ timeout: 10000 });
  await page.click('button[aria-label^="Insert"]', { label: "open insert menu" });
  if (!(await page.waitForSelector(item, { timeout: 5000 }).then(() => true, () => false))) {
    chooserP.catch(() => {});
    await page.keyboard.press("Escape");
    throw uiChanged(`Insert menu item Upload files missing (${item})`);
  }
  await page.click(item, { label: "choose upload files" });
  let chooser;
  try {
    chooser = await chooserP;
  } catch {
    throw uiChanged("file chooser did not open within 10 s (Upload files)");
  }
  checkpoint("the upload");
  await chooser.setFiles(files);
  const names = files.map((f) => f.split("/").pop());
  const deadline = Date.now() + 300000;
  for (;;) {
    const s = await page.evaluate((names) => {
      const body = document.body.innerText;
      const toast = (body.match(/[^\n]*File type not supported[^\n]*/) || [null])[0];
      const loading = /Loading\.\.\./.test(document.querySelector("ms-prompt-box, ms-prompt-input-wrapper, footer")?.innerText ?? body);
      const present = names.filter((n) => body.includes(n));
      return { toast, loading, present };
    }, names);
    if (s.toast) throw new Fail(2, `upload refused: ${s.toast}`, "attach a supported file type");
    if (!s.loading && s.present.length === names.length) return names;
    if (Date.now() > deadline) {
      if (s.loading) throw new Fail(1, "an upload is still Loading after 5 min", "try smaller files");
      throw new Fail(1, `uploaded file chips missing: ${names.filter((n) => !s.present.includes(n)).join(", ")}`, "run again or update upload selectors");
    }
    await sleep(700);
  }
}

async function fillPrompt(page, raw) {
  const text = lf(raw);
  await need(page, SEL.prompt, "prompt box");
  await page.fill(SEL.prompt, text);
  const got = await page.evaluate((s) => document.querySelector(s).value, SEL.prompt);
  if (got !== text) throw new Fail(3, `prompt did not read back (${got.length} of ${text.length} chars)`, "update prompt selectors");
  await sleep(800);
  const tok = await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const err = e.classList.contains("error") || !!e.closest(".error");
    return { text: e.innerText.trim(), err, tip: err ? (e.getAttribute("title") || e.closest("[mattooltip]")?.getAttribute("mattooltip") || e.parentElement?.innerText || "").trim() : null };
  }, SEL.contextCounter);
  if (tok?.err) throw new Fail(4, `over the model's context: ${tok.text} ${tok.tip ?? ""}`.trim(), "shorten the prompt or attachments");
  return tok?.text ?? null;
}

const turnInfo = (page) => page.evaluate(() => [...document.querySelectorAll("ms-chat-turn")].map((t) => {
  const c = t.querySelector(".chat-turn-container");
  return {
    role: c?.classList.contains("user") ? "user" : c?.classList.contains("model") ? "model" : "?",
    thought: !!t.querySelector("ms-thought-chunk"),
    code: !!t.querySelector("ms-code-execution-chunk"),
    edit: !!t.querySelector('button[aria-label="Edit"]'),
    blocked: /Recitation block|Content blocked|blocked/i.test(t.innerText) && !t.querySelector('button[aria-label="Edit"]') ? t.innerText.replace(/\s+/g, " ").slice(0, 120) : null,
  };
}));

const answerIndexes = (turns) => turns.map((t, i) => (t.role === "model" && !t.thought && !t.code ? i : -1)).filter((i) => i >= 0);

function collector(page, endpoint = GENERATE) {
  const evs = [];
  return {
    async pull() {
      evs.push(...(await page.events()));
      return evs;
    },
    reset() {
      evs.length = 0;
    },
    generate() {
      const reqs = new Map();
      for (const e of evs) {
        const p = e.params || {};
        if (e.method === "Network.requestWillBeSent" && endpoint.test(p.request?.url ?? "")) {
          reqs.set(p.requestId, { id: p.requestId, t: p.timestamp, done: false, url: p.request.url });
        }
        if (e.method === "Network.loadingFinished" && reqs.has(p.requestId)) reqs.get(p.requestId).done = true;
        if (e.method === "Network.loadingFailed" && reqs.has(p.requestId)) Object.assign(reqs.get(p.requestId), { done: true, failed: p.errorText || "failed" });
        if (e.method === "Network.responseReceived" && reqs.has(p.requestId)) reqs.get(p.requestId).status = p.response?.status;
      }
      return [...reqs.values()].sort((a, b) => a.t - b.t);
    },
  };
}

async function runState(page) {
  return page.evaluate(() => {
    const stop = [...document.querySelectorAll("button, span")].some((e) => e.childElementCount === 0 && e.textContent.trim() === "Stop");
    const runBtn = [...document.querySelectorAll("button")].find((x) => /^Run\b/.test(x.innerText.trim()));
    const err = [...document.querySelectorAll("mat-snack-bar-container, .mdc-snackbar, ms-chat-turn .error, .model-error, [class*=error-message]")].map((e) => e.innerText.trim().replace(/\s+/g, " ").slice(0, 300)).filter(Boolean);
    return { stop, run: !!runBtn, runDisabled: runBtn ? runBtn.disabled : null, err };
  });
}

async function clickRun(page) {
  const ready = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Run\b/.test(x.innerText.trim()));
    return !b ? "missing" : b.disabled ? "disabled" : "ready";
  });
  if (ready !== "ready") throw uiChanged(`Run button ${ready}`);
  checkpoint("Run");
  markSent();
  const s = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Run\b/.test(x.innerText.trim()));
    if (!b) return "missing";
    if (b.disabled) return "disabled";
    b.click();
    return "clicked";
  });
  if (s !== "clicked") {
    sent = false;
    throw uiChanged(`Run button ${s}`);
  }
}

async function runAndWait(page, net, timeoutS, turnsBefore) {
  await net.pull();
  net.reset();
  await clickRun(page);
  const deadline = Date.now() + timeoutS * 1000;
  let sawStop = false, quietSince = 0;
  const errs = new Set();
  for (;;) {
    await sleep(500);
    const s = await runState(page);
    for (const e of s.err) errs.add(e);
    await net.pull();
    const gen = net.generate();
    if (s.stop) sawStop = true;
    const netDone = gen.length > 0 && gen.every((g) => g.done);
    const settled = !s.stop && s.run && (netDone || (errs.size > 0 && !gen.length));
    if (settled) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince > 1500) break;
    } else quietSince = 0;
    if (!sawStop && !gen.length && Date.now() - (deadline - timeoutS * 1000) > 30000 && !s.stop) {
      const tn = (await turnInfo(page)).length;
      if (tn <= turnsBefore) {
        throw new Fail(1, "run did not start within 30 s (no Stop, no request, no new turn)", "inspect the page in ego-browser and run again", { errors: [...errs] });
      }
    }
    if (Date.now() > deadline) {
      throw new Fail(1, `answer did not finish within ${timeoutS} s`, "pass a larger --timeout; the page was left open", { errors: [...errs] });
    }
  }
  const gen = net.generate();
  await limitCheck(page, gen, errs);
  if (!gen.length) {
    const text = [...errs].join(" | ");
    if (text) throw new Fail(1, `run failed: ${text}`, "inspect the page in ego-browser and run again", { uiText: text });
    throw new Fail(3, "run finished but no GenerateContent request was observed", "update GENERATE endpoint regex in packages/aistudio/src/page.mjs");
  }
  if (errs.size) warnings.push(`page messages during run: ${[...errs].join(" | ").slice(0, 400)}`);
  return { sawStop, requests: gen };
}

async function limitCheck(page, reqs, errs) {
  for (const e of errs) uiTexts.add(e);
  const bad = reqs.filter((g) => g.status != null && g.status !== 200);
  for (const b of bad) {
    httpStatus = b.status;
    let body = "";
    try {
      const r = await page.cdp("Network.getResponseBody", { requestId: b.id });
      body = (r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body).replace(/\s+/g, " ").slice(0, 400);
    } catch {}
    uiTexts.add(`HTTP ${b.status}${body ? `: ${body}` : ""}`);
  }
  const text = [...uiTexts].join(" | ");
  if ((text && P.exitForUiError(text) === 4) || bad.some((b) => b.status === 429)) {
    throw new Fail(4, `limit reached: ${text.slice(0, 500)}`, "wait for quota reset or switch models; `aistudio usage` shows recorded counts", { uiText: text, httpStatus });
  }
  if (bad.length) {
    throw new Fail(1, `request failed with HTTP ${bad.map((b) => b.status).join(", ")}: ${text.slice(0, 400)}`, "inspect the page in ego-browser and run again", { uiText: text, httpStatus });
  }
}

let savedWaitRan = false;
async function waitSaved(page) {
  savedWaitRan = true;
  try {
    await page.waitForFunction(() => /^\/prompts\/(?!new_chat)[A-Za-z0-9_-]{10,}/.test(location.pathname), undefined, { timeout: 60000 });
    return (await page.url()).split(/[?#]/)[0];
  } catch {
    warnings.push("the chat URL did not turn into /prompts/<id> within 60 s; the chat may not be saved");
    return null;
  }
}

async function bodies(page, requests) {
  const out = [];
  const errors = [];
  for (const r of requests) {
    if (r.failed) {
      errors.push(`request failed: ${r.failed}`);
      continue;
    }
    try {
      const b = await page.cdp("Network.getResponseBody", { requestId: r.id });
      out.push(b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body);
    } catch (e) {
      errors.push(String(e?.message ?? e).slice(0, 160));
    }
  }
  return { out, errors };
}

async function copyTurn(page, index) {
  await page.evaluate(() => {
    window.__cap = [];
    const c = navigator.clipboard;
    if (c && !c.__patched) {
      c.writeText = async (t) => { window.__cap.push({ via: "writeText", t }); };
      c.write = async (items) => {
        for (const it of items) for (const ty of it.types) {
          const bl = await it.getType(ty);
          window.__cap.push({ via: "write:" + ty, t: await bl.text() });
        }
      };
      c.__patched = true;
    }
    if (!document.__execPatched) {
      const orig = document.execCommand.bind(document);
      document.execCommand = (cmd, ...a) => {
        if (String(cmd).toLowerCase() === "copy") {
          const el = document.activeElement;
          const sel = el && "value" in el ? el.value.slice(el.selectionStart, el.selectionEnd) : String(window.getSelection());
          window.__cap.push({ via: "execCommand", t: sel });
          return true;
        }
        return orig(cmd, ...a);
      };
      document.__execPatched = true;
    }
  });
  const opened = await page.evaluate((i) => {
    const t = document.querySelectorAll("ms-chat-turn")[i];
    t?.scrollIntoView({ block: "center" });
    const b = t?.querySelector('button[aria-label="Open options"]');
    if (!b) return false;
    b.click();
    return true;
  }, index);
  if (!opened) return { text: null, why: "turn Open options button missing" };
  if (!(await page.waitForSelector('[role="menu"]', { timeout: 5000 }).then(() => true, () => false))) {
    return { text: null, why: "turn options menu did not open" };
  }
  const has = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] button')].some((b) => b.innerText.includes("Copy as markdown")));
  if (!has) {
    await page.keyboard.press("Escape");
    return { text: null, why: "Copy as markdown menu item missing" };
  }
  await page.click('[role="menu"] button:has-text("Copy as markdown")', { label: "copy answer as markdown" });
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const cap = await page.evaluate(() => window.__cap);
    const hit = cap.find((c) => typeof c.t === "string" && c.t.length);
    if (hit) return { text: hit.t, via: hit.via };
  }
  return { text: "", why: "copy captured nothing" };
}

async function editTurn(page, index) {
  const opened = await page.evaluate((i) => {
    const t = document.querySelectorAll("ms-chat-turn")[i];
    t?.scrollIntoView({ block: "center" });
    const b = t?.querySelector('button[aria-label="Edit"]');
    if (!b) return false;
    b.click();
    return true;
  }, index);
  if (!opened) return { text: null, why: "turn Edit button missing" };
  try {
    await page.waitForFunction((i) => !!document.querySelectorAll("ms-chat-turn")[i]?.querySelector("textarea"), index, { timeout: 5000 });
  } catch {
    return { text: null, why: "edit textarea did not appear" };
  }
  const v = await page.evaluate((i) => document.querySelectorAll("ms-chat-turn")[i].querySelector("textarea").value, index);
  await page.evaluate((i) => document.querySelectorAll("ms-chat-turn")[i].querySelector('button[aria-label="Stop editing"]')?.click(), index);
  const left = await page.waitForFunction((i) => !document.querySelectorAll("ms-chat-turn")[i]?.querySelector("textarea"), index, { timeout: 5000 }).then(() => true, () => false);
  if (!left) warnings.push("answer turn stayed in edit mode after Stop editing");
  return { text: v };
}

async function extract(page, index, network) {
  const copy = await copyTurn(page, index);
  let edit = { text: null };
  const needEdit = !copy.text || network === null || !P.sameText(copy.text, network);
  if (needEdit) edit = await editTurn(page, index);
  if (copy.why) warnings.push(`copy: ${copy.why}`);
  if (edit.why) warnings.push(`edit: ${edit.why}`);
  if (copy.text === null && edit.text === null && network === null) throw uiChanged(`no extraction worked (${copy.why}; ${edit.why})`);
  return P.chooseText({ copy: copy.text, edit: edit.text, network });
}

async function cmdCheck(page) {
  await goto(page, `${ORIGIN}/prompts/new_chat?model=gemini-3.8-flash`);
  await sleep(1500);
  if (!(await page.waitForSelector(SEL.account, { timeout: 30000 }).then(() => true, () => false))) {
    throw new Fail(7, "no Google account button: not signed in", "sign in inside ego-browser, then run again");
  }
  const canaries = {
    "model card": SEL.modelId,
    "prompt box": SEL.prompt,
    "plan badge": SEL.plan,
    "thinking combobox": SEL.thinking,
    "max output input": SEL.maxOut,
    "system instructions button": SEL.siButton,
    "Insert button": 'button[aria-label^="Insert"]',
    "new chat button": 'button[aria-label="New chat"]',
    ...Object.fromEntries(Object.entries(SWITCH).map(([k, l]) => [`${k} switch`, `button[role="switch"][aria-label="${l}"]`])),
  };
  await page.waitForSelector(SEL.modelId, { timeout: 30000 }).catch(() => {});
  const found = await page.evaluate((c) => Object.fromEntries(Object.entries(c).map(([k, s]) => [k, !!document.querySelector(s)])), canaries);
  found["Run button"] = await page.evaluate(() => !![...document.querySelectorAll("button")].find((x) => /^Run\b/.test(x.innerText.trim())));
  // Never read SEL.account aria-label: it carries the user's Google account email.
  const plan = await page.evaluate((s) => document.querySelector(s)?.innerText.trim() ?? null, SEL.plan);
  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => k);
  const model = await page.evaluate((s) => document.querySelector(s)?.innerText.trim() ?? null, SEL.modelId);
  const base = { cmd: "check", plan, model, canaries: found };
  if (missing.length) throw uiChanged(`missing: ${missing.map((k) => `${k} (${canaries[k] ?? "button text Run"})`).join(", ")}`, base);
  return { ok: true, exit: 0, ...base };
}

async function cmdModels(page) {
  await goto(page, `${ORIGIN}/prompts/new_chat?model=gemini-3.8-flash`);
  await need(page, "button.model-selector-card", "model card");
  await sleep(1000);
  if (!(await exists(page, SEL.pickerSearch))) {
    await page.evaluate(() => document.querySelector("button.model-selector-card").click());
    await need(page, SEL.pickerSearch, "model picker search box", 10000);
  }
  await page.fill(SEL.pickerSearch, "");
  await sleep(600);
  let lines = [];
  for (let i = 0; i < 5; i++) {
    lines = await page.evaluate((S) => {
      const pane = document.querySelector(S)?.closest(".cdk-overlay-pane");
      if (!pane) return [];
      const all = [...pane.querySelectorAll("button.ms-button-filter-chip")].find((b) => b.innerText.trim() === "All");
      if (all && all.getAttribute("aria-selected") !== "true") { all.click(); return []; }
      return [...pane.querySelectorAll("button")].filter((b) => b.querySelector("ul")).map((b) => b.innerText.split("\n"));
    }, SEL.pickerSearch);
    if (lines.length) break;
    await sleep(800);
  }
  await page.evaluate((s) => document.querySelector(s)?.click(), SEL.closePanel);
  const models = [];
  const seen = new Set();
  for (const l of lines) {
    const m = P.parseModelLines(l);
    if (m && !seen.has(m.id)) { seen.add(m.id); models.push(m); }
  }
  if (!models.length) throw uiChanged("model picker shows no entries under All");
  return { ok: true, exit: 0, cmd: "models", count: models.length, models };
}

async function settle(page, req) {
  const st0 = await readState(page);
  if (req.thinking) {
    if (!(await exists(page, SEL.thinking))) throw new Fail(2, `${req.model} has no Thinking level setting`, "omit --thinking for this model");
    const opts = await comboOptions(page, SEL.thinking);
    if (!opts.includes(req.thinking)) {
      throw new Fail(2, `${req.model} offers thinking ${opts.join(", ")}; not ${req.thinking}`, `pass one of: ${opts.map((o) => o.toLowerCase().replace(/ /g, "-")).join(", ")}`, { offered: opts });
    }
    if (st0.thinking !== req.thinking && !(await pickOption(page, SEL.thinking, req.thinking))) {
      throw uiChanged(`thinking option ${req.thinking} could not be clicked`);
    }
  }
  let wantMax = req.maxOut;
  if (wantMax == null && req.thinking === "High" && st0.maxOutMax) wantMax = st0.maxOutMax;
  if (wantMax != null) {
    if (!(await exists(page, SEL.maxOut))) throw new Fail(2, `${req.model} has no max output setting`, "omit --max-out for this model");
    await page.fill(SEL.maxOut, String(wantMax));
    await page.press(SEL.maxOut, "Tab");
    await sleep(400);
  }
  for (const k of ["search", "url", "code"]) await setSwitch(page, k, req.tools.includes(k));
  if (req.schema) await setSchema(page, req.schema);
  else await setSwitch(page, "schema", false);
  const st = await readState(page);
  if (req.thinking && st.thinking !== req.thinking) {
    throw new Fail(3, `thinking did not read back: wanted ${req.thinking}, got ${st.thinking}`, "update thinking selectors", { wanted: req.thinking, got: st.thinking });
  }
  if (wantMax != null) {
    const expect = st.maxOutMax ? Math.min(wantMax, st.maxOutMax) : wantMax;
    if (st.maxOut !== expect) throw new Fail(3, `max output did not read back: wanted ${expect}, got ${st.maxOut}`, "update maxOut selectors", { wanted: expect, got: st.maxOut });
    if (expect < wantMax) warnings.push(`max output clamped by UI to ${expect}`);
  }
  for (const k of ["search", "url", "code"]) {
    const want = req.tools.includes(k);
    if (st.switches[k] !== want && !(st.switches[k] === null && !want)) {
      throw new Fail(3, `${SWITCH[k]} did not read back: wanted ${want}, got ${st.switches[k]}`, "update tool switch selectors");
    }
  }
  if (!req.tools.includes("search") && st.searchChip) throw new Fail(3, "search grounding chip still shown with switch off", "update switch selectors");
  return {
    thinking: st.thinking,
    maxOut: st.maxOut,
    maxOutMax: st.maxOutMax,
    tools: Object.entries(st.switches).filter(([k, v]) => v && k !== "schema").map(([k]) => k),
    schema: !!st.switches.schema,
  };
}

async function answer(page, net, run, chat, model, settings) {
  const { out: bs, errors } = await bodies(page, run.requests);
  const parsed = P.parseBodies(bs);
  const turns = await turnInfo(page);
  const idx = answerIndexes(turns);
  const last = idx.length ? idx[idx.length - 1] : -1;
  const networkText = parsed.available ? parsed.text : null;
  const finish = parsed.available ? parsed.finish : "unknown";
  if (parsed.available && finish === "stop" && !parsed.text && !parsed.media) {
    throw uiChanged("GenerateContent finished with STOP but parser found no text");
  }
  let r;
  const blocked = last >= 0 ? turns[last].blocked : null;
  if (last < 0) {
    if (networkText === null) throw uiChanged("no answer turn and no network text");
    r = { text: networkText, method: "network", crosscheck: { against: null, match: false, note: "no answer turn in DOM" } };
  } else if (blocked || (!turns[last].edit && (finish === "recitation" || finish === "safety"))) {
    r = { text: networkText ?? "", method: networkText ? "network" : "none", crosscheck: { against: null, match: false, note: `answer turn blocked: ${blocked ?? finish}` } };
  } else {
    r = await extract(page, last, networkText);
  }
  let exit = P.exitForFinish(finish);
  if (blocked && exit === 0) exit = 5;
  const conflict = typeof r.pageText === "string";
  if (conflict && exit === 0) exit = 1;
  if (errors.length) warnings.push(`network bodies: ${errors.join("; ")}`);
  if (parsed.errors?.length) warnings.push(`body parse: ${parsed.errors.join("; ")}`);
  if (!parsed.available) r.crosscheck = { ...r.crosscheck, network: "unavailable" };
  return {
    ok: exit === 0,
    exit,
    chat,
    model,
    settings,
    finish: blocked && finish === "unknown" ? "recitation" : finish,
    finishRaw: parsed.available ? parsed.finishRaw : null,
    usage: parsed.available ? parsed.usage : null,
    requests: parsed.available ? parsed.requests : 0,
    chars: r.text.length,
    thoughtsChars: parsed.available ? parsed.thoughts.length : null,
    codeParts: parsed.available ? parsed.code.length : null,
    method: r.method,
    crosscheck: r.crosscheck,
    ...(conflict ? { _pageText: r.pageText } : {}),
    ...(exit === 5 ? { error: `answer blocked (${blocked ?? finish})`, next: "rephrase the prompt; any returned text was written" } : {}),
    ...(exit === 6 ? { error: "answer truncated at max output tokens", next: "raise --max-out; partial text was written" } : {}),
    _text: r.text,
  };
}

async function cmdRun(page, req) {
  const url = await goto(page, `${ORIGIN}/prompts/new_chat?model=${encodeURIComponent(req.model)}`);
  if (/generate-speech/.test(url)) throw new Fail(2, `${req.model} is a speech model`, "use the speech command");
  await need(page, SEL.modelId, "model card");
  await sleep(1500);
  const card = await page.evaluate((s) => document.querySelector(s)?.innerText.trim(), SEL.modelId);
  if (card !== req.model) throw new Fail(2, `page opened ${card}, not ${req.model} (unknown id?)`, "run `aistudio models` for available ids", { shown: card });
  const net = collector(page);
  await page.cdp("Network.enable", { maxTotalBufferSize: 200000000, maxResourceBufferSize: 50000000 });
  const siTitle = await setSystem(page, req.system);
  const settings = await settle(page, req);
  settings.system = siTitle;
  const attached = await attachFiles(page, req.attach);
  const youtube = req.youtube ? await attachYoutube(page, req.youtube) : null;
  const turnsBefore = (await turnInfo(page)).length;
  await fillPrompt(page, req.prompt);
  const run = await runAndWait(page, net, req.timeoutS, turnsBefore);
  const chat = await waitSaved(page);
  const model = await page.evaluate((s) => document.querySelector(s)?.innerText.trim(), SEL.modelId);
  return { cmd: "run", attached, ...(youtube ? { youtube } : {}), ...(await answer(page, net, run, chat, model, settings)) };
}

async function cmdSend(page, req) {
  await goto(page, req.chat);
  if (!(await page.waitForSelector("ms-chat-turn", { timeout: 30000 }).then(() => true, () => false))) {
    throw new Fail(2, `no chat turns at ${req.chat}`, "check the chat id in https://aistudio.google.com/library");
  }
  await sleep(1500);
  const net = collector(page);
  await page.cdp("Network.enable", { maxTotalBufferSize: 200000000, maxResourceBufferSize: 50000000 });
  const attached = await attachFiles(page, req.attach);
  const youtube = req.youtube ? await attachYoutube(page, req.youtube) : null;
  const turnsBefore = (await turnInfo(page)).length;
  await fillPrompt(page, req.prompt);
  const run = await runAndWait(page, net, req.timeoutS, turnsBefore);
  await sleep(1500);
  const chat = (await page.url()).split(/[?#]/)[0];
  if (chat !== req.chat) warnings.push(`chat URL changed to ${chat}`);
  const turnsAfter = (await turnInfo(page)).length;
  if (turnsAfter <= turnsBefore) throw new Fail(1, "no new turns appeared after follow-up", "inspect the chat in ego-browser");
  const model = await page.evaluate((s) => document.querySelector(s)?.innerText.trim(), SEL.modelId);
  const st = await readState(page);
  return {
    cmd: "send",
    attached,
    ...(youtube ? { youtube } : {}),
    ...(await answer(page, net, run, chat, model, {
      thinking: st.thinking,
      maxOut: st.maxOut,
      tools: Object.entries(st.switches).filter(([k, v]) => v && k !== "schema").map(([k]) => k),
      schema: !!st.switches.schema,
    })),
  };
}

async function cmdGet(page, req) {
  await goto(page, req.chat);
  if (!(await page.waitForSelector("ms-chat-turn", { timeout: 30000 }).then(() => true, () => false))) {
    throw new Fail(2, `no chat turns at ${req.chat}`, "check the chat id in https://aistudio.google.com/library");
  }
  await sleep(2000);
  const turns = await turnInfo(page);
  const idx = answerIndexes(turns);
  if (!idx.length) throw new Fail(1, "chat has no model answer turn", "inspect the chat in ego-browser");
  const n = req.turn === "last" ? idx.length : req.turn;
  if (n > idx.length) throw new Fail(2, `chat has ${idx.length} answer turns; --turn ${req.turn} is past the end`, `pass --turn 1..${idx.length} or last`);
  const at = idx[n - 1];
  const model = await page.evaluate((s) => document.querySelector(s)?.innerText.trim(), SEL.modelId);
  if (turns[at].blocked) {
    return {
      ok: false, exit: 5, cmd: "get", chat: req.chat, model, turn: n, turns: idx.length,
      finish: "unknown", chars: 0, method: "none", crosscheck: { against: null, match: false, note: turns[at].blocked },
      error: `answer blocked: ${turns[at].blocked}`, next: "nothing to extract", _text: "",
    };
  }
  const copy = await copyTurn(page, at);
  const edit = await editTurn(page, at);
  if (copy.why) warnings.push(`copy: ${copy.why}`);
  if (edit.why) warnings.push(`edit: ${edit.why}`);
  if (copy.text === null && edit.text === null) throw uiChanged(`no extraction worked (${copy.why}; ${edit.why})`);
  const r = P.chooseText({ copy: copy.text, edit: edit.text, network: null });
  const conflict = typeof r.pageText === "string";
  return {
    ok: !conflict, exit: conflict ? 1 : 0, ...(conflict ? { _pageText: r.pageText } : {}),
    cmd: "get", chat: req.chat, model, turn: n, turns: idx.length, finish: "unknown", usage: null,
    chars: r.text.length, method: r.method, crosscheck: r.crosscheck, _text: r.text,
  };
}

async function cmdClose(req) {
  const spaces = await listTaskSpaces();
  const closed = [], skipped = [];
  for (const name of req.spaces) {
    const e = spaces.find((s) => s.name === name);
    if (!e) { skipped.push({ space: name, why: "not open" }); continue; }
    if (e.ownership !== "agent") { skipped.push({ space: name, why: `with the user (${e.ownership})` }); continue; }
    const task = await taskSpace(e.id);
    await task.finish({ keep: [] });
    closed.push(name);
  }
  return { ok: true, exit: 0, cmd: "close", closed, skipped };
}

const fsp = await import("node:fs/promises");
const { createHash } = await import("node:crypto");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function freshName(dir, base, ext) {
  for (let i = 1; ; i++) {
    const f = `${dir}/${base}${i === 1 ? "" : `-${i}`}.${ext}`;
    try {
      await fsp.access(f);
    } catch {
      return f;
    }
  }
}

const DOWNLOAD_LOCK = REQ.downloadLock;
const downloadWaits = [];

async function cdpDownload(page, dir, click, target, timeoutMs = 60000) {
  try {
    const r = await DL.lockedDownload(page, dir, click, target, {
      lockFile: DOWNLOAD_LOCK,
      note: `${REQ.cmd} space ${REQ.space} driver pid ${REQ.driverPid ?? "?"}`,
      timeoutMs,
      lockWaitMs: timeoutMs + 90000,
      sleep,
      checkpoint,
      warn: (w) => warnings.push(w),
    });
    if (r && r.waitedMs > 1000) note(`waited ${Math.round(r.waitedMs / 100) / 10} s for download lock`);
    if (r) downloadWaits.push(Math.round(r.waitedMs / 100) / 10);
    return r ? r.path : null;
  } catch (e) {
    if (e instanceof PS.Interrupted || e instanceof DL.LockTimeout) throw e;
    if (/^more than one download landed/.test(e?.message ?? "")) throw new Fail(1, e.message, "inspect the output folder manually");
    throw e;
  }
}

async function pageBytes(page, url) {
  const b64 = await page.evaluate(async (u) => {
    const buf = new Uint8Array(await (await fetch(u)).arrayBuffer());
    let bin = "";
    for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode(...buf.subarray(k, k + 0x8000));
    return btoa(bin);
  }, url);
  return Buffer.from(b64, "base64");
}

async function saveMedia(page, dir, target, url, click) {
  let viaBlob = null, blobErr = null;
  try {
    viaBlob = await pageBytes(page, url);
  } catch (e) {
    blobErr = String(e?.message ?? e).slice(0, 160);
  }
  let dl = null, dlErr = null;
  try {
    dl = await cdpDownload(page, dir, click, target);
    if (!dl) dlErr = "no file landed within 60 s";
  } catch (e) {
    if (e instanceof Fail || e instanceof PS.Interrupted) throw e;
    dlErr = String(e?.message ?? e).slice(0, 160);
  }
  if (dl) {
    const got = await fsp.readFile(target);
    const crosscheck = viaBlob
      ? { against: "blob", match: sha256(got) === sha256(viaBlob) }
      : { against: null, match: false, note: `blob fetch failed: ${blobErr}` };
    if (viaBlob && !crosscheck.match) warnings.push(`${target}: download (${got.length} B) and blob (${viaBlob.length} B) differ; kept download`);
    return { method: "download", buf: got, crosscheck };
  }
  if (!viaBlob) throw new Fail(1, `could not save media: download ${dlErr}; blob ${blobErr}`, "inspect the page in ego-browser");
  await fsp.writeFile(target, viaBlob);
  warnings.push(`download path failed (${dlErr}); saved from in-page blob`);
  return { method: "blob", buf: viaBlob, crosscheck: { against: null, match: false, note: `download failed: ${dlErr}` } };
}

async function attachYoutube(page, url) {
  const chips = () => page.evaluate(() => [...document.querySelectorAll(".prompt-media-item-container")].map((c) => c.innerText.replace(/\s+/g, " ").trim()));
  const before = (await chips()).filter((c) => /YouTube Video/.test(c)).length;
  await page.evaluate(() => document.querySelector('button[aria-label^="Insert"]')?.click());
  if (!(await page.waitForSelector('button[aria-label="YouTube Video"]', { timeout: 5000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape");
    throw uiChanged("Insert menu item YouTube Video missing");
  }
  await page.evaluate(() => document.querySelector('button[aria-label="YouTube Video"]').click());
  await need(page, 'input[aria-label="YouTube URL"]', "YouTube URL input", 8000);
  await page.fill('input[aria-label="YouTube URL"]', url);
  await sleep(1500);
  const saved = await page.evaluate(() => {
    const inp = document.querySelector('input[aria-label="YouTube URL"]');
    let root = inp;
    for (let i = 0; i < 12 && root && ![...root.querySelectorAll("button")].some((b) => b.innerText.trim() === "Save"); i++) root = root.parentElement;
    const b = root && [...root.querySelectorAll("button")].find((x) => x.innerText.trim() === "Save");
    if (!b) return "missing";
    if (b.disabled) return `disabled: ${root.innerText.replace(/\s+/g, " ").slice(0, 200)}`;
    b.click();
    return "clicked";
  });
  if (saved === "missing") throw uiChanged("YouTube dialog Save button missing");
  if (saved !== "clicked") {
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Cancel")?.click());
    throw new Fail(2, `YouTube dialog refused URL (${saved})`, "check that the URL opens a public video");
  }
  const deadline = Date.now() + 120000;
  for (;;) {
    const c = (await chips()).filter((x) => /YouTube Video/.test(x));
    const dialog = await exists(page, 'input[aria-label="YouTube URL"]');
    const tok = c.length > before ? /([\d,]+) tokens/.exec(c[c.length - 1]) : null;
    if (tok && !dialog) return { url, tokens: Number(tok[1].replace(/,/g, "")) };
    if (Date.now() > deadline) {
      const t = dialog ? await page.evaluate(() => document.querySelector('input[aria-label="YouTube URL"]').closest(".cdk-overlay-pane, .mat-mdc-dialog-container")?.innerText.replace(/\s+/g, " ").slice(0, 200)) : null;
      throw new Fail(1, `no YouTube chip with token count after 120 s${t ? ` (dialog: ${t})` : ""}`, "check that the video is public and not too long");
    }
    await sleep(700);
  }
}

const finalImages = (page, fromTurn) => page.evaluate((from) => {
  const out = [];
  const turns = [...document.querySelectorAll("ms-chat-turn")];
  for (let i = from; i < turns.length; i++) {
    for (const img of turns[i].querySelectorAll("ms-image-chunk img.loaded-image")) {
      if (img.closest("mat-expansion-panel") || img.closest("ms-thought-chunk")) continue;
      img.setAttribute("data-aistudio-img", String(out.length));
      out.push({ turn: i, src: img.src, w: img.naturalWidth, h: img.naturalHeight, complete: img.complete, alt: img.alt });
    }
  }
  return out;
}, fromTurn);

async function imageSetting(page, label, want) {
  const sel = `[role="combobox"][aria-label="${label}"]`;
  if (!(await exists(page, sel))) throw uiChanged(`image setting ${label} missing (${sel})`);
  const cur = await page.evaluate((s) => document.querySelector(s).innerText.trim().split("\n")[0], sel);
  if (cur !== want) {
    const opts = await comboOptions(page, sel);
    if (!opts.includes(want)) throw new Fail(2, `this model offers ${label} ${opts.join(", ")}; not ${want}`, `pass one of: ${opts.join(", ")}`, { offered: opts });
    if (!(await pickOption(page, sel, want))) throw uiChanged(`${label} option ${want} could not be clicked`);
  }
  const got = await page.evaluate((s) => document.querySelector(s).innerText.trim().split("\n")[0], sel);
  if (got !== want) throw new Fail(3, `${label} did not read back: wanted ${want}, got ${got}`, "update image setting selectors", { wanted: want, got });
  return got;
}

async function cmdImage(page, req) {
  if (req.chat) {
    await goto(page, req.chat);
    if (!(await page.waitForSelector("ms-chat-turn", { timeout: 30000 }).then(() => true, () => false))) {
      throw new Fail(2, `no chat turns at ${req.chat}`, "check the id in https://aistudio.google.com/library");
    }
  } else {
    const url = await goto(page, `${ORIGIN}/prompts/new_chat?model=${encodeURIComponent(req.model)}`);
    if (/generate-speech/.test(url)) throw new Fail(2, `${req.model} is a speech model`, "use the speech command");
  }
  await need(page, SEL.modelId, "model card");
  await sleep(1500);
  const card = await page.evaluate((s) => document.querySelector(s)?.innerText.trim(), SEL.modelId);
  if (card !== req.model) {
    throw new Fail(2, req.chat ? `chat uses ${card}, not ${req.model}` : `page opened ${card}, not ${req.model} (unknown id?)`, req.chat ? `pass --model ${card}` : "run `aistudio models` for available ids", { shown: card });
  }
  const settings = {};
  if (req.aspect) settings.aspect = await imageSetting(page, "Aspect ratio", req.aspect);
  if (req.size) settings.size = await imageSetting(page, "Resolution", req.size);
  for (const label of ["Aspect ratio", "Resolution"]) {
    const k = label === "Resolution" ? "size" : "aspect";
    settings[k] ??= await page.evaluate((s) => document.querySelector(s)?.innerText.trim().split("\n")[0] ?? null, `[role="combobox"][aria-label="${label}"]`);
  }
  const net = collector(page);
  await page.cdp("Network.enable", { maxTotalBufferSize: 200000000, maxResourceBufferSize: 50000000 });
  const attached = await attachFiles(page, req.attach);
  const turnsBefore = (await turnInfo(page)).length;
  await fillPrompt(page, req.prompt);
  const run = await runAndWait(page, net, req.timeoutS, turnsBefore);
  const chat = req.chat ?? (await waitSaved(page));
  const { out: bs, errors } = await bodies(page, run.requests);
  if (errors.length) warnings.push(`network bodies: ${errors.join("; ")}`);
  const parsed = P.parseBodies(bs);
  const finish = parsed.available ? parsed.finish : "unknown";
  let imgs = [];
  const deadline = Date.now() + 60000;
  for (;;) {
    imgs = await finalImages(page, turnsBefore);
    if (imgs.length && imgs.every((i) => i.complete && i.w > 0)) break;
    if (Date.now() > deadline) break;
    await sleep(1000);
  }
  const base = { cmd: "image", chat, model: card, settings, attached, finish, finishRaw: parsed.available ? parsed.finishRaw : null, usage: parsed.available ? parsed.usage : null, text: parsed.available ? parsed.text.slice(0, 2000) : null };
  if (!imgs.length) {
    const exit = P.exitForFinish(finish) || 1;
    throw new Fail(exit, `no final image in answer (finish ${finish})`, exit === 5 ? "rephrase the prompt" : "inspect the chat in ego-browser", { ...base, files: [] });
  }
  await fsp.mkdir(req.outDir, { recursive: true });
  const stem = `gemini-image-${localStamp()}`;
  const files = [];
  for (const [n, img] of imgs.entries()) {
    const tmpTarget = await freshName(req.outDir, `${stem}-${n + 1}`, "part");
    const s = await saveMedia(page, req.outDir, tmpTarget, img.src, () => page.evaluate((k) => {
      const el = document.querySelector(`img[data-aistudio-img="${k}"]`);
      el.scrollIntoView({ block: "center" });
      const b = el.closest("ms-image-chunk")?.querySelector('button[aria-label="Download"]');
      if (!b) throw new Error("image Download button missing");
      b.click();
    }, n));
    const dims = P.imageDims(s.buf);
    const ext = dims ? (dims.type === "jpeg" ? "jpg" : dims.type) : "bin";
    const path = await freshName(req.outDir, `${stem}-${n + 1}`, ext);
    await fsp.rename(tmpTarget, path);
    if (!dims) warnings.push(`${path}: not a JPEG, PNG or WebP by header bytes`);
    if (dims && img.w && (dims.width !== img.w || dims.height !== img.h)) warnings.push(`${path}: file is ${dims.width}x${dims.height}, page shows ${img.w}x${img.h}`);
    files.push({ path, bytes: s.buf.length, width: dims?.width ?? null, height: dims?.height ?? null, format: dims?.type ?? null, sha256: sha256(s.buf), method: s.method, crosscheck: s.crosscheck });
  }
  const exit = P.exitForFinish(finish) === 6 ? 6 : 0;
  return { ok: exit === 0, exit, ...base, count: files.length, files, outDir: req.outDir, ...(exit === 6 ? { error: "answer truncated at max output tokens", next: "returned images were saved" } : {}) };
}

const TTS_BLOCK = 'textarea[placeholder="<gasp> That\'s a great idea! <laugh> (Type \'<\' for tags)"]';
const TTS_AUDIO = "section.footer ms-music-player audio";

async function speakerLine(page) {
  return page.evaluate(() => {
    const m = document.body.innerText.match(/Speaker 1\s*-\s*([A-Za-z][A-Za-z -]*)/);
    return m ? m[1].trim() : null;
  });
}

async function pickVoice(page, name) {
  if ((await speakerLine(page)) === name) return name;
  await page.evaluate(() => document.querySelector('button[aria-label="Open voice settings"]')?.click());
  await need(page, 'input[placeholder^="Search"][placeholder$="voices"]', "voice search box", 10000);
  await page.fill('input[placeholder^="Search"][placeholder$="voices"]', name);
  const sel = `button[aria-label="${name}"]`;
  if (!(await page.waitForSelector(sel, { timeout: 10000 }).then(() => true, () => false))) {
    await page.evaluate((s) => document.querySelector(s)?.click(), SEL.closePanel);
    throw new Fail(2, `no voice named ${name} in voice search`, "pass a voice name listed in the voice panel");
  }
  await page.evaluate((s) => document.querySelector(s).click(), sel);
  await sleep(1200);
  if (await exists(page, 'input[placeholder^="Search"][placeholder$="voices"]')) await page.evaluate((s) => document.querySelector(s)?.click(), SEL.closePanel);
  await sleep(800);
  const got = await speakerLine(page);
  if (got !== name) throw new Fail(3, `voice did not read back: wanted ${name}, got ${got}`, "update voice selectors", { wanted: name, got });
  return got;
}

async function cmdSpeech(page, req) {
  const url = await goto(page, `${ORIGIN}/generate-speech?model=${encodeURIComponent(req.model)}`);
  if (!/\/generate-speech/.test(url)) throw new Fail(2, `${req.model} did not open the speech page (landed on ${url.split("?")[0]})`, "pass a TTS model id such as gemini-3.8-flash-tts");
  if (!(await page.waitForSelector(TTS_BLOCK, { timeout: 4000 }).then(() => true, () => false))) {
    await need(page, 'text="Create new dialog"', "Create new dialog card");
    await page.click('text="Create new dialog"', { label: "create new speech dialog" });
    await need(page, TTS_BLOCK, "speech block textarea", 15000);
  }
  const shownModel = new URL(await page.url()).searchParams.get("model");
  if (shownModel && shownModel !== req.model) throw new Fail(2, `speech page uses ${shownModel}, not ${req.model}`, "pass a TTS model id from `aistudio models`");
  const voice = req.voice ? await pickVoice(page, req.voice) : await speakerLine(page);
  const net = collector(page, /MakerSuiteService\/[A-Za-z]+$/);
  await page.cdp("Network.enable", { maxTotalBufferSize: 200000000, maxResourceBufferSize: 50000000 });
  const srcBefore = await page.evaluate((s) => document.querySelector(s)?.src ?? "", TTS_AUDIO);
  const speechText = lf(req.text);
  await page.fill(TTS_BLOCK, speechText);
  const typed = await page.evaluate((s) => document.querySelector(s).value, TTS_BLOCK);
  if (typed !== speechText) throw new Fail(3, `speech text did not read back (${typed.length} of ${speechText.length} chars)`, "update speech selectors");
  await net.pull();
  net.reset();
  await page.evaluate((s) => document.querySelector(s).focus(), TTS_BLOCK);
  checkpoint("the speech key");
  markSent();
  await page.keyboard.press("ControlOrMeta+Enter");
  const deadline = Date.now() + req.timeoutS * 1000;
  const errs = new Set();
  let len = -1, since = 0, started = false;
  for (;;) {
    await sleep(1000);
    const s = await page.evaluate((a) => {
      const el = document.querySelector(a);
      const err = [...document.querySelectorAll("mat-snack-bar-container, .mdc-snackbar, .model-error, [class*=error-message]")].map((e) => e.innerText.trim().replace(/\s+/g, " ").slice(0, 300)).filter(Boolean);
      const stop = [...document.querySelectorAll("button, span")].some((e) => e.childElementCount === 0 && e.textContent.trim() === "Stop");
      return { src: el?.src ?? "", err, stop };
    }, TTS_AUDIO);
    for (const e of s.err) errs.add(e);
    await net.pull();
    if (s.src !== srcBefore && s.src.length > 1000) started = true;
    if (started) {
      if (s.src.length !== len) {
        len = s.src.length;
        since = Date.now();
      } else if (Date.now() - since >= 4000 && !s.stop) break;
    } else if (net.generate().some((g) => g.status != null && g.status !== 200) || (errs.size && P.exitForUiError([...errs].join(" | ")) === 4)) {
      await limitCheck(page, net.generate(), errs);
      throw new Fail(1, `speech failed: ${[...errs].join(" | ")}`, "inspect the page in ego-browser", { uiText: [...errs].join(" | ") });
    }
    if (Date.now() > deadline) throw new Fail(1, started ? `audio kept growing past ${req.timeoutS} s` : `no audio within ${req.timeoutS} s`, "pass a larger --timeout or shorter text");
  }
  await limitCheck(page, net.generate(), errs);
  const genReqs = net.generate().filter((g) => GENERATE.test(g.url ?? "") && g.done && !g.failed);
  let usage = null, finish = null;
  if (genReqs.length) {
    const { out: bs } = await bodies(page, genReqs);
    const parsed = P.parseBodies(bs);
    if (parsed.available) ({ usage, finish } = parsed);
  }
  const src = await page.evaluate((a) => document.querySelector(a).src, TTS_AUDIO);
  const footer = await page.evaluate(() => document.querySelector("section.footer")?.innerText.replace(/\s+/g, " ").trim() ?? null);
  const dir = req.out.replace(/\/[^/]+$/, "");
  const tmp = await freshName(dir, req.out.replace(/^.*\//, "").replace(/\.wav$/i, ""), "part");
  const s = await saveMedia(page, dir, tmp, src, () => page.evaluate(() => {
    const b = document.querySelector('section.footer button[aria-label="Download"]');
    if (!b) throw new Error("speech footer Download button missing");
    b.click();
  }));
  await fsp.rename(tmp, req.out);
  const info = P.wavInfo(s.buf);
  if (!info) throw new Fail(1, `saved audio is not PCM WAV (${s.buf.length} bytes)`, "inspect the file", { out: req.out });
  return {
    ok: true, exit: 0, cmd: "speech", model: req.model, voice, chars: speechText.length, finish, usage,
    requests: net.generate().map((g) => `${(g.url ?? "").split("/").pop()} ${g.status ?? "?"}`),
    out: req.out, bytes: s.buf.length, duration: info.seconds, sampleRate: info.sampleRate, channels: info.channels, bits: info.bits,
    footer, method: s.method, crosscheck: s.crosscheck, chat: null,
  };
}

const treePaths = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[role="tree"] [role="treeitem"]')].map((r) => ({
    name: ((l) => (l.length > 1 ? l[1] : l[0] ?? ""))(r.innerText.split("\n").map((x) => x.trim()).filter(Boolean)),
    level: Number(r.getAttribute("aria-level") || 1),
  })).filter((r) => r.name);
  const out = [], stack = [];
  rows.forEach((r, i) => {
    stack.length = r.level - 1;
    const folder = i + 1 < rows.length && rows[i + 1].level > r.level;
    if (folder) stack[r.level - 1] = r.name;
    else out.push([...stack.slice(0, r.level - 1), r.name].join("/"));
  });
  return out;
});

async function cmdBuildExport(page, req) {
  await goto(page, req.app);
  const appId = req.app.split("/").pop();
  if (!(await page.waitForSelector('button[aria-label="Export options"], button[aria-label="Code"]', { timeout: 60000 }).then(() => true, () => false))) {
    throw new Fail(2, `no Build app at ${req.app}`, "check the app id in https://aistudio.google.com/apps");
  }
  if (!(await exists(page, 'button[aria-label="Export options"]'))) {
    await page.evaluate(() => document.querySelector('button[aria-label="Code"]').click());
    await need(page, 'button[aria-label="Export options"]', "Export options button", 20000);
  }
  await page.waitForSelector('[role="tree"] [role="treeitem"]', { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  const tree = await treePaths(page);
  await fsp.mkdir(req.outDir, { recursive: true });
  let zip;
  try {
    zip = await cdpDownload(page, req.outDir, async () => {
      await page.evaluate(() => document.querySelector('button[aria-label="Export options"]').click());
      await page.waitForSelector('[role="menuitem"]', { timeout: 5000 }).catch(() => {});
      const items = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.innerText.replace(/\s+/g, " ").trim()));
      const zipItems = items.filter((t) => t.includes("Download as .zip"));
      if (zipItems.length !== 1) {
        await page.keyboard.press("Escape");
        throw uiChanged(`Export menu: expected one "Download as .zip" item, saw: ${items.join(" | ")}`);
      }
      await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.innerText.includes("Download as .zip") && !/GitHub|Antigravity/.test(m.innerText)).click());
    }, () => freshName(req.outDir, `app-${appId}`, "zip"), req.timeoutS * 1000);
  } catch (e) {
    if (e instanceof DL.LockTimeout) throw new Fail(1, `${e.message}; zip was not downloaded`, "another space is downloading or lock leaked; retry or restart ego-browser");
    throw e;
  }
  if (!zip) throw new Fail(1, `no zip landed in ${req.outDir} within ${req.timeoutS} s`, "inspect the Export menu in ego-browser");
  const bytes = (await fsp.stat(zip)).size;
  return { ok: true, exit: 0, cmd: "build-export", app: req.app, outDir: req.outDir, zip, zipBytes: bytes, tree };
}

let result;
let activePage = null;
try {
  if (REQ.cmd === "close") result = await cmdClose(REQ);
  else {
    const { task, page } = await openSpace(REQ.space);
    activePage = page;
    note(`space ${REQ.space} id ${task.spaceId} page ${page.label}`);
    if (REQ.cmd === "check") result = await cmdCheck(page);
    else if (REQ.cmd === "models") result = await cmdModels(page);
    else if (REQ.cmd === "run") result = await cmdRun(page, REQ);
    else if (REQ.cmd === "send") result = await cmdSend(page, REQ);
    else if (REQ.cmd === "get") result = await cmdGet(page, REQ);
    else if (REQ.cmd === "image") result = await cmdImage(page, REQ);
    else if (REQ.cmd === "speech") result = await cmdSpeech(page, REQ);
    else if (REQ.cmd === "build-export") result = await cmdBuildExport(page, REQ);
    else throw new Fail(2, `command ${REQ.cmd} is not supported`, "run `aistudio help`");
  }
} catch (e) {
  if (e instanceof Fail) {
    note(`${e.message}\nnext: ${e.next}`);
    result = { ok: false, exit: e.exit, cmd: REQ.cmd, error: e.message, next: e.next, ...e.extra };
  } else if (e instanceof PS.Interrupted) {
    note(e.message);
    result = {
      ok: false, exit: 1, cmd: REQ.cmd, interrupted: true, error: e.message,
      next: sent ? "request was sent; chat may still save on the site (History)" : "nothing was sent; run again",
    };
  } else {
    const msg = String(e?.stack ?? e?.message ?? e);
    const user = /hand(ed)?[ -]?off|delegated|permission prompt|waitForControl|user has control/i.test(msg);
    note(msg);
    result = user
      ? { ok: false, exit: 7, cmd: REQ.cmd, error: msg.split("\n")[0].slice(0, 300), next: "space needs user action in ego-browser; run again after handing back" }
      : { ok: false, exit: 1, cmd: REQ.cmd, error: msg.split("\n")[0].slice(0, 300), next: "read stderr above; run again or report the error" };
  }
} finally {
  life.stop();
}

const endRead = await P.endChatRead({ cmd: REQ.cmd, page: activePage, result, sent, warnings, waited: savedWaitRan });
if (endRead) {
  result = endRead.result;
  warnings.splice(0, warnings.length, ...endRead.warnings);
  if (result.chatSaved === false && result.ok) note(`chat link missing at end\nnext: ${result.next}`);
}
if (["run", "send", "image", "speech"].includes(REQ.cmd) && typeof result.sent !== "boolean") result.sent = sent;
if (uiTexts.size && !result.uiText) result.uiText = [...uiTexts].join(" | ").slice(0, 1000);
if (httpStatus != null && result.httpStatus == null) result.httpStatus = httpStatus;
if (downloadWaits.length) result.downloadLockWaitS = downloadWaits;
if (warnings.length) result.warnings = warnings;
result.elapsedS = Math.round((Date.now() - t0) / 100) / 10;
print(result);
