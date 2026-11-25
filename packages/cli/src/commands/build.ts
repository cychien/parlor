import { loadParlorConfig } from "@parlor/config";
import { defineCommand } from "citty";

import { warnChatWithoutAuth } from "../chat-warning.js";
import { buildWebAndServer } from "../web-target.js";

export const build = defineCommand({
  meta: { name: "build", description: "Build the web app and its server" },
  args: {
    preset: {
      type: "string",
      description: "Server deploy preset: node-server, vercel, netlify, …",
    },
  },
  async run({ args }) {
    const loaded = await loadParlorConfig();
    await warnChatWithoutAuth(loaded);
    await buildWebAndServer(loaded, { preset: args.preset });
  },
});
