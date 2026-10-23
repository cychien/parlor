import { parseArgs } from "node:util";

import { CreateError, PACKAGE_MANAGERS, type PackageManagerName } from "@parlor/scaffold";

export const DEFAULT_DIRECTORY = "my-parlor-app";

export interface CreateRequest {
  readonly directory: string | undefined;
  readonly yes: boolean;
  readonly install: boolean;
  readonly git: boolean;
  readonly packageManager: PackageManagerName | undefined;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export const USAGE = `Usage: create-parlor [directory] [options]

  -y, --yes                    Use every default and never prompt
      --package-manager <pm>   npm, pnpm, yarn or bun (default: the one running this)
      --no-install             Skip installing dependencies
      --no-git                 Skip the initial git commit
      --dry-run                List the files that would be written and stop
  -h, --help                   Show this help
  -v, --version                Show the version`;

/** npm 7+ passes a lone `--` through to the initializer; it is dropped like create-astro does. */
export function parseCreateArgs(argv: readonly string[]): CreateRequest {
  const { values, positionals } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: true,
    allowNegative: true,
    strict: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      install: { type: "boolean", default: true },
      git: { type: "boolean", default: true },
      "package-manager": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (positionals.length > 1) {
    throw new CreateError(`Expected one directory, got: ${positionals.join(" ")}`);
  }
  const manager = values["package-manager"];
  if (
    manager !== undefined &&
    !PACKAGE_MANAGERS.includes(manager as PackageManagerName)
  ) {
    throw new CreateError(
      `Unknown package manager "${manager}". Expected one of: ${PACKAGE_MANAGERS.join(", ")}`,
    );
  }
  return {
    directory: positionals[0],
    yes: values.yes,
    install: values.install,
    git: values.git,
    packageManager: manager as PackageManagerName | undefined,
    dryRun: values["dry-run"],
    help: values.help,
    version: values.version,
  };
}

export function canPrompt(
  stdin: { readonly isTTY?: boolean },
  stdout: { readonly isTTY?: boolean },
  env: NodeJS.ProcessEnv,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY && !env.CI);
}
