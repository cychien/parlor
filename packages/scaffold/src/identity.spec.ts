import { parseConfig } from "@parlor/config";
import { describe, expect, it } from "vitest";

import { identityFor } from "./identity.js";

describe("identityFor", () => {
  it.each([
    ["my-app", "my-app", "My App", "com.example.myapp"],
    ["My Notes", "my-notes", "My Notes", "com.example.mynotes"],
    ["2048", "2048", "2048", "com.example.app2048"],
    ["_hidden.app", "hidden.app", "Hidden App", "com.example.hiddenapp"],
    ["Über App", "uber-app", "Uber App", "com.example.uberapp"],
  ])("derives the names from %s", (directory, packageName, appName, appId) => {
    expect(identityFor(directory)).toEqual({
      directoryName: directory,
      packageName,
      appName,
      appId,
    });
  });

  it("produces an app.id the config schema accepts", () => {
    for (const name of ["my-app", "Über App", "a-b-c-1"]) {
      const { appId, appName } = identityFor(name);
      expect(() => parseConfig({ app: { id: appId, name: appName } })).not.toThrow();
    }
  });

  it("refuses a name with nothing usable left", () => {
    expect(() => identityFor("...")).toThrow(/name/);
    expect(() => identityFor("@@")).toThrow(/name/);
  });
});
