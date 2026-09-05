import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectCodeLanguages, resolveSnippetIncludes } from "../src/markdown";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Markdown compatibility helpers", () => {
  it("expands snippet ranges and records the source dependency", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tnotes-ssg-snippet-"));
    temporaryDirectories.push(root);
    const page = path.join(root, "guide.md");
    const snippet = path.join(root, "example.ts");
    fs.writeFileSync(
      snippet,
      "const one = 1;\nconst two = 2;\nconst three = 3;\n",
    );

    const result = resolveSnippetIncludes(
      "<<< ./example.ts{2-3} [typescript]",
      page,
      root,
    );

    expect(result.includes).toEqual([snippet]);
    expect(result.source).toContain("```typescript [example.ts]");
    expect(result.source).toContain("const two = 2;\nconst three = 3;");
    expect(result.source).not.toContain("const one = 1;");
  });

  it("collects only fenced-code languages needed by a site", () => {
    expect(
      collectCodeLanguages([
        "```ts\nconst value = 1\n```",
        "```TS\nconst other = 2\n```\n```python\npass\n```\n<<< ./demo.rs{1-2}",
        "<<< ./example.js [typescript]",
      ]).sort(),
    ).toEqual(["python", "rs", "ts", "typescript"]);
  });
});
