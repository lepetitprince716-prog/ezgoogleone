// Piped into `ego-browser nodejs` with `const REQ = {...};` prepended by cli.ts.
const ORIGIN = "https://gemini.google.com/app";
const PROMPT_SEL = 'div[contenteditable="true"], [aria-label="Enter a prompt for Gemini"]';
const PICKER_BTN = 'button[aria-label*="Open mode picker"]';
const TOOLS_BTN = 'button[aria-label="Upload & tools"]';
const STOP_BTN = 'button[aria-label="Stop response"]';

const t0 = Date.now();
const note = (...a) => console.error(...a);

class Fail extends Error {
  constructor(exit, message, next, extra = {}) {
    super(message);
    this.exit = exit;
    this.next = next;
    this.extra = extra;
  }
}

async function openSpace(name) {
  const entry = (await listTaskSpaces()).find((s) => s.name === name);
  if (entry && entry.ownership !== "agent") {
    throw new Fail(7, `space ${name} (id ${entry.id}) is held by the user (${entry.ownership})`, "hand back or close the space in ego-browser");
  }
  const task = entry ? await taskSpace(entry.id) : await taskSpace(name);
  let page = (await task.pages())[0];
  if (!page) {
    const tabs = await task.tabs();
    page = tabs.length ? await task.adopt(tabs[0].page) : await task.newPage();
  }
  return { task, page };
}

async function gotoGemini(page, url) {
  await page.goto(url, { timeout: 45000 });
  await page.waitForTimeout(2200);
  const at = await page.url();
  if (/accounts\.google\.com/.test(at)) {
    throw new Fail(7, "not signed in: redirected to accounts.google.com", "sign in to Google inside ego-browser, then run again");
  }
  return at;
}

async function ensureModelAndThinking(page, modelLabel, thinkLabel) {
  if (!modelLabel && !thinkLabel) return { model: null, thinking: null };
  const openPicker = async () => {
    await page.click(PICKER_BTN, { label: "open Gemini mode picker" });
    await page.waitForTimeout(550);
  };

  await openPicker();
  if (modelLabel) {
    const initial = await page.evaluate((mLabel) => {
      const items = [...document.querySelectorAll('gem-menu-item[role="menuitemradio"]')];
      const target = items.find((el) => (el.innerText || "").includes(mLabel));
      const offered = items.map((el) => (el.innerText || "").split("\n")[0].trim()).filter(Boolean);
      return { found: !!target, checked: target ? target.getAttribute("aria-checked") === "true" : false, offered };
    }, modelLabel);
    if (!initial.found) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Fail(2, `model option not found in mode picker: ${modelLabel}`, `pass one of the picker labels: ${initial.offered.join(", ")}`, { offered: initial.offered });
    }
    if (!initial.checked) {
      await page.click(`gem-menu-item[role="menuitemradio"]:has-text("${modelLabel}")`, { label: `select ${modelLabel}` });
      await page.waitForTimeout(600);
    }
  }

  if (thinkLabel) {
    if (!(await page.evaluate(() => !!document.querySelector('[role="menu"]')))) await openPicker();
    const hasThinking = await page.evaluate(() =>
      [...document.querySelectorAll("gem-menu-item")].some((el) => (el.innerText || "").includes("Thinking level"))
    );
    if (!hasThinking) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Fail(2, "current Gemini Web model does not expose Thinking level", "omit --thinking or select a thinking-capable model");
    }
    await page.click('gem-menu-item:has-text("Thinking level")', { label: "expand Thinking level" });
    await page.waitForTimeout(550);
    await page.click(`gem-menu-item[role="menuitemradio"]:has-text("${thinkLabel}")`, { label: `lock Thinking level ${thinkLabel}` });
    await page.waitForTimeout(600);
  }

  if (!(await page.evaluate(() => !!document.querySelector('[role="menu"]')))) await openPicker();
  if (thinkLabel) {
    const expanded = await page.evaluate((tLabel) =>
      [...document.querySelectorAll('gem-menu-item[role="menuitemradio"]')].some((el) => (el.innerText || "").split("\n")[0].trim() === tLabel),
      thinkLabel
    );
    if (!expanded) {
      await page.click('gem-menu-item:has-text("Thinking level")', { label: "verify Thinking level" });
      await page.waitForTimeout(450);
    }
  }

  const verified = await page.evaluate(({ mLabel, tLabel }) => {
    const radios = [...document.querySelectorAll('gem-menu-item[role="menuitemradio"]')];
    const mNode = mLabel ? radios.find((el) => (el.innerText || "").includes(mLabel)) : null;
    const tNode = tLabel ? radios.find((el) => (el.innerText || "").split("\n")[0].trim() === tLabel) : null;
    return {
      model: mLabel,
      modelChecked: mLabel ? mNode?.getAttribute("aria-checked") === "true" : true,
      thinking: tLabel,
      thinkingChecked: tLabel ? tNode?.getAttribute("aria-checked") === "true" : true,
    };
  }, { mLabel: modelLabel, tLabel: thinkLabel });

  // Clicking the active radio item dismisses Gemini's Angular mode-picker overlay cleanly.
  if (thinkLabel) {
    await page.click(`gem-menu-item[role="menuitemradio"]:has-text("${thinkLabel}")`, { label: "close mode picker" });
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await page.waitForTimeout(450);

  if (!verified.modelChecked || !verified.thinkingChecked) {
    throw new Fail(3, `failed to lock Gemini Web model/thinking: ${JSON.stringify(verified)}`, "update mode picker selectors in packages/gemini-web/src/page.mjs");
  }
  return verified;
}

