import { ConfigError } from "@parlor/config";
import { defineCommand, runCommand, runMain } from "citty";

import { build } from "./commands/build.js";
import { dev } from "./commands/dev.js";
import { CliError } from "./errors.js";

const main = defineCommand({
  meta: { name: "parlor", description: "Parlor CLI" },
  subCommands: { dev, build },
});

function isHelp(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

async function run(rawArgs: string[]): Promise<void> {
  if (rawArgs.some(isHelp)) {
    await runMain(main, { rawArgs });
    return;
  }
  await runCommand(main, { rawArgs });
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError || error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
