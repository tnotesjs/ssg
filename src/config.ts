import fs from "node:fs";
import path from "node:path";
import { loadConfigFromFile } from "vite";

import type { ResolvedSsgConfig, SsgConfig } from "./types";

export function defineConfig(config: SsgConfig): SsgConfig {
  return config;
}

export async function resolveConfig(
  root = process.cwd(),
  command: "build" | "serve" = "build",
): Promise<ResolvedSsgConfig> {
  const requestedRoot = path.resolve(root);
  const absoluteRoot = fs.existsSync(requestedRoot)
    ? fs.realpathSync.native(requestedRoot)
    : requestedRoot;
  const candidates = [
    "tnotes.config.mts",
    "tnotes.config.ts",
    ".tnotes/config.mts",
    ".tnotes/config.ts",
  ];
  const configFile = candidates
    .map((file) => path.join(absoluteRoot, file))
    .find((file) => fs.existsSync(file));

  let user: SsgConfig = {};
  if (configFile) {
    const loaded = await loadConfigFromFile(
      { command, mode: command === "build" ? "production" : "development" },
      configFile,
      absoluteRoot,
    );
    user = (loaded?.config ?? {}) as SsgConfig;
  }

  const resolvedRoot = path.resolve(absoluteRoot, user.root ?? ".");
  const normalizeBase = (base: string) => {
    const value = `/${base}/`.replace(/\/+/g, "/");
    return value === "//" ? "/" : value;
  };

  return {
    root: resolvedRoot,
    srcDir: path.resolve(resolvedRoot, user.srcDir ?? "."),
    outDir: path.resolve(resolvedRoot, user.outDir ?? ".tnotes/dist"),
    cacheDir: path.resolve(
      resolvedRoot,
      user.cacheDir ?? "node_modules/.tnotes-ssg",
    ),
    publicDir: path.resolve(resolvedRoot, user.publicDir ?? "public"),
    base: normalizeBase(user.base ?? "/"),
    title: user.title ?? path.basename(resolvedRoot),
    description: user.description ?? "",
    lang: user.lang ?? "zh-Hans",
    port: user.port ?? 5173,
    ignore: user.ignore ?? [],
    ignoreDeadLinks: user.ignoreDeadLinks ?? false,
    markdown: user.markdown ?? {},
    sidebar: user.sidebar ?? [],
    nav: user.nav ?? [],
    theme: user.theme,
    head: user.head ?? [],
    configFile: configFile ?? "",
  };
}
