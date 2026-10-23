import { describe, expect, it } from "vitest";

import { editSource, evaluateOp, manualChange, type Op } from "./ops.js";
import { parseSource } from "./source.js";

const SERVER = `import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

import { registry } from "./actions/index.js";

const database = await createDatabase({ migrationsFolder: "migrations" });

export default createServer({
  actions: registry,
  database,
});
`;

const createServerCall = { callee: "createServer", from: "@parlor/server" } as const;

const chatPlugin: Op = {
  kind: "append-element",
  call: createServerCall,
  path: ["plugins"],
  element: "chat()",
};

const authProperty: Op = {
  kind: "set-property",
  call: createServerCall,
  path: ["auth"],
  value: "createAuth($database)",
  onConflict: "unsafe",
};

function edited(path: string, text: string, ops: readonly Op[]): string {
  const outcome = editSource(parseSource(path, text), ops);
  expect(outcome.status).toBe("edit");
  return outcome.status === "edit" ? outcome.text : "";
}

describe("append-element", () => {
  it("creates plugins: [chat()] after the last property, keeping every other byte", () => {
    expect(edited("server.ts", SERVER, [chatPlugin])).toBe(
      SERVER.replace("  database,\n", "  database,\n  plugins: [chat()],\n"),
    );
  });

  it("appends to an existing array and is done once chat(...) is in it", () => {
    const withAudit = SERVER.replace(
      "  database,\n",
      "  database,\n  plugins: [audit()],\n",
    );
    const text = edited("server.ts", withAudit, [chatPlugin]);
    expect(text).toContain("plugins: [audit(), chat()],");
    expect(evaluateOp(parseSource("server.ts", text), chatPlugin)).toEqual({
      status: "done",
    });
    expect(
      evaluateOp(
        parseSource("server.ts", text.replace("chat()", "chat({ leaseMs: 1 })")),
        chatPlugin,
      ),
    ).toEqual({ status: "done" });
  });

  it("finds the call through the import binding, including an `as` rename", () => {
    const renamed = SERVER.replaceAll("createServer", "makeServer").replace(
      'import { makeServer } from "@parlor/server";',
      'import { createServer as makeServer } from "@parlor/server";',
    );
    expect(edited("server.ts", renamed, [chatPlugin])).toContain("plugins: [chat()],");
    const local = SERVER.replace(
      'import { createServer } from "@parlor/server";\n',
      "function createServer(options: unknown) {\n  return options;\n}\n",
    );
    expect(evaluateOp(parseSource("server.ts", local), chatPlugin)).toMatchObject({
      status: "unsafe",
      reason: expect.stringContaining("@parlor/server"),
    });
  });

  it.each([
    ["a spread", "createServer({ ...shared, database })", "...shared"],
    ["a variable", "createServer(options)", "`options`"],
    ["a computed key", "createServer({ database, [key]: 1 })", "computed"],
    ["a plugins variable", "createServer({ database, plugins })", "`plugins`"],
    [
      "two calls",
      "createServer({});\nexport const other = createServer({ database })",
      "one",
    ],
  ])("refuses %s with a reason naming it (D4)", (_, call, reason) => {
    const text = SERVER.replace(
      "createServer({\n  actions: registry,\n  database,\n})",
      call,
    );
    expect(evaluateOp(parseSource("server.ts", text), chatPlugin)).toMatchObject({
      status: "unsafe",
      reason: expect.stringContaining(reason),
    });
  });
});

describe("set-property", () => {
  it("creates the argument when the call has none", () => {
    const text = `import { createActionClient } from "@parlor/client";\n\nconst client = createActionClient();\n`;
    expect(
      edited("src/main.tsx", text, [
        {
          kind: "set-property",
          call: { callee: "createActionClient", from: "@parlor/client" },
          path: ["headers"],
          value: "auth.headers",
          onConflict: "unsafe",
        },
      ]),
    ).toBe(
      text.replace(
        "createActionClient()",
        "createActionClient({ headers: auth.headers })",
      ),
    );
  });

  it("substitutes $name with the sibling property's source text", () => {
    expect(edited("server.ts", SERVER, [authProperty])).toBe(
      SERVER.replace("  database,\n", "  database,\n  auth: createAuth(database),\n"),
    );
    const explicit = SERVER.replace("  database,\n", "  database: handle,\n");
    expect(edited("server.ts", explicit, [authProperty])).toContain(
      "auth: createAuth(handle),",
    );
  });

  it("is done when the value is already there, unsafe or replaced on a different one", () => {
    const present = SERVER.replace(
      "  database,\n",
      "  database,\n  auth: createAuth(database),\n",
    );
    expect(evaluateOp(parseSource("server.ts", present), authProperty)).toEqual({
      status: "done",
    });
    const other = SERVER.replace("  database,\n", "  database,\n  auth: devAuth(),\n");
    expect(evaluateOp(parseSource("server.ts", other), authProperty)).toMatchObject({
      status: "unsafe",
      reason: expect.stringContaining("auth"),
    });
    expect(edited("server.ts", other, [{ ...authProperty, onConflict: "replace" }])).toBe(
      present,
    );
  });

  it("walks a nested path and creates the missing parents", () => {
    const config = `import { defineConfig } from "@parlor/config";\n\nexport default defineConfig({\n  app: {\n    id: "com.example.parlorapp",\n    name: "Parlor App",\n  },\n});\n`;
    const text = edited("parlor.config.ts", config, [
      {
        kind: "set-property",
        call: { callee: "defineConfig", from: "@parlor/config" },
        path: ["app", "id"],
        value: '"com.example.myapp"',
        onConflict: "replace",
      },
      {
        kind: "set-property",
        call: { callee: "defineConfig", from: "@parlor/config" },
        path: ["web", "port"],
        value: "4000",
        onConflict: "unsafe",
      },
    ]);
    expect(text).toBe(
      config
        .replace('"com.example.parlorapp"', '"com.example.myapp"')
        .replace("  },\n});", "  },\n  web: {\n    port: 4000,\n  },\n});"),
    );
  });
});

