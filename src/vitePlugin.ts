import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";
import type { CompiledMarkdown } from "./markdown";
import type { ResolvedSsgConfig } from "./types";
import type { SourcePage } from "./pages";

const PAGES_ID = "\0virtual:tnotes-pages";
const SITE_ID = "\0virtual:tnotes-site";
const THEME_ID = "\0virtual:tnotes-theme";

const canonicalFile = (file: string) =>
  fs.existsSync(file) ? fs.realpathSync.native(file) : path.resolve(file);

const serializeSite = (site: ResolvedSsgConfig) => ({
  ...site,
  markdown: {
    lineNumbers: site.markdown.lineNumbers,
    math: site.markdown.math,
    imageLazyLoading: site.markdown.imageLazyLoading,
  },
  ignoreDeadLinks: Boolean(site.ignoreDeadLinks),
});

export function tnotesPlugin(
  config: ResolvedSsgConfig,
  sources: SourcePage[],
  compiled: Map<string, CompiledMarkdown>,
): Plugin {
  const byFile = new Map(
    sources.map((page) => [canonicalFile(page.file), page]),
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
        return `export default ${JSON.stringify(serializeSite(config))}`;
      }
      if (id === THEME_ID) {
        return config.theme
          ? `export { default } from ${JSON.stringify(config.theme)}`
          : "export default {}";
      }
      if (id === PAGES_ID) {
        const imports = sources
          .map(
            (page) =>
              `${JSON.stringify(page.route)}: () => import(${JSON.stringify(page.file)})`,
          )
          .join(",\n");
        const data = Object.fromEntries(
          sources.map((page) => [page.route, compiled.get(page.file)!.data]),
        );
        return `export const pages = {${imports}}; export const pageData = ${JSON.stringify(data)};`;
      }
    },
    transform(_code, id) {
      if (!id.endsWith(".md")) return;
      const filename = canonicalFile(id.split("?")[0]);
      const page = byFile.get(filename);
      if (!page) return;
      return compiled.get(page.file)?.vueSource;
    },
    configureServer(server) {
      for (const result of compiled.values()) {
        for (const include of result.includes) server.watcher.add(include);
      }
    },
  };
}
