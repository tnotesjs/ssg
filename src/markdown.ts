/**
 * src/markdown.ts
 *
 * The TNotes markdown pipeline: markdown-it + Vue SFC, shared code blocks,
 * custom containers, and the TNotes block set (mermaid / mindmap / footprints
 * / swiper). Snippet imports (`<<< path`) were removed by decision — all
 * content lives inside the note file.
 */

import path from "node:path";
import { componentPlugin } from "@mdit-vue/plugin-component";
import { frontmatterPlugin } from "@mdit-vue/plugin-frontmatter";
import { sfcPlugin } from "@mdit-vue/plugin-sfc";
import { highlightCodeSync, prepareCodeHighlighter } from "@tnotesjs/ui/code";
import {
  parseFootprintsDatetime,
  parseFootprintsSource,
} from "@tnotesjs/ui/footprints-parse";
import {
  normalizeMindmapMarkdown,
  parseMindmapFence,
} from "@tnotesjs/ui/mindmap-parse";
import GithubSlugger from "github-slugger";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import markdownItContainer from "markdown-it-container";
import { full as emoji } from "markdown-it-emoji";
import markdownItMathjax from "markdown-it-mathjax3";
import markdownItTaskLists from "markdown-it-task-lists";

import { resolveNoteSlug, type NoteRef } from "./noteRoute";
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

const toAbsoluteSpecifier = (specifier: string, fromFile: string) =>
  path
    .resolve(path.dirname(fromFile), specifier)
    .replaceAll("\\", "/");

/** Anchor relative import/export specifiers to the note file's directory. */
const resolveRelativeSpecifiers = (source: string, fromFile: string) =>
  source.replace(
    /(\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/gm,
    (whole, prefix: string, quote: string, specifier: string) =>
      `${prefix}${quote}${toAbsoluteSpecifier(specifier, fromFile)}${quote}`,
  );

const slugger = new GithubSlugger();
/** GitHub-style anchors — must stay identical to the legacy VitePress sites. */
function slugify(value: string) {
  slugger.reset();
  return slugger.slug(value);
}

function plainInline(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

export function collectCodeLanguages(sources: string[]) {
  const values = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/^\s*```([^\s{[]+)/gm)) {
      values.add(match[1].toLowerCase());
    }
  }
  return [...values];
}

/* ------------------------------ containers ------------------------------ */

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

/** Swiper container: image-only paragraphs become slides. */
function configureSwiperContainer(md: MarkdownIt, base: string) {
  let uid = 0;
  interface RuleStackItem {
    image: any;
    paragraphOpen: any;
    paragraphClose: any;
  }
  let stack: RuleStackItem[] = [];

  md.core.ruler.before("block", "tn_swiper_reset", () => {
    uid = 0;
    stack = [];
    return true;
  });

  md.use(markdownItContainer, "swiper", {
    render(tokens: any[], index: number) {
      if (tokens[index].nesting === 1) {
        stack.push({
          image: md.renderer.rules.image,
          paragraphOpen: md.renderer.rules.paragraph_open,
          paragraphClose: md.renderer.rules.paragraph_close,
        });
        md.renderer.rules.paragraph_open = () => "";
        md.renderer.rules.paragraph_close = () => "";
        md.renderer.rules.image = (tokens: any[], i: number) => {
          const token = tokens[i];
          const src = rewriteAssetSrc(token.attrGet("src") || "", base);
          const alt = token.content || "";
          const title = alt && alt.trim() ? alt : "img";
          return `<div class="swiper-slide" data-title="${escapeHtml(title)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></div>`;
        };
        const id = `tn-swiper-${++uid}`;
        return `\n<div class="tn-swiper" data-swiper-id="${id}">\n  <div class="tn-swiper-tabs"></div>\n  <div class="swiper-container">\n    <div class="swiper-wrapper">\n`;
      }
      const previous = stack.pop();
      md.renderer.rules.image = previous?.image;
      md.renderer.rules.paragraph_open = previous?.paragraphOpen;
      md.renderer.rules.paragraph_close = previous?.paragraphClose;
      return `\n    </div>\n  </div>\n</div>\n`;
    },
  });
}

