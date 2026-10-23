import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManager {
  readonly name: PackageManagerName;
  readonly version: string | undefined;
}

export interface Command {
  readonly bin: string;
  readonly args: readonly string[];
}

export interface PackageManagerCommands {
  readonly install: Command;
  add(packages: readonly string[], options: { readonly dev: boolean }): Command;
  run(script: string): string;
  exec(bin: string, args: readonly string[]): string;
}

/** Dependencies whose install scripts a Parlor project needs; pnpm 10+ blocks them unless approved. */
export const BUILD_SCRIPT_DEPENDENCIES = ["esbuild"] as const;

/**
 * `npm_config_user_agent` looks like `pnpm/11.21.0 npm/? node/v24.19.0 darwin arm64`; every
 * package manager sets it for the scripts and `create` initializers it runs.
 */
export function fromUserAgent(userAgent: string | undefined): PackageManager | undefined {
  const [name, version] = userAgent?.split(" ")[0]?.split("/") ?? [];
  if (!isPackageManagerName(name)) return undefined;
  return { name, version: version && version !== "?" ? version : undefined };
}

function isPackageManagerName(name: string | undefined): name is PackageManagerName {
  return PACKAGE_MANAGERS.includes(name as PackageManagerName);
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManagerName]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function fromPackageManagerField(field: unknown): PackageManager | undefined {
  if (typeof field !== "string") return undefined;
  const [name, rest = ""] = field.split("@");
  if (!isPackageManagerName(name)) return undefined;
  return { name, version: rest.split("+")[0] || undefined };
}

export async function detectProjectPackageManager(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PackageManager> {
  const invoking = fromUserAgent(env.npm_config_user_agent);
  if (invoking) return invoking;
  const manifest = await readFile(join(rootDir, "package.json"), "utf8").then(
    (text) => JSON.parse(text) as { packageManager?: unknown },
    () => undefined,
  );
  const declared = fromPackageManagerField(manifest?.packageManager);
  if (declared) return declared;
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(rootDir, file)));
  return { name: lockfile?.[1] ?? "npm", version: undefined };
}

export function commandsFor({ name }: PackageManager): PackageManagerCommands {
  const addVerb = name === "npm" ? "install" : "add";
  const devFlag = name === "npm" ? "--save-dev" : name === "bun" ? "--dev" : "-D";
  return {
    install: { bin: name, args: ["install"] },
    add: (packages, { dev }) => ({
      bin: name,
      args: [addVerb, ...(dev ? [devFlag] : []), ...packages],
    }),
    run: (script) =>
      name === "pnpm" || name === "yarn" ? `${name} ${script}` : `${name} run ${script}`,
    exec: (bin, args) => {
      const runner = { npm: "npx", pnpm: "pnpm", yarn: "yarn", bun: "bunx" }[name];
      return [runner, bin, ...args].join(" ");
    },
  };
}

export function formatCommand(command: Command): string {
  return [command.bin, ...command.args].join(" ");
}

/** Yarn must not use Plug'n'Play: the CLI resolves its tools from `node_modules`. */
export function packageManagerFiles(
  manager: PackageManager,
): ReadonlyMap<string, string> {
  if (manager.name === "pnpm") {
    const builds = usesOnlyBuiltDependencies(manager.version)
      ? `onlyBuiltDependencies:\n${BUILD_SCRIPT_DEPENDENCIES.map((name) => `  - ${name}\n`).join("")}`
      : `allowBuilds:\n${BUILD_SCRIPT_DEPENDENCIES.map((name) => `  ${name}: true\n`).join("")}`;
    return new Map([["pnpm-workspace.yaml", builds]]);
  }
  if (manager.name === "yarn")
    return new Map([[".yarnrc.yml", "nodeLinker: node-modules\n"]]);
  return new Map();
}

/** pnpm 10.0 to 10.25; an unknown version gets the current form, as create-next-app does. */
function usesOnlyBuiltDependencies(version: string | undefined): boolean {
  const [major, minor] = (version ?? "").split(".").map(Number);
  return major === 10 && minor !== undefined && minor < 26;
}

export function packageManagerField(manager: PackageManager): string | undefined {
  if (manager.name === "npm" || !manager.version) return undefined;
  return `${manager.name}@${manager.version}`;
}

export type InstallOutcome =
  | { readonly kind: "installed" }
  /** pnpm skipped build scripts it was not told to run; the project still works, the hint fixes it. */
  | {
      readonly kind: "ignored-builds";
      readonly packages: readonly string[];
      readonly hint: string;
    }
  | {
      readonly kind: "failed";
      readonly command: string;
      readonly exitCode: number | null;
    };

/** `NODE_ENV=development`, because pnpm skips devDependencies in production. */
export async function runInstall(
  rootDir: string,
  command: Command,
  log: (line: string) => void,
): Promise<InstallOutcome> {
  const child = spawn(command.bin, command.args, {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["inherit", "inherit", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  if (exitCode === 0) return { kind: "installed" };
  const ignored = IGNORED_BUILDS.exec(stderr);
  if (ignored) {
    const packages = (ignored[1] ?? "").split(",").map((entry) => entry.trim());
    const hint = "Run pnpm approve-builds to allow them.";
    log(`pnpm skipped the build scripts of ${packages.join(", ")}. ${hint}`);
    return { kind: "ignored-builds", packages, hint };
  }
  return { kind: "failed", command: formatCommand(command), exitCode };
}

const IGNORED_BUILDS =
  /ERR_PNPM_IGNORED_BUILDS\]?\s*Ignored build scripts:\s*([^\n]+?)\.?\s*$/m;
