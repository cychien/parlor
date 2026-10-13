import { loadParlorConfig } from "@parlor/config";
import { defineCommand } from "citty";

import { handlers } from "../handlers.js";
import { parseTarget, resolveHandler } from "../targets.js";

export const build = defineCommand({
  meta: { name: "build", description: "Build the app for a target" },
  args: {
    target: {
      type: "string",
      description: "web | ios | android | mac | windows | linux",
      default: "web",
    },
    preset: {
      type: "string",
      description:
        "Server deploy preset for the web target: node-server, vercel, netlify, …",
    },
  },
  async run({ args }) {
    const target = parseTarget(args.target);
    const handler = resolveHandler(handlers, target);
    await handler.build(await loadParlorConfig(), { preset: args.preset });
  },
});