/** `::: footprints 2025-01-22 23:47` → Footprints Vue block. */
function extractFootprintsPayload(tokens: any[], index: number) {
  const meta = String(tokens[index].info || "")
    .trim()
    .replace(/^footprints\s*/i, "");
  const times = parseFootprintsDatetime(meta);
  const paragraphs: string[] = [];
  const images: string[] = [];
  let otherInfo = "";
  let inOther = false;

  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "container_footprints_close") break;
    if (token.type !== "inline") continue;

    const childImages: string[] = [];
    if (Array.isArray(token.children)) {
      for (const child of token.children) {
        if (child.type === "image") {
          const src =
            child.attrGet?.("src") ??
            child.attrs?.find((a: string[]) => a[0] === "src")?.[1];
          if (src) childImages.push(src);
        }
      }
    }

    const content = String(token.content || "").trim();
    if (content === "---") {
      inOther = true;
      continue;
    }
    if (childImages.length) {
      const withoutImages = content.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim();
      if (!withoutImages) {
        images.push(...childImages);
        continue;
      }
    }
    const imageOnly = content.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (imageOnly) {
      images.push(imageOnly[2]);
      continue;
    }
    if (!content) continue;
    if (inOther) otherInfo = otherInfo ? `${otherInfo}\n${content}` : content;
    else paragraphs.push(content);
  }

  return { times, paragraphs, images, otherInfo };
}

function configureFootprintsContainer(md: MarkdownIt, base: string) {
  md.use(markdownItContainer, "footprints", {
    validate: (params: string) => /^footprints(\s|$)/i.test(params.trim()),
    render(tokens: any[], index: number, _options: unknown, env: any) {
      if (tokens[index].nesting !== 1) return "";

      let payload = extractFootprintsPayload(tokens, index);

      // Enrich from the raw source slice when token extraction missed content.
      const startLine = tokens[index].map?.[0] ?? 0;
      let endLine = startLine;
      for (let i = index + 1; i < tokens.length; i++) {
        if (tokens[i].type === "container_footprints_close") {
          endLine = tokens[i].map?.[0] ?? endLine;
          break;
        }
      }
      const raw = String(env?.src ?? env?.source ?? "");
      if (raw && endLine > startLine) {
        const slice = raw
          .split(/\r?\n/)
          .slice(startLine, endLine + 1)
          .join("\n");
        const fromSource = parseFootprintsSource(
          slice.includes(":::")
            ? slice
            : `::: ${tokens[index].info}\n${slice}\n:::`,
        );
        if (!payload.paragraphs.length && fromSource.paragraphs.length) {
          payload = { ...payload, paragraphs: fromSource.paragraphs };
        }
        if (!payload.images.length && fromSource.images.length) {
          payload = { ...payload, images: fromSource.images };
        }
        if (!payload.otherInfo && fromSource.otherInfo) {
          payload = { ...payload, otherInfo: fromSource.otherInfo };
        }
        if (!payload.times.length && fromSource.times.length) {
          payload = { ...payload, times: fromSource.times };
        }
      }

      for (let i = index + 1; i < tokens.length; i++) {
        if (tokens[i].type === "container_footprints_close") break;
        tokens[i].hidden = true;
        tokens[i].content = "";
        if (Array.isArray(tokens[i].children)) {
          for (const child of tokens[i].children) {
            child.hidden = true;
            child.content = "";
          }
          tokens[i].children = [];
        }
      }

      const openTag =
        `<Footprints :times="${bindJson(payload.times)}" :paragraphs="${bindJson(payload.paragraphs)}" :other-info="${bindJson(payload.otherInfo)}">`;
      if (!payload.images.length) return `${openTag}</Footprints>\n`;
      const imageSlot = payload.images
        .map(
          (src, i) =>
            `<img src="${escapeHtml(rewriteAssetSrc(src, base))}" @click="openModal(${i})" />`,
        )
        .join("\n");
      return `${openTag}\n<template #image-list="{ openModal }">\n${imageSlot}\n</template>\n</Footprints>\n`;
    },
  });
}

/* -------------------------------- fences --------------------------------- */

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

/** `mermaid` fence (with optional `center`); `mmd` shows the source. */
function configureMermaidFence(md: MarkdownIt) {
  const fence = md.renderer.rules.fence!.bind(md.renderer.rules);
  let uid = 0;
  md.core.ruler.before("block", "tn_mermaid_reset", () => {
    uid = 0;
    return true;
  });
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const parts = token.info.trim().split(/\s+/).filter(Boolean);
    if (parts[0] === "mermaid") {
      const centered = parts.slice(1).some((p) => p.toLowerCase() === "center");
      const id = `mermaid-${++uid}`;
      const centerAttr = centered ? ' :center="true"' : "";
      return `<Mermaid id="${id}" graph="${encodeURIComponent(token.content)}"${centerAttr} />`;
    }
    if (token.info.trim() === "mmd") {
      tokens[index].info = "mermaid";
    }
    return fence(tokens, index, options, env, self);
  };
}

/** Canonical `mindmap` fence. */
function configureMindmapFence(md: MarkdownIt) {
  const fence = md.renderer.rules.fence!.bind(md.renderer.rules);
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const fenceOptions = parseMindmapFence(token.info.trim());
    if (!fenceOptions) return fence(tokens, index, options, env, self);
    const content = normalizeMindmapMarkdown(token.content, {
      title: fenceOptions.title,
    });
    const props = [
      `content="${encodeURIComponent(content.trim())}"`,
      fenceOptions.initialExpandLevel === undefined
        ? ""
        : `:initialExpandLevel="${fenceOptions.initialExpandLevel}"`,
    ]
      .filter(Boolean)
      .join(" ");
    return `<Mindmap ${props}></Mindmap>\n`;
  };
}

