#!/usr/bin/env node
import { resolve } from "node:path";

import { cancel, isCancel, text } from "@clack/prompts";
import {
  CreateError,
  createProject,
  FRAMEWORK_VERSION,
  fromUserAgent,
  type PackageManager,
} from "@parlor/scaffold";

import { canPrompt, DEFAULT_DIRECTORY, parseCreateArgs, USAGE } from "./args.js";
import { dryRunReport, nextSteps } from "./next-steps.js";

async function askDirectory(): Promise<string | undefined> {
  const answer = await text({
    message: "Project name",
    placeholder: DEFAULT_DIRECTORY,
    defaultValue: DEFAULT_DIRECTORY,
  });
  if (isCancel(answer)) {
    cancel("Cancelled");
    return undefined;
  }
  return answer.trim() || DEFAULT_DIRECTORY;
}

async function main(argv: readonly string[]): Promise<number> {
  const request = parseCreateArgs(argv);
  if (request.help) {
    console.log(USAGE);
    return 0;
  }
  if (request.version) {
    console.log(FRAMEWORK_VERSION);
    return 0;
  }
  const detected = fromUserAgent(process.env.npm_config_user_agent);
  const packageManager: PackageManager = request.packageManager
    ? {
        name: request.packageManager,
        version: detected?.name === request.packageManager ? detected.version : undefined,
      }
    : (detected ?? { name: "npm", version: undefined });
  const directory =
    request.directory ??
    (request.yes
      ? DEFAULT_DIRECTORY
      : canPrompt(process.stdin, process.stdout, process.env)
        ? await askDirectory()
        : undefined);
  if (directory === undefined) {
    if (canPrompt(process.stdin, process.stdout, process.env)) return 0;
    throw new CreateError(
      `create-parlor needs a project name when it cannot ask for one. Run, for example:\n  ${packageManager.name} create parlor my-app --yes`,
    );
  }
  const project = await createProject({
    directory: resolve(directory),
    packageManager,
    mode: request.dryRun ? "dry-run" : "apply",
    install: request.install,
    git: request.git,
    addons: request.addons,
    log: (line) => console.log(line),
  });
  const lines = request.dryRun
    ? dryRunReport(project)
    : nextSteps(project, process.cwd());
  console.log(lines.join("\n"));
  return project.install.kind === "failed" ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (
    error instanceof CreateError ||
    (error instanceof TypeError &&
      "code" in error &&
      error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION")
  ) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
