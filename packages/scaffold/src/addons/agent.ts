import { defineAddon, ROOT_ROUTE, SERVER_ENTRY } from "../add/addon.js";

/**
 * The default template already contains all of this; a test runs this add-on on it and expects
 * no change, which is what keeps the two from drifting.
 */
export const agent = defineAddon({
  summary: "The agent sidebar: chat with your own coding agent inside the app.",
  requires: { routesDir: "src/routes" },
  dependencies: { "@parlor/chat": "framework" },
  files: [{ template: "default", dir: "src/agent" }],
  edits: [
    {
      file: SERVER_ENTRY,
      ops: [
        { kind: "import", names: ["chat"], from: "@parlor/chat/server" },
        {
          kind: "append-element",
          call: { callee: "createServer", from: "@parlor/server" },
          path: ["plugins"],
          element: "chat()",
        },
      ],
    },
    {
      file: "src/routes/__root.tsx",
      ops: [
        { kind: "import", names: ["agentPanel"], from: "../agent/views.js" },
        {
          kind: "append-element",
          call: ROOT_ROUTE,
          path: ["staticData", "views"],
          element: "agentPanel",
        },
      ],
    },
  ],
  mounts: [
    {
      component: "AgentButton",
      module: "src/agent/agent-button.tsx",
      into: { file: "src/header-actions.tsx", parent: "HeaderActions" },
    },
  ],
  env: [],
  generate: [],
  notes: [
    "Restart the dev server. Open the Agent button to chat with the coding agents on this computer.",
  ],
});
