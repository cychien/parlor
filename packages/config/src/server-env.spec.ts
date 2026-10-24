import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";
import { appServerEnv } from "./server-env.js";

describe("appServerEnv", () => {
  it("hands the server the app name under PARLOR_APP_NAME", () => {
    const config = parseConfig({ app: { id: "dev.parlor.test", name: "Test" } });
    expect(appServerEnv(config)).toEqual({ PARLOR_APP_NAME: "Test" });
  });

  it("adds the app's description under PARLOR_APP_DESCRIPTION when it has one", () => {
    const config = parseConfig({
      app: {
        id: "dev.parlor.test",
        name: "Course Admin",
        description: "Courses and lessons.",
      },
    });
    expect(appServerEnv(config)).toEqual({
      PARLOR_APP_NAME: "Course Admin",
      PARLOR_APP_DESCRIPTION: "Courses and lessons.",
    });
  });

  it("hands the server the app's URL scheme under PARLOR_APP_SCHEME, which native sign-in returns to", () => {
    const config = parseConfig({
      app: { id: "dev.parlor.test", name: "Test", scheme: "test" },
    });
    expect(appServerEnv(config)).toEqual({
      PARLOR_APP_NAME: "Test",
      PARLOR_APP_SCHEME: "test",
    });
  });
});
