import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";
import type { CompiledMarkdown } from "./markdown";
import type { ResolvedSsgConfig, SidebarItem } from "./types";
import type { SourcePage } from "./pages";

const PAGES_ID = "\0virtual:tnotes-pages";
const SITE_ID = "\0virtual:tnotes-site";
const THEME_ID = "\0virtual:tnotes-theme";

const canonicalFile = (file: string) =>
  fs.existsSync(file) ? fs.realpathSync.native(file) : path.resolve(file);

const serializeSite = (
  site: ResolvedSsgConfig,
  sidebar: SidebarItem[],
) => ({
  base: site.base,
  title: site.title,
  description: site.description,
  lang: site.lang,
  discussions: site.discussions,
  sidebar,
  markdown: {
    lineNumbers: site.markdown.lineNumbers,
    math: site.markdown.math,
    imageLazyLoading: site.markdown.imageLazyLoading,
  },
});

export function tnotesPlugin(
  config: ResolvedSsgConfig,
  sidebar: SidebarItem[],
  sources: SourcePage[],
  compiled: Map<string, CompiledMarkdown>,
): Plugin {
  const byFile = new Map(
    sources.map((page) => [`${canonicalFile(page.file)}:${page.route}`, page]),
  );

  return {
    name: "tnotes-ssg",
    enforce: "pre",
    resolveId(id) {
      if (id === "virtual:tnotes-pages") return PAGES_ID;
      if (id === "virtual:tnotes-site") return SITE_ID;
      if (id === "virtual:tnotes-theme") return THEME_ID;
    },
    load(id) {
      if (id === SITE_ID) {
        return `export default ${JSON.stringify(serializeSite(config, sidebar))}`;
      }
      if (id === THEME_ID) {
        return config.theme
          ? `export { default } from ${JSON.stringify(config.theme)}`
          : "export default {}";
      }
      if (id === PAGES_ID) {
        const imports = sources
          .map((page) => {
            const specifier = `${page.file}?route=${encodeURIComponent(page.route)}`;
            return `${JSON.stringify(page.route)}: () => import(${JSON.stringify(specifier)})`;
          })
          .join(",\n");
        const data = Object.fromEntries(
          sources.map((page) => [
            page.route,
            compiled.get(`${page.file}:${page.route}`)!.data,
          ]),
        );
        return `export const pages = {${imports}}; export const pageData = ${JSON.stringify(data)};`;
      }
    },
    transform(_code, id) {
      const [file, query] = id.split("?");
      if (!file.endsWith(".md")) return;
      const route = new URLSearchParams(query ?? "").get("route");
      if (!route) return;
      const page = byFile.get(`${canonicalFile(file)}:${route}`);
      if (!page) return;
      return compiled.get(`${page.file}:${page.route}`)?.vueSource;
    },
  };
}
