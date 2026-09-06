import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import MiniSearch from "minisearch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSite, previewSite } from "../src/site";
import {
  normalizeSearchTerm,
  tokenizeSearch,
} from "../src/client/search";

let root = "";

function write(relativePath: string, content: string) {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tnotes-ssg-site-"));
  write(
    "tnotes.json",
    JSON.stringify(
      {
        base: "/fixture/",
        title: "Fixture",
        description: "SSG fixture",
      },
      null,
      2,
    ),
  );
  write(
    "TOC.md",
    `- 分组 A
  - [x] 0001. 首页笔记
  - [ ] 0002. 指南
`,
  );
  write(
    "LocalMessage.vue",
    `<script setup lang="ts">defineProps<{ text: string }>()</script>
<template><strong class="local-message">{{ text }}</strong></template>`,
  );
  write(
    "notes/0001. 首页笔记.md",
    `---
id: 00000000-0000-4000-8000-000000000001
description: 首页描述
---
<script setup>
import LocalMessage from '../LocalMessage.vue'
const message = 'Vue SFC works'
</script>

# 首页笔记

<LocalMessage :text="message" />

[阅读指南](./0002.%20指南.md)

![图片](../assets/pic.txt) {w=50%}

![](../assets/pic.txt)
`,
  );
  write(
    "notes/0002. 指南.md",
    `---
id: 00000000-0000-4000-8000-000000000002
---
# 指南

[回首页](/)

::: tip 提示
容器管线正常。搜索中文。
:::

$x^2$

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`mindmap
- 根
  - 子
\`\`\`

::: footprints 2026-09-06 12:00
一段足迹正文。
:::
`,
  );
  write("assets/pic.txt", "asset file");
  write("public/fixture.txt", "public asset");

  await buildSite(root);
}, 120_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const dist = (...segments: string[]) =>
  path.join(root, ".tnotes/dist", ...segments);

describe("static site build", () => {
  it("renders the first TOC note as home and every note at its route", () => {
    const home = fs.readFileSync(dist("index.html"), "utf8");
    expect(home).toContain("Vue SFC works");
    expect(home).toContain("首页笔记");
    // Canonical note route is /notes/{n}.
    const noteHtml = fs.readFileSync(dist("notes/1.html"), "utf8");
    expect(noteHtml).toContain("Vue SFC works");
    // Cross-note links rewrite to the canonical /notes/{n} form.
    expect(home).toContain('href="/fixture/notes/2"');
    // Asset references are rewritten to base-absolute (assets/ copied verbatim).
    expect(home).toContain('src="/fixture/assets/pic.txt"');
    expect(home).toContain('<figure class="tn-image">');
    expect(home).toContain("<figcaption>图片</figcaption>");
    expect(home).toContain("width:50%");
    expect(fs.existsSync(dist("404.html"))).toBe(true);
  });

  it("renders the TOC sidebar with done markers", () => {
    const home = fs.readFileSync(dist("index.html"), "utf8");
    expect(home).toContain("分组 A");
    expect(home).toContain("✅ 0001. 首页笔记");
    expect(home).toContain("⏰ 0002. 指南");
  });

  it("renders the TNotes block set", () => {
    const guide = fs.readFileSync(dist("notes/2.html"), "utf8");
    expect(guide).toContain("tn-custom-block tip");
    expect(guide).toContain("tn-mermaid");
    expect(guide).toMatch(/tn-mindmap|mindmap/i);
    expect(guide).toContain("一段足迹正文。");
    expect(guide).toContain("mjx"); // mathjax
  });

  it("copies library assets and public files into dist", () => {
    expect(fs.readFileSync(dist("assets/pic.txt"), "utf8")).toBe("asset file");
    expect(fs.readFileSync(dist("fixture.txt"), "utf8")).toBe("public asset");
  });

  it("emits a serialized local-search index", () => {
    const serialized = fs.readFileSync(dist("search-index.json"), "utf8");
    const index = JSON.parse(serialized) as { documentCount: number };
    // Home + its note route are deduplicated.
    expect(index.documentCount).toBe(2);
    const search = MiniSearch.loadJSON(serialized, {
      fields: ["title", "headings", "text"],
      storeFields: ["route", "title", "text"],
      tokenize: tokenizeSearch,
      processTerm: normalizeSearchTerm,
    });
    expect(search.search("首页笔记")[0]?.route).toBe("/");
    expect(search.search("中文")[0]?.route).toBe("/notes/2");
    expect(search.search("草稿")).toHaveLength(0);
  });

  it("serves the generated site under its configured base", async () => {
    const server = await previewSite(root, { port: 0, host: "127.0.0.1" });
    try {
      const address = server.httpServer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing preview port");
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("首页笔记");
      const guide = await fetch(
        `http://127.0.0.1:${address.port}/fixture/notes/2`,
      );
      expect(guide.status).toBe(200);
      expect(await guide.text()).toContain("提示");
      const alias = await fetch(
        `http://127.0.0.1:${address.port}/fixture/notes/0001.%20首页笔记`,
        { redirect: "manual" },
      );
      expect(alias.status).toBe(302);
      expect(alias.headers.get("location")).toBe("/fixture/notes/1");
      const byId = await fetch(
        `http://127.0.0.1:${address.port}/fixture/notes/00000000-0000-4000-8000-000000000001`,
        { redirect: "manual" },
      );
      expect(byId.status).toBe(302);
      expect(byId.headers.get("location")).toBe("/fixture/notes/1");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("dead links", () => {
  it("fails a build when an internal target does not exist", async () => {
    const invalidRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "tnotes-ssg-deadlink-"),
    );
    try {
      const w = (rel: string, content: string) => {
        const file = path.join(invalidRoot, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      w("TOC.md", "- [ ] 0001. 首页\n");
      w("notes/0001. 首页.md", "# 首页\n\n[缺失](./0002. 不存在.md)\n");
      await expect(buildSite(invalidRoot)).rejects.toThrow("dead link");
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true });
    }
  });

  it("does not fail when fenced code looks like a markdown link", async () => {
    const validRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "tnotes-ssg-codelink-"),
    );
    try {
      const w = (rel: string, content: string) => {
        const file = path.join(validRoot, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      };
      w("TOC.md", "- [ ] 0001. 首页\n");
      w(
        "notes/0001. 首页.md",
        "# 首页\n\n```ts\nif (prefix === '[' && suffix.startsWith('](')) {}\n```\n",
      );
      await buildSite(validRoot);
    } finally {
      fs.rmSync(validRoot, { recursive: true, force: true });
    }
  });
});
