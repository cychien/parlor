import { type LoadedConfig, loadParlorConfig } from "@parlor/config";
import {
  ADDON_NAMES,
  addAddons,
  type AddonName,
  type AddTools,
  detectProjectPackageManager,
  formatAddResult,
  isAddonName,
  type ProjectLayout,
} from "@parlor/scaffold";
import { generateRouteTree, routeTreeFile } from "@parlor/shell-web";
import { defineCommand } from "citty";

import { CliError } from "../errors.js";
import { drizzleKitArgs, runDrizzleKit } from "./db.js";

export function projectLayout({ config, rootDir }: LoadedConfig): ProjectLayout {
  return {
    rootDir,
    serverEntry: config.server.entry,
    schemaDir: config.database.schema,
    migrationsDir: config.database.migrations,
    routeTree: routeTreeFile(config),
  };
}

/**
 * The same code `parlor typegen` and `parlor db generate` run, pointed at whatever directory
 * the transaction names: the staging copy, never the project.
 */
export function addTools(loaded: LoadedConfig): AddTools {
  const { config } = loaded;
  return {
    routeTree: (rootDir) => generateRouteTree({ ...loaded, rootDir }),
    migration: (rootDir, name) =>
      runDrizzleKit(
        drizzleKitArgs(config.database.schema, config.database.migrations, name),
        rootDir,
      ),
  };
}

export function parseAddonNames(values: readonly string[]): readonly AddonName[] {
  if (values.length === 0) {
    throw new CliError(`Name what to add: ${ADDON_NAMES.join(", ")}`);
  }
  const unknown = values.filter((value) => !isAddonName(value));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown add-on ${unknown.map((name) => `"${name}"`).join(", ")}. Expected one of: ${ADDON_NAMES.join(", ")}`,
    );
  }
  return [...new Set(values as AddonName[])];
}

export const add = defineCommand({
  meta: {
    name: "add",
    description: `Add a feature to this app by editing its files: ${ADDON_NAMES.join(", ")}`,
  },
  args: {
    addon: { type: "positional", description: ADDON_NAMES.join(" | "), required: false },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Print the changes without writing or installing anything",
    },
    install: {
      type: "boolean",
      default: true,
      description:
        "Install dependencies and generate files (--no-install to only write files)",
    },
    "git-check": {
      type: "boolean",
      default: true,
      description:
        "Refuse to edit a project with uncommitted changes (--no-git-check to proceed)",
    },
  },
  async run({ args }) {
    const loaded = await loadParlorConfig();
    const addons = parseAddonNames(args._);
    const packageManager = await detectProjectPackageManager(loaded.rootDir);
    const result = await addAddons({
      layout: projectLayout(loaded),
      addons,
      packageManager,
      tools: addTools(loaded),
      mode: args["dry-run"] ? "dry-run" : "apply",
      install: args.install,
      gitCheck: args["git-check"],
      log: (line) => console.log(line),
    });
    const { text, exitCode } = formatAddResult(result, packageManager);
    console.log(text);
    process.exitCode = exitCode;
  },
});
