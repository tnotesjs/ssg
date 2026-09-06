import { describe, expect, it } from "vitest";

import {
  collectCodeLanguages,
  createMarkdownCompiler,
  extractMarkdownLinks,
} from "../src/markdown";

const compilerConfig = {
  root: "/",
  outDir: "/",
  cacheDir: "/",
  publicDir: "/",
  base: "/",
  title: "t",
  description: "",
  lang: "zh",
  port: 0,
  discussions: false,
  ignoreDeadLinks: true,
  head: [] as Array<[string, Record<string, string>, string?]>,
  markdown: { lineNumbers: false, math: false, imageLazyLoading: false },
};

describe("Markdown compatibility helpers", () => {
  it("collects only fenced-code languages needed by a site", () => {
    expect(
      collectCodeLanguages([
        "```ts\nconst value = 1\n```",
        "```TS\nconst other = 2\n```\n```python\npass\n```",
        "```mermaid\ngraph TD\n```",
      ]).sort(),
    ).toEqual(["mermaid", "python", "ts"]);
  });

  it("does not treat markdown-like text inside code as a link", () => {
    expect(
      extractMarkdownLinks(
        [
          "[真实](./0002.%20指南.md)",
          "",
          "```ts",
          "if (prefix === '[' && suffix.startsWith('](')) {}",
          "const href = '[x](./missing.md)'",
          "```",
          "",
          "`[内联](./no.md)`",
        ].join("\n"),
      ),
    ).toEqual(["./0002.%20指南.md"]);
  });

  it("renders standalone image width, caption, and alignment", async () => {
    const compiler = await createMarkdownCompiler(compilerConfig);
    const { html } = compiler.compile(
      "![说明](../assets/pic.png) {w=50% align=center}\n",
      "n.md",
      "/n",
      "n",
    );
    expect(html).toContain('class="tn-image tn-image--center"');
    expect(html).toContain('style="width:50%;max-width:100%"');
    expect(html).toContain("width:100%");
    expect(html).toContain("<figcaption>说明</figcaption>");
  });

  it("renders tip/info/warning/danger/details as typed custom blocks", async () => {
    const compiler = await createMarkdownCompiler(compilerConfig);
    const { html } = compiler.compile(
      [
        "::: tip 💡 TIP\n\nbody\n\n:::",
        "::: info\n\ninfo\n\n:::",
        "::: warning\n\nwarn\n\n:::",
        "::: danger\n\nerr\n\n:::",
        "::: details 细节\n\nhidden\n\n:::",
      ].join("\n\n"),
      "n.md",
      "/n",
      "n",
    );
    expect(html).toContain('class="tn-custom-block tip"');
    expect(html).toContain('class="tn-custom-block info"');
    expect(html).toContain('class="tn-custom-block warning"');
    expect(html).toContain('class="tn-custom-block danger"');
    expect(html).toContain('<details class="tn-custom-block details">');
    expect(html).toContain("<summary>细节</summary>");
  });

  it("exposes structured outline headings with github-style ids", async () => {
    const compiler = await createMarkdownCompiler(compilerConfig);
    const { html, data } = compiler.compile(
      ["# 标题", "", "## 建议按这个顺序点", "", "### 小节", ""].join("\n"),
      "n.md",
      "/n",
      "n",
    );
    expect(data.headings).toEqual([
      { text: "建议按这个顺序点", level: 2, id: "建议按这个顺序点" },
      { text: "小节", level: 3, id: "小节" },
    ]);
    expect(html).toContain('id="建议按这个顺序点"');
    expect(html).toContain('id="小节"');
  });
});