describe("import and export-all", () => {
  it("adds a relative import in sorted position and merges names into an existing one", () => {
    const added = edited("server.ts", SERVER, [
      { kind: "import", names: ["createAuth"], from: "./auth.js" },
      { kind: "import", names: ["chat"], from: "@parlor/chat/server" },
    ]);
    expect(added).toBe(
      SERVER.replace(
        'import { createDatabase } from "@parlor/data";\n',
        'import { chat } from "@parlor/chat/server";\nimport { createDatabase } from "@parlor/data";\n',
      ).replace(
        'import { registry } from "./actions/index.js";\n',
        'import { registry } from "./actions/index.js";\nimport { createAuth } from "./auth.js";\n',
      ),
    );
    const merged = edited("server.ts", SERVER, [
      { kind: "import", names: ["createServer", "devAuth"], from: "@parlor/server" },
    ]);
    expect(merged).toContain('import { createServer, devAuth } from "@parlor/server";');
  });

  it("is done when every name is imported and unsafe when the name is bound elsewhere", () => {
    expect(
      evaluateOp(parseSource("server.ts", SERVER), {
        kind: "import",
        names: ["createServer"],
        from: "@parlor/server",
      }),
    ).toEqual({ status: "done" });
    expect(
      evaluateOp(parseSource("server.ts", `${SERVER}const chat = 1;\n`), {
        kind: "import",
        names: ["chat"],
        from: "@parlor/chat/server",
      }),
    ).toMatchObject({ status: "unsafe", reason: expect.stringContaining("chat") });
  });

  it("appends export * and is done when present", () => {
    const index = `export { todos } from "./todos.js";\n`;
    const text = edited("schema/index.ts", index, [
      { kind: "export-all", from: "./auth.js" },
    ]);
    expect(text).toBe(`${index}export * from "./auth.js";\n`);
    expect(
      evaluateOp(parseSource("schema/index.ts", text), {
        kind: "export-all",
        from: "./auth.js",
      }),
    ).toEqual({ status: "done" });
  });
});

describe("wrap-property and jsx", () => {
  const ROOT = `import { createRootRoute } from "@tanstack/react-router";\n\nexport const Route = createRootRoute({\n  component: Layout,\n});\n`;
  const wrap: Op = {
    kind: "wrap-property",
    call: { callee: "createRootRoute", from: "@tanstack/react-router" },
    path: ["component"],
    wrapper: "withSignIn",
  };
  const MAIN = `createRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <FrameworkProvider client={client} router={router}>\n      <RouterProvider router={router} />\n    </FrameworkProvider>\n  </StrictMode>,\n);\n`;
  const HEADER = `export function HeaderActions() {\n  return (\n    <div className="flex items-center gap-2">\n      <AgentButton />\n    </div>\n  );\n}\n`;

  it("wraps component: Layout once", () => {
    const text = edited("src/routes/__root.tsx", ROOT, [wrap]);
    expect(text).toBe(
      ROOT.replace("component: Layout,", "component: withSignIn(Layout),"),
    );
    expect(evaluateOp(parseSource("src/routes/__root.tsx", text), wrap)).toEqual({
      status: "done",
    });
  });

  it("adds an attribute to the one element of that name", () => {
    const attribute: Op = {
      kind: "jsx-attribute",
      element: "FrameworkProvider",
      name: "auth",
      value: "{auth}",
    };
    const text = edited("src/main.tsx", MAIN, [attribute]);
    expect(text).toBe(
      MAIN.replace(
        "<FrameworkProvider client={client} router={router}>",
        "<FrameworkProvider client={client} router={router} auth={auth}>",
      ),
    );
    expect(evaluateOp(parseSource("src/main.tsx", text), attribute)).toEqual({
      status: "done",
    });
    expect(
      evaluateOp(
        parseSource("src/main.tsx", `${MAIN}const x = <FrameworkProvider />;\n`),
        attribute,
      ),
    ).toMatchObject({ status: "unsafe", reason: expect.stringContaining("once") });
  });

  it("appends a child to the JSX a component returns", () => {
    const child: Op = {
      kind: "jsx-child",
      component: "HeaderActions",
      element: "SignOutButton",
    };
    const text = edited("src/header-actions.tsx", HEADER, [child]);
    expect(text).toBe(
      HEADER.replace(
        "      <AgentButton />\n",
        "      <AgentButton />\n      <SignOutButton />\n",
      ),
    );
    expect(evaluateOp(parseSource("src/header-actions.tsx", text), child)).toEqual({
      status: "done",
    });
  });
});

describe("editSource", () => {
  it("is done when every op already holds and collects every unsafe op", () => {
    const done = SERVER.replace("  database,\n", "  database,\n  plugins: [chat()],\n");
    expect(editSource(parseSource("server.ts", done), [chatPlugin])).toEqual({
      status: "done",
    });
    const outcome = editSource(
      parseSource("server.ts", "export default createServer(options);\n"),
      [chatPlugin, authProperty],
    );
    expect(outcome).toMatchObject({
      status: "unsafe",
      unsafe: [{ op: chatPlugin }, { op: authProperty }],
    });
  });

  it("prints the manual change with the import lines and the edited call", () => {
    const text = manualChange("server.ts", authProperty);
    expect(text).toContain("server.ts");
    expect(text).toContain("auth: createAuth(database),");
  });
});
