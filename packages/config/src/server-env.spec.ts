import { describe, expect, it } from "vitest";

import { parseConfig } from "./schema.js";
import { appServerEnv } from "./server-env.js";

describe("appServerEnv", () => {
  it("hands the server the app name under PARLOR_APP_NAME", () => {
    const config = parseConfig({ app: { id: "dev.parlor.test", name: "Test" } });
    expect(appServerEnv(config)).toEqual({ PARLOR_APP_NAME: "Test" });
  });
});
