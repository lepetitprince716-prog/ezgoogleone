const SKIP_TAGS = new Set([
  "script", "style", "button", "svg", "mat-icon", "source-footnote",
  "sources-carousel-inline", "model-thoughts", "thought-process",
]);

export function nodeToMarkdown(root) {
  if (!root) return "";
  const walk = (node) => {
    if (!node) return "";
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const tag = String(node.tagName || "").toLowerCase();
    if (SKIP_TAGS.has(tag)) return "";
    const cls = String(node.className || "");
    if (cls.includes("thinking") || cls.includes("thought")) return "";
    if (tag === "h1") return "\n# " + children(node).trim() + "\n\n";
    if (tag === "h2") return "\n## " + children(node).trim() + "\n\n";
    if (tag === "h3") return "\n### " + children(node).trim() + "\n\n";
    if (tag === "h4") return "\n#### " + children(node).trim() + "\n\n";
    if (tag === "p") return children(node).trim() + "\n\n";
    if (tag === "br") return "\n";
    if (tag === "strong" || tag === "b") return "**" + children(node).trim() + "**";
    if (tag === "em" || tag === "i") return "*" + children(node).trim() + "*";
    if (tag === "code") {
      if (node.parentElement && String(node.parentElement.tagName || "").toLowerCase() === "pre") {
        return node.textContent || "";
      }
      return "`" + (node.textContent || "") + "`";
    }
    if (tag === "pre") return "\n```\n" + String(node.textContent || "").trim() + "\n```\n\n";
    if (tag === "li") return "- " + children(node).trim().replace(/\n+/g, "\n  ") + "\n";
    if (tag === "ul" || tag === "ol") return "\n" + children(node) + "\n";
    if (tag === "blockquote") return "\n> " + children(node).trim().replace(/\n+/g, "\n> ") + "\n\n";
    if (tag === "table") {
      const rows = node.querySelectorAll ? [...node.querySelectorAll("tr")] : [];
      const lines = [];
      rows.forEach((tr, i) => {
        const cells = [...tr.querySelectorAll("th, td")].map((c) =>
          String(c.innerText ?? c.textContent ?? "").trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")
        );
        if (cells.length) {
          lines.push("| " + cells.join(" | ") + " |");
          if (i === 0) lines.push("| " + cells.map(() => "---").join(" | ") + " |");
        }
      });
      return "\n" + lines.join("\n") + "\n\n";
    }
    if (tag === "a") {
      const href = node.getAttribute ? node.getAttribute("href") : null;
      const t = children(node).trim();
      if (href && href.startsWith("http") && t) return `[${t}](${href})`;
      return t;
    }
    return children(node);
  };
  const children = (el) => {
    let out = "";
    for (const ch of el.childNodes || []) out += walk(ch);
    return out;
  };
  return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}

export function selectBestReport(candidates) {
  let best = null;
  for (const c of candidates) {
    const raw = String(c.raw || "");
    if ((raw.includes("这是该主题的研究方案") || raw.includes("Here's the research plan")) && raw.length < 2500) {
      continue;
    }
    if (!best || raw.length > best.raw.length) best = c;
  }
  return best;
}

export function chooseReportBody(md, raw) {
  const m = String(md || "").trim();
  const r = String(raw || "").trim();
  return m.length >= r.length * 0.65 && m.length > 0 ? m : r;
}
