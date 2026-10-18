import { describe, expect, it } from "vitest";

import { routeHref } from "./manifest.js";

describe("routeHref", () => {
  it("fills params and serializes search", () => {
    const route = { path: "/tasks/$taskId", params: ["taskId"], views: [] };
    expect(routeHref(route, { taskId: "a b" }, { tab: "x", page: 2 })).toBe(
      "/tasks/a%20b?tab=x&page=2",
    );
    expect(routeHref({ path: "/", params: [], views: [] }, undefined, undefined)).toBe(
      "/",
    );
  });
});
