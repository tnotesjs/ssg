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
    "tnotes.config.mts",
    `export default {
      base: "/fixture/",
      title: "Fixture",
      description: "SSG fixture",
      markdown: { math: true },
    }`,
  );
  write(
    "LocalMessage.vue",
    `<script setup lang="ts">defineProps<{ text: string }>()</script>
<template><strong class="local-message">{{ text }}</strong></template>`,
  );
  write("sample.ts", "const first = 1;\nconst second = 2;\nconst third = 3;\n");
  write(
    "index.md",
    `---
title: Fixture Home
description: Fixture description
---
<script setup>
import LocalMessage from './LocalMessage.vue'
const message = 'Vue SFC works'
</script>

# Fixture Home

<LocalMessage :text="message" />

[Read the guide](./guide.md)

<<< ./sample.ts{1-2} [typescript]
`,
  );
  write(
    "guide.md",
    `# Guide

[Home](/)

::: tip Shared shell
The container pipeline works. 搜索中文。
:::

$x^2$
`,
  );
  write("public/fixture.txt", "public asset");

  await buildSite(root);
}, 60_000);

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("static site build", () => {
  it("renders Vue-in-Markdown, snippets and base-prefixed assets", () => {
    const html = fs.readFileSync(
      path.join(root, ".tnotes/dist/index.html"),
      "utf8",
    );
    expect(html).toContain("Vue SFC works");
    expect(html).toContain("tn-code-block");
    // Shiki splits tokens into spans; assert on the stripped text content.
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("const first = 1;");
    expect(text).toContain("const second = 2;");
    // Snippet import is ranged ({1-2}); line 3 must not leak in.
    expect(text).not.toContain("const third");
    expect(html).toContain('href="./guide"');
    expect(html).toMatch(/src="\/fixture\/assets\//);
    expect(fs.existsSync(path.join(root, ".tnotes/dist/guide.html"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, ".tnotes/dist/404.html"))).toBe(true);
    expect(
      fs.readFileSync(path.join(root, ".tnotes/dist/fixture.txt"), "utf8"),
    ).toBe("public asset");
  });

  it("emits a serialized local-search index", () => {
    const serialized = fs.readFileSync(
      path.join(root, ".tnotes/dist/search-index.json"),
      "utf8",
    );
    const index = JSON.parse(serialized) as { documentCount: number };
    expect(index.documentCount).toBe(2);
    const search = MiniSearch.loadJSON(serialized, {
      fields: ["title", "headings", "text"],
      storeFields: ["route", "title", "text"],
      tokenize: tokenizeSearch,
      processTerm: normalizeSearchTerm,
    });
    expect(search.search("Fixture")[0]?.route).toBe("/");
    expect(search.search("中文")[0]?.route).toBe("/guide");
  });

  it("serves the generated site under its configured base", async () => {
    const server = await previewSite(root, { port: 0, host: "127.0.0.1" });
    try {
      const address = server.httpServer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing preview port");
      const response = await fetch(`http://127.0.0.1:${address.port}/fixture/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Fixture Home");
      const guide = await fetch(
        `http://127.0.0.1:${address.port}/fixture/guide`,
      );
      expect(guide.status).toBe(200);
      expect(await guide.text()).toContain("Shared shell");
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
      fs.writeFileSync(
        path.join(invalidRoot, "index.md"),
        "# Home\n\n[Missing](./missing.md)\n",
      );
      await expect(buildSite(invalidRoot)).rejects.toThrow("dead link");
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true });
    }
  });
});
