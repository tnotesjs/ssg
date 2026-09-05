import type { Plugin } from "vite";
import type { CompiledMarkdown } from "./markdown";
import type { NoteRef } from "./noteRoute";
import type { ResolvedSsgConfig, SidebarItem } from "./types";
import type { SourcePage } from "./pages";

const PAGES_ID = "\0virtual:tnotes-pages";
const SITE_ID = "\0virtual:tnotes-site";
const THEME_ID = "\0virtual:tnotes-theme";
// NB: no `\0` prefix — Vite's createFilter (used by plugin-vue's `include`)
// rejects null-byte ids, which would leave the SFC source uncompiled.
const PAGE_ID_PREFIX = "virtual:tnotes-page:";

const serializeSite = (
  site: ResolvedSsgConfig,
  sidebar: SidebarItem[],
  notes: NoteRef[],
) => ({
  base: site.base,
  title: site.title,
  description: site.description,
  lang: site.lang,
  discussions: site.discussions,
  sidebar,
  notes,
  markdown: {
    lineNumbers: site.markdown.lineNumbers,
    math: site.markdown.math,
    imageLazyLoading: site.markdown.imageLazyLoading,
  },
});

/**
 * Page modules are virtual modules whose ids end with `.vue` so plugin-vue
 * compiles them natively. Importing `file.md?route=…` breaks whenever a note
 * title ends with an extension-like suffix (`tsconfig.json.md` → route ends
 * with `.json`), because Vite core plugins match ids by trailing extension.
 */
export function tnotesPlugin(
  config: ResolvedSsgConfig,
  sidebar: SidebarItem[],
  sources: SourcePage[],
  compiled: Map<string, CompiledMarkdown>,
  notes: NoteRef[] = [],
): Plugin {
  const byRoute = new Map(
    sources.map((page) => [
      page.route,
      compiled.get(`${page.file}:${page.route}`)!,
    ]),
  );
  const pageId = (route: string) =>
    `${PAGE_ID_PREFIX}${encodeURIComponent(route)}.vue`;

  return {
    name: "tnotes-ssg",
    enforce: "pre",
    resolveId(id) {
      if (id === "virtual:tnotes-pages") return PAGES_ID;
      if (id === "virtual:tnotes-site") return SITE_ID;
      if (id === "virtual:tnotes-theme") return THEME_ID;
      if (id.startsWith(PAGE_ID_PREFIX)) return id;
    },
    load(id) {
      if (id === SITE_ID) {
        return `export default ${JSON.stringify(serializeSite(config, sidebar, notes))}`;
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
              `${JSON.stringify(page.route)}: () => import(${JSON.stringify(pageId(page.route))})`,
          )
          .join(",\n");
        const data = Object.fromEntries(
          sources.map((page) => [page.route, byRoute.get(page.route)!.data]),
        );
        return `export const pages = {${imports}}; export const pageData = ${JSON.stringify(data)};`;
      }
      if (id.startsWith(PAGE_ID_PREFIX)) {
        const route = decodeURIComponent(
          id.slice(PAGE_ID_PREFIX.length, -".vue".length),
        );
        return byRoute.get(route)?.vueSource;
      }
    },
  };
}
