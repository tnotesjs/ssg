import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import MiniSearch from "minisearch";
import {
  build as viteBuild,
  createServer as createViteServer,
  preview as vitePreview,
  type PreviewServer,
} from "vite";

import { resolveConfig } from "./config";
import { normalizeSearchTerm, tokenizeSearch } from "./client/search";
import { createMarkdownCompiler, type CompiledMarkdown } from "./markdown";
import { collectSite, routeToOutput, type SourcePage } from "./pages";
import { tnotesPlugin } from "./vitePlugin";

import type { PageData, ResolvedSsgConfig } from "./types";
import type { ServerResponse } from "node:http";
import type { PreviewServerHook } from "vite";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const clientRoot = path.join(packageRoot, "src/client");
const packageRequire = createRequire(import.meta.url);

async function linkRuntimeDependencies(cacheDir: string) {
  const modulesDirectory = path.join(cacheDir, "node_modules");
  await fs.mkdir(modulesDirectory, { recursive: true });
  for (const dependency of ["vue", "@vue/server-renderer"]) {
    const target = path.dirname(
      packageRequire.resolve(`${dependency}/package.json`),
    );
    const link = path.join(modulesDirectory, dependency);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

function htmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const values: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return values[character];
  });
}

function renderHead(config: ResolvedSsgConfig) {
  return config.head
    .map(([tag, attrs, content = ""]) => {
      const serialized = Object.entries(attrs)
        .map(([name, value]) => ` ${name}="${htmlEscape(value)}"`)
        .join("");
      return content
        ? `<${tag}${serialized}>${content}</${tag}>`
        : `<${tag}${serialized}>`;
    })
    .join("\n");
}

function pageDocument(
  config: ResolvedSsgConfig,
  route: string,
  page: PageData,
  appHtml: string,
  dev: boolean,
) {
  const description = page.description || config.description;
  return `<!doctype html>
<html lang="${htmlEscape(config.lang)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${htmlEscape(description)}" />
    <title>${htmlEscape(page.title)} | ${htmlEscape(config.title)}</title>
    ${renderHead(config)}
    <script>try{const t=localStorage.getItem('tnotes-theme');const d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch{}</script>
  </head>
  <body>
    <div id="app" data-route="${htmlEscape(route)}">${appHtml}</div>
    <script type="module" src="/entry.ts"></script>
    ${
      dev
        ? `<script>new EventSource(${JSON.stringify(`${config.base}__tnotes_reload`)}).onmessage=event=>{if(event.data==='reload')location.reload()}</script>`
        : ""
    }
  </body>
</html>`;
}

