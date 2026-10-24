import { expect, test } from "vitest";

import { brokenDocsLinks, docSlugs } from "./check-samples.ts";

test("every docs page has a slug, the home page included", () => {
  const slugs = docSlugs();
  expect(slugs.has("")).toBe(true);
  expect(slugs.has("getting-started")).toBe(true);
  expect(slugs.has("guides/actions")).toBe(true);
  expect(slugs.has("reference/cli")).toBe(true);
});

test("a README link into the docs must name a page", () => {
  const slugs = new Set(["", "guides/actions"]);
  expect(
    brokenDocsLinks(
      "See https://cychien.github.io/parlor/guides/actions/#errors, https://cychien.github.io/parlor/llms.txt and https://cychien.github.io/parlor/guides/missing/.",
      slugs,
    ),
  ).toEqual(["https://cychien.github.io/parlor/guides/missing/"]);
});
