import { describe, expect, it } from "vitest";

import { inspectServer } from "./inspect.js";
import { parseSource } from "./source.js";

const HEAD = `import { chat } from "@parlor/chat/server";\nimport { createServer } from "@parlor/server";\n`;

function shape(body: string) {
  return inspectServer(parseSource("server.ts", `${HEAD}${body}\n`));
}

describe("inspectServer", () => {
  it("sees auth and chat on the fixture's shape", () => {
    expect(
      shape(
        "export default createServer({ actions, database, plugins: [chat()], auth: createAuth(database) });",
      ),
    ).toEqual({ auth: "installed", chat: "installed" });
  });

  it("reports both absent on the default template, and chat absent without plugins", () => {
    expect(
      shape("export default createServer({ actions, database, plugins: [chat()] });"),
    ).toEqual({
      auth: "absent",
      chat: "installed",
    });
    expect(shape("export default createServer({ actions, database });")).toEqual({
      auth: "absent",
      chat: "absent",
    });
  });

  it("treats a literal undefined auth as absent", () => {
    expect(
      shape("export default createServer({ actions, auth: undefined });"),
    ).toMatchObject({
      auth: "absent",
    });
  });

  it("is unknown on a spread, a variable, a plugins variable or a renamed chat", () => {
    expect(shape("export default createServer({ ...shared });")).toEqual({
      auth: "unknown",
      chat: "unknown",
    });
    expect(shape("export default createServer(options);")).toEqual({
      auth: "unknown",
      chat: "unknown",
    });
    expect(shape("export default createServer({ actions, plugins });")).toEqual({
      auth: "absent",
      chat: "unknown",
    });
    expect(
      shape("export default createServer({ actions, plugins: [...base, chat()] });"),
    ).toEqual({ auth: "absent", chat: "unknown" });
  });

  it("reads an identifier bound once to a call as installed, a conditional as unknown (G1)", () => {
    expect(
      shape(
        "const auth = createAuth(database);\nexport default createServer({ actions, auth, plugins: [chat()] });",
      ),
    ).toEqual({ auth: "installed", chat: "installed" });
    expect(
      shape(
        "export default createServer({ actions, auth: isProd ? provider : undefined });",
      ),
    ).toMatchObject({ auth: "unknown" });
    expect(
      shape("export default createServer({ actions, auth: provider ?? undefined });"),
    ).toMatchObject({ auth: "unknown" });
    expect(
      shape("let auth;\nexport default createServer({ actions, auth });"),
    ).toMatchObject({ auth: "unknown" });
  });

  it("follows a renamed createServer import and ignores a local one", () => {
    const renamed = `import { chat } from "@parlor/chat/server";\nimport { createServer as makeServer } from "@parlor/server";\nexport default makeServer({ actions, plugins: [chat()], auth: createAuth() });\n`;
    expect(inspectServer(parseSource("server.ts", renamed))).toEqual({
      auth: "installed",
      chat: "installed",
    });
    const local = `function createServer(options) { return options; }\nexport default createServer({ actions });\n`;
    expect(inspectServer(parseSource("server.ts", local))).toEqual({
      auth: "unknown",
      chat: "unknown",
    });
  });
});