function resolveInternalRoute(raw: string, currentRoute: string) {
  const value = decodeURIComponent(raw.split(/[?#]/)[0]).replace(
    /\.(md|html)$/i,
    "",
  );
  if (!value || value.startsWith("#")) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(value) || /^(mailto|tel):/i.test(value))
    return null;
  if (value.startsWith("/")) return value.replace(/\/$/, "") || "/";
  const base =
    currentRoute === "/" ? "/" : `${path.posix.dirname(currentRoute)}/`;
  const resolved = path.posix.resolve(base, value);
  return resolved.replace(/\/$/, "") || "/";
}

function validateDeadLinks(
  config: ResolvedSsgConfig,
  pages: SourcePage[],
  compiled: Map<string, CompiledMarkdown>,
) {
  if (config.ignoreDeadLinks === true) return;
  const routes = new Set(pages.map((page) => page.route));
  const ignores = Array.isArray(config.ignoreDeadLinks)
    ? config.ignoreDeadLinks
    : [];
  const errors: string[] = [];
  for (const page of pages) {
    for (const link of compiled.get(`${page.file}:${page.route}`)?.links ?? []) {
      const localFile = decodeURIComponent(link.split(/[?#]/)[0]);
      if (
        !localFile.startsWith("/") &&
        existsSync(path.resolve(path.dirname(page.file), localFile))
      ) {
        continue;
      }
      const route = resolveInternalRoute(link, page.route);
      if (!route || routes.has(route)) continue;
      if (ignores.some((ignore) => ignore === link)) continue;
      errors.push(`${path.relative(config.root, page.file)} -> ${link}`);
    }
  }
  if (errors.length) {
    throw new Error(
      `Found ${errors.length} dead link(s):\n${errors.join("\n")}`,
    );
  }
}

async function prepareBuild(config: ResolvedSsgConfig) {
  const { pages, sidebar, snapshot } = await collectSite(config);
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.severity === "error") {
      console.warn(`[kb] ${diagnostic.message}`);
    }
  }
  if (!pages.some((page) => page.route === "/404")) {
    const file = path.join(config.cacheDir, "404.md");
    const source = "# 页面未找到\n\n[返回首页](/)\n";
    await fs.writeFile(file, source);
    pages.push({ file, route: "/404", source, titleHint: "404", noteIndex: "" });
  }
  const compiler = await createMarkdownCompiler(config);
  await compiler.prepare(pages.map((page) => page.source));
  const compiled = new Map<string, CompiledMarkdown>();
  for (const page of pages) {
    compiled.set(
      `${page.file}:${page.route}`,
      compiler.compile(page.source, page.file, page.route, page.titleHint),
    );
  }
  validateDeadLinks(config, pages, compiled);
  return { pages, sidebar, compiled };
}

async function writeSearchIndex(
  config: ResolvedSsgConfig,
  pages: SourcePage[],
  compiled: Map<string, CompiledMarkdown>,
) {
  const search = new MiniSearch<PageData>({
    idField: "route",
    fields: ["title", "headings", "text"],
    storeFields: ["route", "title", "text"],
    tokenize: tokenizeSearch,
    processTerm: normalizeSearchTerm,
  });
  // The home note is emitted at both "/" and its /notes/... route — index the
  // first occurrence ("/") only.
  const seenFiles = new Set<string>();
  const documents = pages
    .filter((page) => page.route !== "/404")
    .filter((page) => {
      if (seenFiles.has(page.file)) return false;
      seenFiles.add(page.file);
      return true;
    })
    .map((page) => compiled.get(`${page.file}:${page.route}`)!.data);
  search.addAll(documents);
  await fs.writeFile(
    path.join(config.outDir, "search-index.json"),
    JSON.stringify(search),
  );
}

/** Library-level assets/ are referenced as ../assets/... — copy verbatim. */
async function copyAssets(config: ResolvedSsgConfig) {
  const source = path.join(config.root, "assets");
  if (!existsSync(source)) return;
  await fs.cp(source, path.join(config.outDir, "assets"), {
    recursive: true,
  });
}

export async function buildSite(
  root = process.cwd(),
  options: { dev?: boolean } = {},
) {
  const config = await resolveConfig(root);
  await fs.rm(config.cacheDir, { recursive: true, force: true });
  await fs.mkdir(config.cacheDir, { recursive: true });
  await linkRuntimeDependencies(config.cacheDir);
  const { pages, sidebar, compiled } = await prepareBuild(config);
  await fs.writeFile(
    path.join(config.cacheDir, "entry.ts"),
    `import ${JSON.stringify(path.join(clientRoot, "entry.ts"))}`,
  );
  await fs.writeFile(
    path.join(config.cacheDir, "ssr-entry.ts"),
    `export { render } from ${JSON.stringify(path.join(clientRoot, "ssr.ts"))}`,
  );

  const plugins = () => [
    tnotesPlugin(config, sidebar, pages, compiled),
    vue({
      include: [/\.vue$/, /\.md$/],
      template: {
        // Markdown-generated HTML references assets relatively (../assets/…);
        // the files are copied verbatim, so asset-URL imports must stay off.
        transformAssetUrls: false,
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("mjx-"),
        },
      },
    }),
  ];
  const server = await createViteServer({
    root: config.cacheDir,
    base: config.base,
    publicDir: config.publicDir,
    configFile: false,
    appType: "custom",
    plugins: plugins(),
    server: { middlewareMode: true, fs: { allow: [config.root, packageRoot] } },
    resolve: { dedupe: ["vue"] },
    ssr: { noExternal: ["@tnotesjs/ui"] },
    logLevel: "warn",
  });
  const renderer = (await server.ssrLoadModule("/ssr-entry.ts")) as {
    render: (route: string) => Promise<{ html: string; data: PageData }>;
  };
  const inputs: Record<string, string> = {};
  try {
    for (const page of pages) {
      const rendered = await renderer.render(page.route);
      const relative = routeToOutput(page.route);
      const filename = path.join(config.cacheDir, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(
        filename,
        pageDocument(
          config,
          page.route,
          rendered.data,
          rendered.html,
          options.dev === true,
        ),
      );
      inputs[page.route === "/" ? "index" : page.route.slice(1)] = filename;
    }
  } finally {
    await server.close();
  }

  await viteBuild({
    root: config.cacheDir,
    base: config.base,
    publicDir: config.publicDir,
    configFile: false,
    plugins: plugins(),
    build: {
      outDir: config.outDir,
      emptyOutDir: true,
      // Large optional renderers and uncommon Shiki grammars are emitted as
      // lazy chunks. Keep warnings focused on the eagerly loaded application.
      chunkSizeWarningLimit: 800,
      rollupOptions: { input: inputs },
    },
    resolve: { dedupe: ["vue"] },
    logLevel: "warn",
  });
  await copyAssets(config);
  await writeSearchIndex(config, pages, compiled);
  return { config, pageCount: pages.length };
}

export async function previewSite(
  root = process.cwd(),
  options: { port?: number; host?: string | boolean } = {},
  configurePreviewServer?: PreviewServerHook,
): Promise<PreviewServer> {
  const config = await resolveConfig(root);
  return vitePreview({
    root: config.root,
    base: config.base,
    configFile: false,
    plugins: configurePreviewServer
      ? [{ name: "tnotes-preview-hooks", configurePreviewServer }]
      : [],
    preview: {
      port: options.port ?? config.port,
      host: options.host ?? "127.0.0.1",
      open: false,
    },
    build: { outDir: config.outDir },
  });
}

export async function createDevServer(root = process.cwd()) {
  const first = await buildSite(root, { dev: true });
  const clients = new Set<ServerResponse>();
  const server = await previewSite(root, {}, (preview) => {
    preview.middlewares.use((request, response, next) => {
      if (!request.url?.split("?")[0].endsWith("/__tnotes_reload")) {
        next();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.once("close", () => clients.delete(response));
    });
  });
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let pending = false;
  const rebuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      await buildSite(root, { dev: true });
      for (const client of clients) client.write("data: reload\n\n");
    } catch (error) {
      console.error(error);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const watcher = (await import("node:fs")).watch(
    first.config.root,
    { recursive: true },
    (_event, filename) => {
      if (!filename || /(?:node_modules|\.git|\.tnotes\/dist)/.test(filename))
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), 120);
    },
  );
  server.httpServer?.once("close", () => {
    watcher.close();
    for (const client of clients) client.end();
  });
  return server;
}
