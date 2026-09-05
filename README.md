# @tnotesjs/ssg

The additive, Vite-powered static-site generator for TNotes knowledge bases. It
owns only the pieces TNotes consumes: Markdown-to-Vue compilation, filesystem
routes, static rendering, dead-link validation, local search, preview and a
small responsive shell. It has no VitePress runtime dependency.

```ts
// tnotes.config.mts
import { defineConfig } from "@tnotesjs/ssg";

export default defineConfig({
  base: "/my-kb/",
  title: "my-kb",
});
```

```sh
tnotes-ssg build
tnotes-ssg dev
tnotes-ssg preview
```

Supported compatibility boundaries are covered by fixtures: Markdown with Vue
SFC blocks and components, external snippets, base paths, dead-link checks,
local search, math, containers, shared Shiki code blocks and static HTML output.