async function enableDeepResearch(page) {
  const isDeepActive = () => page.evaluate(() => {
    const promptEl = document.querySelector('[aria-label="Enter a prompt for Gemini"]');
    if (promptEl && (promptEl.innerText || "").includes("What do you want to research")) return true;
    return [...document.querySelectorAll("button")].some((b) => {
      const a = (b.getAttribute("aria-label") || "").toLowerCase();
      return ((a.includes("deselect") || a.includes("close")) && a.includes("deep research")) || a.includes("sources, google search");
    });
  });

  if (await isDeepActive()) return true;
  await page.click(TOOLS_BTN, { label: "open Upload & tools" });
  await page.waitForTimeout(700);

  const visibleDirect = await page.evaluate(() => {
    const items = [...document.querySelectorAll('gem-menu-item[role="menuitemcheckbox"]')];
    const target = items.find((el) => (el.innerText || "").includes("Deep research"));
    if (!target) return false;
    const r = target.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!visibleDirect) {
    await page.hover('gem-menu-item:has-text("More tools")', { label: "open More tools submenu" });
    await page.waitForTimeout(700);
  }
  await page.click('gem-menu-item[role="menuitemcheckbox"]:has-text("Deep research")', { label: "enable Deep research" });
  await page.waitForTimeout(1000);
  if (!(await isDeepActive())) {
    throw new Fail(3, "Deep research toggle did not activate", "update Deep research selectors in packages/gemini-web/src/page.mjs");
  }
  return true;
}

async function extractMarkdownFrom(page, selectors, isReport = false) {
  return page.evaluate(({ selectors, isReport }) => {
    const stopBtn = document.querySelector('button[aria-label="Stop response"]');
    const stopVisible = stopBtn ? stopBtn.offsetParent !== null : false;
    const SKIP = new Set(["script", "style", "button", "svg", "mat-icon", "source-footnote", "sources-carousel-inline", "model-thoughts", "thought-process"]);
    const htmlToMd = (root) => {
      if (!root) return "";
      const walk = (node) => {
        if (node.nodeType === 3) return node.textContent || "";
        if (node.nodeType !== 1) return "";
        const tag = node.tagName.toLowerCase();
        if (SKIP.has(tag)) return "";
        const cls = String(node.className || "");
        if (cls.includes("thinking") || cls.includes("thought")) return "";
        if (tag === "h1") return "\n# " + kids(node).trim() + "\n\n";
        if (tag === "h2") return "\n## " + kids(node).trim() + "\n\n";
        if (tag === "h3") return "\n### " + kids(node).trim() + "\n\n";
        if (tag === "h4") return "\n#### " + kids(node).trim() + "\n\n";
        if (tag === "p") return kids(node).trim() + "\n\n";
        if (tag === "br") return "\n";
        if (tag === "strong" || tag === "b") return "**" + kids(node).trim() + "**";
        if (tag === "em" || tag === "i") return "*" + kids(node).trim() + "*";
        if (tag === "code") return node.parentElement?.tagName.toLowerCase() === "pre" ? node.textContent : "`" + node.textContent + "`";
        if (tag === "pre") return "\n```\n" + node.textContent.trim() + "\n```\n\n";
        if (tag === "li") return "- " + kids(node).trim().replace(/\n+/g, "\n  ") + "\n";
        if (tag === "ul" || tag === "ol") return "\n" + kids(node) + "\n";
        if (tag === "blockquote") return "\n> " + kids(node).trim().replace(/\n+/g, "\n> ") + "\n\n";
        if (tag === "table") {
          const rows = [...node.querySelectorAll("tr")];
          const lines = [];
          rows.forEach((tr, i) => {
            const cells = [...tr.querySelectorAll("th, td")].map((c) => (c.innerText || "").trim().replace(/\n+/g, " ").replace(/\|/g, "\\|"));
            if (cells.length) {
              lines.push("| " + cells.join(" | ") + " |");
              if (i === 0) lines.push("| " + cells.map(() => "---").join(" | ") + " |");
            }
          });
          return "\n" + lines.join("\n") + "\n\n";
        }
        if (tag === "a") {
          const href = node.getAttribute("href");
          const t = kids(node).trim();
          return href && href.startsWith("http") && t ? `[${t}](${href})` : t;
        }
        return kids(node);
      };
      const kids = (el) => {
        let out = "";
        for (const ch of el.childNodes) out += walk(ch);
        return out;
      };
      return walk(root).replace(/\n{3,}/g, "\n\n").trim();
    };

    const els = [...document.querySelectorAll(selectors)];
    let target = null;
    if (isReport) {
      let maxLen = 0;
      for (const el of els) {
        const t = el.innerText || "";
        if ((t.includes("这是该主题的研究方案") || t.includes("Here's the research plan")) && t.length < 2500) continue;
        if (t.length > maxLen) {
          maxLen = t.length;
          target = el;
        }
      }
    } else if (els.length) {
      target = els[els.length - 1];
    }
    const raw = target ? (target.innerText || "") : "";
    const md = target ? htmlToMd(target) : "";
    const panel = document.querySelector("deep-research-immersive-panel");
    return {
      url: location.href,
      title: document.title,
      stopVisible,
      count: els.length,
      reportLen: raw.length,
      panelLen: panel ? (panel.innerText || "").length : 0,
      md,
      raw,
      tail: (raw || (panel ? panel.innerText : document.body.innerText) || "").slice(-500),
    };
  }, { selectors, isReport });
}

let result;
try {
  if (REQ.cmd === "close") {
    const spaces = await listTaskSpaces();
    const closed = [], skipped = [];
    for (const name of REQ.spaces) {
      const e = spaces.find((s) => s.name === name);
      if (!e) { skipped.push({ space: name, why: "not open" }); continue; }
      if (e.ownership !== "agent") { skipped.push({ space: name, why: `with user (${e.ownership})` }); continue; }
      await (await taskSpace(e.id)).finish({ keep: [] });
      closed.push(name);
    }
    result = { ok: true, exit: 0, cmd: "close", closed, skipped };
  } else if (REQ.cmd === "check") {
    const { task, page } = await openSpace(REQ.space);
    try {
      const url = await gotoGemini(page, ORIGIN);
      const canaries = await page.evaluate(({ PICKER_BTN, PROMPT_SEL, TOOLS_BTN }) => ({
        modePicker: !!document.querySelector(PICKER_BTN),
        promptBox: !!document.querySelector(PROMPT_SEL),
        toolsButton: !!document.querySelector(TOOLS_BTN),
      }), { PICKER_BTN, PROMPT_SEL, TOOLS_BTN });
      const missing = Object.entries(canaries).filter(([, ok]) => !ok).map(([k]) => k);
      if (missing.length) throw new Fail(3, `Gemini Web UI canaries missing: ${missing.join(", ")}`, "update selectors in packages/gemini-web/src/page.mjs", { canaries });
      result = { ok: true, exit: 0, cmd: "check", url, canaries };
    } finally {
      await task.finish({ keep: [] });
    }
  } else if (REQ.cmd === "verify-lock") {
    const { task, page } = await openSpace(REQ.space);
    try {
      await gotoGemini(page, ORIGIN);
      const locked = await ensureModelAndThinking(page, REQ.modelLabel, REQ.thinkLabel);
      const deepResearchActive = REQ.deepResearch ? await enableDeepResearch(page) : false;
      result = { ok: true, exit: 0, cmd: "verify-lock", ...locked, deepResearchActive, url: await page.url() };
    } finally {
      await task.finish({ keep: [] });
    }
  } else if (REQ.cmd === "chat") {
    const { task, page } = await openSpace(REQ.space);
    try {
      await gotoGemini(page, REQ.url ?? ORIGIN);
      const locked = await ensureModelAndThinking(page, REQ.modelLabel, REQ.thinkLabel);
      const beforeCount = await page.evaluate(() => document.querySelectorAll("model-response .markdown, message-content .markdown, .markdown-main-panel").length);
      await page.click(PROMPT_SEL, { label: "focus Gemini prompt box" });
      await page.waitForTimeout(300);
      await page.keyboard.paste(REQ.prompt);
      await page.waitForTimeout(600);
      await page.press(PROMPT_SEL, "Enter");

      const deadline = Date.now() + REQ.timeoutS * 1000;
      let sawActivity = false, stableSince = 0, lastLen = -1, snap = null;
      for (;;) {
        await page.waitForTimeout(1000);
        snap = await extractMarkdownFrom(page, "model-response .markdown, message-content .markdown, .markdown-main-panel", false);
        if (snap.stopVisible || snap.count > beforeCount) sawActivity = true;
        if (sawActivity && !snap.stopVisible && snap.count > beforeCount && snap.reportLen > 0) {
          if (snap.reportLen === lastLen) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= 2000) break;
          } else {
            lastLen = snap.reportLen;
            stableSince = 0;
          }
        }
        if (Date.now() > deadline) {
          throw new Fail(1, `Gemini Web chat did not settle within ${REQ.timeoutS} s`, "pass a larger --timeout or inspect the tab in ego-browser");
        }
      }
      const body = snap.md.length >= snap.raw.length * 0.65 && snap.md.length > 0 ? snap.md : snap.raw;
      result = {
        ok: true, exit: 0, cmd: "chat", url: snap.url, title: snap.title, spaceId: task.spaceId,
        model: locked.model, thinking: locked.thinking, chars: body.length, _text: body,
      };
    } finally {
      await task.finish({ keep: REQ.keep ? ["p1"] : [] });
    }
  } else if (REQ.cmd === "deep-research:start") {
    const { task, page } = await openSpace(REQ.space);
    let keepTab = false;
    try {
      await gotoGemini(page, ORIGIN);
      const locked = await ensureModelAndThinking(page, REQ.modelLabel, REQ.thinkLabel);
      await enableDeepResearch(page);
      await page.click(PROMPT_SEL, { label: "focus Gemini prompt box" });
      await page.waitForTimeout(350);
      await page.keyboard.paste(REQ.prompt);
      await page.waitForTimeout(900);
      await page.press(PROMPT_SEL, "Enter");

      await page.waitForFunction(() => {
        const btns = [...document.querySelectorAll("button")];
        const startBtn = btns.find((b) => {
          const t = (b.innerText || "").trim();
          return t === "开始研究" || t === "Start research";
        });
        if (startBtn && !startBtn.disabled && startBtn.getAttribute("aria-disabled") !== "true") return true;
        const body = document.body.innerText || "";
        return body.includes("Starting research") || body.includes("正在研究");
      }, undefined, { timeout: 60000 }).catch(() => {});

      await page.waitForTimeout(1000);
      const startBtnText = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((el) => {
          const t = (el.innerText || "").trim();
          return (t === "开始研究" || t === "Start research") && !el.disabled && el.getAttribute("aria-disabled") !== "true";
        });
        return b ? (b.innerText || "").trim() : null;
      });
      let clickedStart = false;
      if (startBtnText) {
        await page.click(`button:text-is("${startBtnText}")`, { label: "click Start research" });
        clickedStart = true;
        await page.waitForTimeout(3000);
      }
      const finalUrl = await page.url();
      const tail = await page.evaluate(() => (document.body.innerText || "").slice(-400));
      keepTab = true;
      result = {
        ok: true, exit: 0, cmd: "deep-research:start", status: "running",
        spaceId: task.spaceId, url: finalUrl, clickedStart, ...locked, tail,
      };
    } finally {
      await task.finish({ keep: keepTab ? ["p1"] : [] });
    }
  } else if (REQ.cmd === "deep-research:check") {
    let task;
    if (REQ.spaceId !== null) {
      const entry = (await listTaskSpaces()).find((s) => s.id === REQ.spaceId);
      task = !entry
        ? await taskSpace(`${REQ.space}-check`)
        : entry.ownership === "user"
          ? await claimTaskSpace(REQ.spaceId)
          : entry.ownership === "agentDelegatedToUser"
            ? await takeOverTaskSpace(REQ.spaceId)
            : await taskSpace(REQ.spaceId);
    } else {
      task = await taskSpace(`${REQ.space}-check`);
    }
    let keepTab = REQ.spaceId !== null;
    try {
      const page = (await task.pages())[0] ?? (await task.adopt((await task.tabs())[0].page));
      if (REQ.url && !(await page.url()).includes(REQ.url)) {
        await gotoGemini(page, REQ.url);
      } else if (REQ.reload) {
        await page.reload({ timeout: 30000 });
        await page.waitForTimeout(4000);
      }
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => {
          const t = (b.innerText || b.getAttribute("aria-label") || "").trim();
          return t === "Open" || t === "打开" || t.includes("查看报告") || t.includes("View report");
        });
        if (btn) btn.click();
      });
      await page.waitForTimeout(1500);
      const snap = await extractMarkdownFrom(page, "deep-research-immersive-panel .markdown, immersive-editor .markdown, .markdown-main-panel", true);
      if (!snap.stopVisible && snap.reportLen > 2000) {
        const body = snap.md.length >= snap.reportLen * 0.65 && snap.md.length > 0 ? snap.md : snap.raw;
        keepTab = Boolean(REQ.keep);
        result = {
          ok: true, exit: 0, cmd: "deep-research:check", status: "done",
          spaceId: task.spaceId, url: snap.url, title: snap.title, chars: body.length,
          _text: `# ${snap.title}\n\n> Gemini Web Deep Research URL: ${snap.url}\n\n${body}\n`,
        };
      } else {
        keepTab = true;
        result = {
          ok: true, exit: 0, cmd: "deep-research:check", status: "running",
          spaceId: task.spaceId, url: snap.url, stopVisible: snap.stopVisible,
          panelLen: snap.panelLen, reportLen: snap.reportLen, tail: snap.tail,
        };
      }
    } finally {
      await task.finish({ keep: keepTab ? ["p1"] : [] });
    }
  } else {
    throw new Fail(2, `unsupported command: ${REQ.cmd}`, "run `gemini-web help`");
  }
} catch (e) {
  if (e instanceof Fail) {
    note(`${e.message}\nnext: ${e.next}`);
    result = { ok: false, exit: e.exit, cmd: REQ.cmd, error: e.message, next: e.next, ...e.extra };
  } else {
    const msg = String(e?.stack ?? e?.message ?? e);
    note(msg);
    const user = /hand(ed)?[ -]?off|delegated|permission prompt|waitForControl|user has control/i.test(msg);
    result = user
      ? { ok: false, exit: 7, cmd: REQ.cmd, error: msg.split("\n")[0].slice(0, 300), next: "complete user action in ego-browser and run again" }
      : { ok: false, exit: 1, cmd: REQ.cmd, error: msg.split("\n")[0].slice(0, 300), next: "read stderr above and run again" };
  }
}

result.elapsedS = Math.round((Date.now() - t0) / 100) / 10;
console.log(JSON.stringify(result));
