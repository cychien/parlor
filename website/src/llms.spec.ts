import { expect, test } from "vitest";

import { llmsIndex, stripTwoslash } from "./llms.js";

test("llms.txt links every page, as Markdown", () => {
  const index = llmsIndex(
    [
      {
        slug: "guides/actions",
        title: "Actions",
        description: "Business logic",
        body: "",
      },
      {
        slug: "getting-started",
        title: "Getting started",
        description: undefined,
        body: "",
      },
    ],
    new URL("https://cychien.github.io/parlor/"),
    "Parlor docs",
  );
  expect(index).toContain(
    "- [Getting started](https://cychien.github.io/parlor/getting-started.md)\n",
  );
  expect(index).toContain(
    "- [Actions](https://cychien.github.io/parlor/guides/actions.md): Business logic",
  );
});

test("samples lose their setup and twoslash directives", () => {
  const body = [
    "```ts",
    'import "@parlor/data";',
    "// ---cut---",
    "const one = 1;",
    "//    ^?",
    "```",
  ].join("\n");
  expect(stripTwoslash(body)).toBe("```ts\nconst one = 1;\n```");
});