/* ------------------------------ links/images ----------------------------- */

/** `../assets/x.png` / `./assets/x.png` → `<base>assets/x.png` (copied verbatim). */
function rewriteAssetSrc(src: string, base: string): string {
  const match = src.match(/^(?:\.\.\/|\.\/)assets\/(.+)$/);
  return match ? `${base}assets/${match[1]}` : src;
}

function rewriteNoteHref(href: string, notes: readonly NoteRef[], base: string) {
  const queryAt = href.search(/[?#]/);
  const pathPart = queryAt < 0 ? href : href.slice(0, queryAt);
  const suffix = queryAt < 0 ? "" : href.slice(queryAt);
  const slug = pathPart
    .replace(/\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .pop();
  if (!slug) return null;
  const route = resolveNoteSlug(slug, notes);
  return route ? `${base}${route.slice(1)}${suffix}` : null;
}

function configureLinks(
  md: MarkdownIt,
  base: string,
  notes: readonly NoteRef[],
) {
  const fallback = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const hrefIndex = token.attrIndex("href");
    if (hrefIndex >= 0) {
      const href = token.attrs![hrefIndex][1];
      const canonical = rewriteNoteHref(href, notes, base);
      if (canonical) {
        token.attrs![hrefIndex][1] = canonical;
      } else if (href.startsWith("/") && !href.startsWith("//")) {
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

function configureImages(md: MarkdownIt, base: string, lazy: boolean) {
  const fallback = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const srcIndex = token.attrIndex("src");
    if (srcIndex >= 0) {
      token.attrs![srcIndex][1] = rewriteAssetSrc(
        token.attrs![srcIndex][1],
        base,
      );
    }
    if (lazy) token.attrSet("loading", "lazy");
    return fallback
      ? fallback(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
}

/* ------------------------------- compiler -------------------------------- */

export async function createMarkdownCompiler(
  config: ResolvedSsgConfig,
  notes: readonly NoteRef[] = [],
) {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  // Save the raw source for container fallbacks (footprints).
  md.core.ruler.before("normalize", "save-source", (state) => {
    (state.env as MarkdownEnvironment).source = state.src;
    return true;
  });
  md.use(componentPlugin);
  md.use(frontmatterPlugin);
  md.use(sfcPlugin);
  md.use(anchor, { slugify });
  md.use(emoji);
  md.use(markdownItTaskLists, { enabled: true, label: true });
  if (config.markdown.math) md.use(markdownItMathjax);
  configureContainers(md);
  configureSwiperContainer(md, config.base);
  configureFootprintsContainer(md, config.base);
  configureLinks(md, config.base, notes);
  configureImages(md, config.base, config.markdown.imageLazyLoading);
  configureCodeBlocks(md, config.markdown.lineNumbers);
  configureMermaidFence(md);
  configureMindmapFence(md);

  return {
    async prepare(sources: string[]) {
      await prepareCodeHighlighter(collectCodeLanguages(sources));
    },
    compile(
      raw: string,
      file: string,
      route: string,
      titleHint?: string,
    ): CompiledMarkdown {
      const env: MarkdownEnvironment = { source: raw };
      const html = md.render(raw, env);
      const parsed = matter(raw);
      const titleMatch = raw.match(/^#\s+(.+)$/m);
      const title = plainInline(
        String(titleHint || parsed.data.title || titleMatch?.[1] || route),
      );
      const description = String(parsed.data.description ?? "");
      const headings = [...raw.matchAll(/^#{2,6}\s+(.+)$/gm)].map((match) =>
        match[1].replace(/[*_`]/g, "").trim(),
      );
      const text = parsed.content
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#>*_`[\]()!-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const relativePath = path
        .relative(config.root, file)
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
      // Page modules are virtual (see vitePlugin), so relative specifiers in
      // hoisted SFC blocks must be anchored to the note file's directory.
      const scripts =
        env.sfcBlocks?.scripts.map((item) =>
          resolveRelativeSpecifiers(item.content, file),
        ) ?? [];
      const styles =
        env.sfcBlocks?.styles.map((item) =>
          item.content.replace(
            /@import\s+(['"])(\.{1,2}\/[^'"]+)\1/g,
            (whole, quote: string, specifier: string) =>
              `@import ${quote}${toAbsoluteSpecifier(specifier, file)}${quote}`,
          ),
        ) ?? [];
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
      return { vueSource, html, data, links };
    },
  };
}
