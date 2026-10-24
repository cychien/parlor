import { describe, expect, it } from "vitest";

import {
  SERVERLESS_UNSUPPORTED_WARNING,
  serverlessWarning,
} from "./serverless-warning.js";

describe("the serverless warning", () => {
  it("is given for a build that polls, and only then", () => {
    expect(serverlessWarning("poll")).toBe(SERVERLESS_UNSUPPORTED_WARNING);
    expect(serverlessWarning("sse")).toBeUndefined();
  });
});
