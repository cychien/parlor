import { loadParlorConfig } from "@parlor/config";
import { generateRouteTree } from "@parlor/shell-web";
import { defineCommand } from "citty";

export const typegen = defineCommand({
  meta: {
    name: "typegen",
    description:
      "Generate the route tree from src/routes, as parlor dev does, without Vite",
  },
  async run() {
    await generateRouteTree(await loadParlorConfig());
  },
});
