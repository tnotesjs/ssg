import fs from "node:fs";
import path from "node:path";
import { componentPlugin } from "@mdit-vue/plugin-component";
import { frontmatterPlugin } from "@mdit-vue/plugin-frontmatter";
import { sfcPlugin } from "@mdit-vue/plugin-sfc";
import { highlightCodeSync, prepareCodeHighlighter } from "@tnotesjs/ui/code";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import markdownItContainer from "markdown-it-container";
import { full as emoji } from "markdown-it-emoji";
import markdownItMathjax from "markdown-it-mathjax3";
import markdownItTaskLists from "markdown-it-task-lists";

import type { PageData, ResolvedSsgConfig } from "./types";

interface MarkdownEnvironment {
  frontmatter?: Record<string, unknown>;
  sfcBlocks?: {
    scripts: Array<{ content: string }>;
    styles: Array<{ content: string }>;
    customBlocks: Array<{ content: string }>;
  };
  source?: string;
}

export interface CompiledMarkdown {
  vueSource: string;
  html: string;
  data: PageData;
  links: string[];
  includes: string[];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const values: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return values[character];
  });

const bindJson = (value: unknown) =>
  `JSON.parse(decodeURIComponent('${encodeURIComponent(JSON.stringify(value)).replace(/'/g, "%27")}'))`;

function slugify(value: string) {
  return encodeURIComponent(
    value
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, "-"),
  );
}

function plainInline(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function parseLines(source: string, range = "") {
  if (!range) return source;
  const lines = source.split(/\r?\n/);
  const selected: string[] = [];
  for (const part of range.split(",")) {
    const [startValue, endValue] = part.split("-");
    const start = Math.max(1, Number(startValue));
    const end = Math.min(lines.length, Number(endValue ?? startValue));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    selected.push(...lines.slice(start - 1, end));
  }
  return selected.join("\n");
}

export function resolveSnippetIncludes(
  source: string,
  file: string,
  root: string,
): { source: string; includes: string[] } {
  const includes: string[] = [];
  const next = source.replace(
    /^(\s*)<<<\s+([^\s{[]+)(?:\{([^}]+)\})?(?:\s+\[([^\]]+)\])?\s*$/gm,
    (
      _match,
      indent: string,
      request: string,
      range: string,
      language: string,
    ) => {
      const filename = request.startsWith("@/")
        ? path.resolve(root, request.slice(2))
        : path.resolve(path.dirname(file), request);
      if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
        throw new Error(`Snippet not found: ${request} (${file})`);
      }
      includes.push(filename);
      const inferred = path.extname(filename).slice(1) || "text";
      const code = parseLines(fs.readFileSync(filename, "utf8"), range);
      return `${indent}\`\`\`${language || inferred} [${path.basename(filename)}]\n${code}\n${indent}\`\`\``;
    },
  );
  return { source: next, includes };
}

