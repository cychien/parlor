import { defineAddon, SERVER_ENTRY } from "../add/addon.js";

export const auth = defineAddon({
  summary: "Sign-in with email and password; each user sees only their own data.",
  requires: { serverAtRoot: true, schemaDir: "schema", routesDir: "src/routes" },
  dependencies: {
    "@parlor/auth": "framework",
    "better-auth": { fromPackage: "@parlor/auth", dependency: "better-auth" },
  },
  files: [{ template: "auth", dir: "" }],
  edits: [
    {
      file: SERVER_ENTRY,
      ops: [
        { kind: "import", names: ["createAuth"], from: "./auth.js" },
        {
          kind: "set-property",
          call: { callee: "createServer", from: "@parlor/server" },
          path: ["auth"],
          value: "createAuth($database)",
          onConflict: "unsafe",
        },
      ],
    },
    {
      file: "schema/index.ts",
      ops: [{ kind: "export-all", from: "./auth.js" }],
    },
    {
      file: "src/main.tsx",
      ops: [
        { kind: "import", names: ["auth"], from: "./auth/client.js" },
        {
          kind: "set-property",
          call: { callee: "createActionClient", from: "@parlor/client" },
          path: ["headers"],
          value: "auth.headers",
          onConflict: "unsafe",
        },
        {
          kind: "jsx-attribute",
          element: "FrameworkProvider",
          name: "auth",
          value: "{auth}",
        },
      ],
    },
    {
      file: "src/routes/__root.tsx",
      ops: [
        { kind: "import", names: ["withSignIn"], from: "../auth/sign-in-gate.js" },
        {
          kind: "wrap-property",
          call: { callee: "createRootRoute", from: "@tanstack/react-router" },
          path: ["component"],
          wrapper: "withSignIn",
        },
      ],
    },
  ],
  mounts: [
    {
      component: "SignOutButton",
      module: "src/auth/sign-out-button.tsx",
      into: { file: "src/header-actions.tsx", parent: "HeaderActions" },
    },
  ],
  env: [
    {
      name: "PARLOR_ORIGIN",
      example: "https://your-app.example.com",
      description:
        "The public origin the app is served from. `parlor dev` sets it for you.",
    },
    {
      name: "BETTER_AUTH_SECRET",
      example: "",
      description:
        "Signs sessions in production. Generate one with: openssl rand -base64 32",
    },
  ],
  generate: [
    { kind: "route-tree", routes: ["/sign-in", "/link"] },
    {
      kind: "migration",
      name: "auth",
      tables: ["user", "session", "account", "verification"],
    },
  ],
  notes: [
    'Rows created before sign-in belong to the scope "default", which no signed-in user sees.',
    "The sidebar now connects agents with `npx @parlor/agent-host connect`, shown in the sidebar.",
    "In production set PARLOR_ORIGIN and BETTER_AUTH_SECRET; see .env.example.",
  ],
});
