import { describe, expect, it } from "vitest";

import { devOrigins } from "./better-auth.js";

describe("devOrigins", () => {
  it("lists the other frontends of one parlor dev", () => {
    expect(
      devOrigins({
        PARLOR_DEV: "1",
        PARLOR_DEV_ORIGINS: "http://localhost:5176, http://localhost:5177",
      }),
    ).toEqual(["http://localhost:5176", "http://localhost:5177"]);
  });

  it("is empty outside parlor dev, and drops what is not an http origin", () => {
    expect(devOrigins({ PARLOR_DEV_ORIGINS: "http://localhost:5176" })).toEqual([]);
    expect(devOrigins({ PARLOR_DEV: "1", PARLOR_DEV_ORIGINS: "*,javascript:x" })).toEqual(
      [],
    );
  });
});