export function collectCodeLanguages(sources: string[]) {
  const values = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/^\s*```([^\s{[]+)/gm)) {
      values.add(match[1].toLowerCase());
    }
    for (const match of source.matchAll(
      /^\s*<<<\s+([^\s{[]+)(?:\{[^}]+\})?(?:\s+\[([^\]]+)\])?\s*$/gm,
    )) {
      const inferred = path.extname(match[1]).slice(1) || "text";
      values.add((match[2] || inferred).toLowerCase());
    }
  }
  return [...values];
}

function configureContainers(md: MarkdownIt) {
  for (const name of ["info", "tip", "warning", "danger", "details"]) {
    md.use(markdownItContainer, name, {
      render(tokens: any[], index: number) {
        const token = tokens[index];
        if (token.nesting === -1) {
          return name === "details" ? "</details>\n" : "</div>\n";
        }
        const rawTitle = String(token.info || "")
          .replace(name, "")
          .trim();
        const title = escapeHtml(
          rawTitle || (name === "details" ? "详情" : name.toUpperCase()),
        );
        return name === "details"
          ? `<details class="tn-custom-block details"><summary>${title}</summary>\n`
          : `<div class="tn-custom-block ${name}"><p class="tn-custom-block-title">${title}</p>\n`;
      },
    });
  }

  md.use(markdownItContainer, "code-group", {
    render(tokens: any[], index: number) {
      if (tokens[index].nesting === -1) return "</CodeGroup>\n";
      const items: Array<{ info: string }> = [];
      let itemIndex = 0;
      for (let i = index + 1; i < tokens.length; i++) {
        if (tokens[i].type === "container_code-group_close") break;
        if (tokens[i].type !== "fence") continue;
        tokens[i].meta ??= {};
        tokens[i].meta.tnCodeGroupIndex = itemIndex++;
        items.push({ info: tokens[i].info });
      }
      return `<CodeGroup :items="${bindJson(items)}">\n`;
    },
  });
}

function configureCodeBlocks(md: MarkdownIt, lineNumbers: boolean) {
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const highlighted = highlightCodeSync(token.content, token.info);
    const block = `<CodeBlock :code="${bindJson(token.content)}" :info="${bindJson(token.info)}" :line-numbers="${lineNumbers}" :highlighted-html="${bindJson(highlighted)}" />`;
    return token.meta?.tnCodeGroupIndex === undefined
      ? `${block}\n`
      : `<div class="tn-code-group__panel" role="tabpanel">${block}</div>\n`;
  };
}

function configureLinks(md: MarkdownIt, base: string) {
  const fallback = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const hrefIndex = token.attrIndex("href");
    if (hrefIndex >= 0) {
      const href = token.attrs![hrefIndex][1];
      if (href.startsWith("/") && !href.startsWith("//")) {
        token.attrs![hrefIndex][1] = `${base}${href.slice(1)}`.replace(
          /\.md(?=([?#]|$))/i,
          "",
        );
      } else if (/^https?:\/\//.test(href)) {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noreferrer");
      } else {
        token.attrs![hrefIndex][1] = href.replace(/\.md(?=([?#]|$))/i, "");
      }
    }
    return fallback
      ? fallback(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
}

function configureImages(md: MarkdownIt, lazy: boolean) {
  if (!lazy) return;
  const fallback = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    tokens[index].attrSet("loading", "lazy");
    return fallback
      ? fallback(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
}

export async function createMarkdownCompiler(config: ResolvedSsgConfig) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(componentPlugin);
  md.use(frontmatterPlugin);
  md.use(sfcPlugin);
  md.use(anchor, { slugify: config.markdown.slugify ?? slugify });
  md.use(emoji);
  md.use(markdownItTaskLists, { enabled: true, label: true });
  if (config.markdown.math !== false) md.use(markdownItMathjax);
  configureContainers(md);
  configureLinks(md, config.base);
  configureImages(md, config.markdown.imageLazyLoading !== false);
  config.markdown.configure?.(md);
  configureCodeBlocks(md, config.markdown.lineNumbers !== false);

  return {
    async prepare(sources: string[]) {
      await prepareCodeHighlighter(collectCodeLanguages(sources));
    },
    compile(raw: string, file: string, route: string): CompiledMarkdown {
      const resolved = resolveSnippetIncludes(raw, file, config.root);
      const env: MarkdownEnvironment = { source: resolved.source };
      const html = md.render(resolved.source, env);
      const parsed = matter(resolved.source);
      const titleMatch = resolved.source.match(/^#\s+(.+)$/m);
      const folder = path
        .basename(path.dirname(file))
        .replace(/^\d{4}\.\s*/, "");
      const title = plainInline(
        String(parsed.data.title ?? titleMatch?.[1] ?? folder),
      );
      const description = String(parsed.data.description ?? "");
      const headings = [...resolved.source.matchAll(/^#{2,6}\s+(.+)$/gm)].map(
        (match) => match[1].replace(/[*_`]/g, "").trim(),
      );
      const text = parsed.content
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#>*_`[\]()!-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const relativePath = path
        .relative(config.srcDir, file)
        .replaceAll("\\", "/");
      const data: PageData = {
        route,
        relativePath,
        title,
        description,
        headings,
        text,
        frontmatter: parsed.data,
      };
      const scripts = env.sfcBlocks?.scripts.map((item) => item.content) ?? [];
      const styles = env.sfcBlocks?.styles.map((item) => item.content) ?? [];
      const customBlocks =
        env.sfcBlocks?.customBlocks.map((item) => item.content) ?? [];
      const pageExport = `<script>export const __pageData = ${JSON.stringify(data)}; export default { name: ${JSON.stringify(relativePath)} }</script>`;
      const vueSource = [
        pageExport,
        ...scripts,
        `<template><div class="tn-prose">${html}</div></template>`,
        ...styles,
        ...customBlocks,
      ].join("\n");
      const links = [
        ...raw.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g),
      ].map((match) => match[1]);
      return { vueSource, html, data, links, includes: resolved.includes };
    },
  };
}
