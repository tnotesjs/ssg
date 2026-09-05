import fs from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";

import type { ResolvedSsgConfig } from "./types";

export interface SourcePage {
  file: string;
  route: string;
  source: string;
}

function toRoute(relativePath: string) {
  const clean = relativePath.replaceAll("\\", "/").replace(/\.md$/i, "");
  if (clean.toLowerCase() === "index") return "/";
  return `/${clean}`;
}

export async function collectPages(config: ResolvedSsgConfig) {
  const ignore = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.tnotes/**",
    "**/.vitepress/**",
    ...config.ignore,
  ];
  const files = await glob("**/*.md", {
    cwd: config.srcDir,
    absolute: true,
    ignore,
  });
  return files.sort().map((file): SourcePage => ({
    file,
    route: toRoute(path.relative(config.srcDir, file)),
    source: fs.readFileSync(file, "utf8"),
  }));
}

export function routeToOutput(route: string) {
  if (route === "/") return "index.html";
  return `${route.slice(1)}.html`;
}
