import { describe, expect, it } from "vitest";

import { pagePattern } from "./pages.js";

const matches = (path: string, urls: readonly string[]) =>
  urls.map((url) => pagePattern(path).test(url));

describe("pagePattern", () => {
  it("matches a static path with or without a trailing slash or query, ignoring case", () => {
    expect(matches("/settings", ["/settings", "/settings/", "/Settings?tab=a"])).toEqual([
      true,
      true,
      true,
    ]);
    expect(matches("/settings", ["/settings/more", "/setting", "/"])).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("matches the root only at the root", () => {
    expect(matches("/", ["/", "/?next=x", "/a"])).toEqual([true, true, false]);
  });

  it("matches one segment for a param", () => {
    expect(matches("/tasks/$taskId", ["/tasks/42", "/tasks", "/tasks/4/2"])).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("matches the rest of the path for a splat, including nothing", () => {
    expect(matches("/files/$", ["/files", "/files/a", "/files/a/b", "/filesx"])).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(matches("/$", ["/", "/api/payment/webhook"])).toEqual([true, true]);
  });

  it("matches optional params and params inside a segment", () => {
    expect(matches("/{-$lang}/about", ["/about", "/en/about", "/en/x/about"])).toEqual([
      true,
      true,
      false,
    ]);
    expect(matches("/posts/{$id}.json", ["/posts/7.json", "/posts/7"])).toEqual([
      true,
      false,
    ]);
    expect(matches("/docs/v{$}", ["/docs/v1/intro", "/docs/intro"])).toEqual([
      true,
      false,
    ]);
  });

  it("treats regular expression characters in a segment literally", () => {
    expect(matches("/a.b", ["/a.b", "/axb"])).toEqual([true, false]);
  });
});
