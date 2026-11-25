import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, resolveModelLabel, resolveThinkingLabel, UsageError } from "../src/args.ts";
import { chooseReportBody, nodeToMarkdown, selectBestReport } from "../src/markdown.mjs";

const makeCtx = () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-web-args-"));
  return { dir, ctx: { cwd: dir, home: dir, now: new Date("2026-11-25T10:00:00Z"), pid: 1001, rand: "a1b2c3" } };
};

describe("gemini-web args", () => {
  test("resolves aliases and accepts custom picker labels", () => {
    expect(resolveModelLabel("neon")).toBe("4 Neon");
    expect(resolveModelLabel("carbon")).toBe("4 Carbon");
    expect(resolveModelLabel("2.5 Pro")).toBe("2.5 Pro");
    expect(resolveThinkingLabel("high")).toBe("High");
    expect(() => resolveThinkingLabel("ultra")).toThrow(UsageError);
  });

  test("parses chat, verify-lock, and deep-research start/check", () => {
    const { dir, ctx } = makeCtx();
    writeFileSync(join(dir, "q.md"), "Research prompt\r\n");

    const chat = parseArgs(["chat", "--prompt-file", "q.md", "--model", "carbon", "--thinking", "medium", "--out", "r.md"], ctx);
    expect(chat).toMatchObject({ cmd: "chat", prompt: "Research prompt\n", modelLabel: "4 Carbon", thinkLabel: "Medium", out: join(dir, "r.md") });

    const vl = parseArgs(["verify-lock", "--model", "neon", "--thinking", "high", "--deep-research"], ctx);
    expect(vl).toMatchObject({ cmd: "verify-lock", modelLabel: "4 Neon", thinkLabel: "High", deepResearch: true });

    const drStart = parseArgs(["deep-research", "start", "--prompt", "compare frameworks", "--model", "neon"], ctx);
    expect(drStart).toMatchObject({ cmd: "deep-research:start", modelLabel: "4 Neon", thinkLabel: "High" });

    const drCheck = parseArgs(["deep-research", "check", "--space-id", "42", "--out", "report.md", "--reload"], ctx);
    expect(drCheck).toMatchObject({ cmd: "deep-research:check", spaceId: 42, reload: true, out: join(dir, "report.md") });

    expect(() => parseArgs(["deep-research", "check", "--out", "r.md"], ctx)).toThrow(UsageError);
    expect(() => parseArgs(["chat", "--prompt", "hi", "--url", "https://example.com"], ctx)).toThrow(UsageError);
  });
});

describe("gemini-web markdown extraction", () => {
  test("converts DOM tree to markdown and strips thinking/footnotes", () => {
    const text = (s: string) => ({ nodeType: 3, textContent: s });
    const el = (tag: string, children: unknown[] = [], attrs: Record<string, string> = {}, className = "") => ({
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className,
      childNodes: children,
      getAttribute: (k: string) => attrs[k] ?? null,
    });
    const tree = el("div", [
      el("model-thoughts", [text("internal thought")]),
      el("h2", [text("Findings")]),
      el("p", [text("See "), el("a", [text("docs")], { href: "https://example.org" }), text(" and "), el("strong", [text("bench")])]),
      el("ul", [el("li", [text("Item one")]), el("li", [text("Item two")])]),
    ]);
    const md = nodeToMarkdown(tree);
    expect(md).toContain("## Findings");
    expect(md).toContain("See [docs](https://example.org) and **bench**");
    expect(md).toContain("- Item one");
    expect(md).not.toContain("internal thought");
  });

  test("filters short research plans and chooses best report body", () => {
    const best = selectBestReport([
      { raw: "Here's the research plan: 1. search", md: "plan" },
      { raw: "A".repeat(3000), md: "# Full Report\n\n" + "A".repeat(2800) },
    ]);
    expect(best?.raw.length).toBe(3000);
    expect(chooseReportBody("short", "A".repeat(100))).toBe("A".repeat(100));
    expect(chooseReportBody("B".repeat(90), "A".repeat(100))).toBe("B".repeat(90));
  });
});
