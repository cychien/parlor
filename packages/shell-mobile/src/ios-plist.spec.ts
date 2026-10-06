import { describe, expect, it } from "vitest";

import { withUrlScheme } from "./ios-plist.js";

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>App</string>
</dict>
</plist>
`;

describe("withUrlScheme", () => {
  it("adds CFBundleURLTypes before the closing dict", () => {
    const out = withUrlScheme(plist, "dev.parlor.hello", "hello");
    expect(out).toContain("<key>CFBundleURLTypes</key>");
    expect(out).toContain("<string>hello</string>");
    expect(out.indexOf("CFBundleURLTypes")).toBeLessThan(out.lastIndexOf("</dict>"));
  });

  it("is idempotent and replaces a previous scheme", () => {
    const once = withUrlScheme(plist, "dev.parlor.hello", "hello");
    const twice = withUrlScheme(once, "dev.parlor.hello", "hello");
    expect(twice).toBe(once);
    const changed = withUrlScheme(once, "dev.parlor.hello", "other");
    expect(changed).not.toContain("<string>hello</string>");
    expect(changed.match(/CFBundleURLTypes/g)).toHaveLength(1);
  });
});
