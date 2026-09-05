import { describe, expect, it } from "vitest";

import { collectCodeLanguages } from "../src/markdown";

describe("Markdown compatibility helpers", () => {
  it("collects only fenced-code languages needed by a site", () => {
    expect(
      collectCodeLanguages([
        "```ts\nconst value = 1\n```",
        "```TS\nconst other = 2\n```\n```python\npass\n```",
        "```mermaid\ngraph TD\n```",
      ]).sort(),
    ).toEqual(["mermaid", "python", "ts"]);
  });
});
