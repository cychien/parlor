import type { Op } from "../edit/ops.js";

/** Stands for `server.entry` from `parlor.config.ts`, wherever the app keeps it. */
export const SERVER_ENTRY: unique symbol = Symbol("server entry");
export type ProjectFile = string | typeof SERVER_ENTRY;

/** Folders under `templates/` in this package. `default` is the full default app. */
export type TemplateName = "default" | "auth";

/**
 * Where the project keeps what add-ons touch, from `parlor.config.ts`. Built by the caller
 * (`parlor add` loads the config), so this package never loads it.
 */
export interface ProjectLayout {
  readonly rootDir: string;
  readonly serverEntry: string;
  readonly schemaDir: string;
  readonly migrationsDir: string;
  /** The generated route tree, `src/routeTree.gen.ts` unless `web.routeTree` moves it. */
  readonly routeTree: string;
}

/** Payload files import each other by relative path, so they need the default layout. */
export interface LayoutRequirement {
  readonly serverAtRoot?: true;
  readonly schemaDir?: string;
  readonly routesDir?: string;
}

/**
 * Every file under `dir` of the template, copied to the same path in the project. A file that
 * already exists is the developer's and is never overwritten.
 */
export interface Payload {
  readonly template: TemplateName;
  readonly dir: string;
}

export interface FileEdit {
  readonly file: ProjectFile;
  readonly ops: readonly Op[];
}

/**
 * Renders `<component />` once in the app's UI. Done when any module under `src/` imports
 * `component` from `module`, wherever the developer put it, so the manual change for a missing
 * `into` file satisfies the next run.
 */
export interface Mount {
  readonly component: string;
  /** Project path of the module that exports `component`. */
  readonly module: string;
  readonly into: { readonly file: string; readonly parent: string };
}

/**
 * A pin another installed package owns: `better-auth` is whatever the project's `@parlor/auth`
 * declares, read from its manifest in `node_modules` after that package is installed.
 */
export interface FromPackage {
  readonly fromPackage: string;
  readonly dependency: string;
}

export type DependencyVersion =
  /** Exactly this package's version: every `@parlor/*` package releases with it. */
  | "framework"
  /** An explicit range, for a third-party package nothing in the framework pins. */
  | (string & {})
  | FromPackage;

export interface EnvVar {
  readonly name: string;
  readonly example: string;
  readonly description: string;
}

/**
 * A step a framework tool runs after the files are in place. Each kind declares its outputs
 * through `done`: the plan uses it to skip finished work, the transaction uses it to validate
 * the staging copy before anything reaches the project.
 */
export type Generation =
  /** `parlor typegen`; done when the route tree lists every route id in `routes`. */
  | { readonly kind: "route-tree"; readonly routes: readonly string[] }
  /** `parlor db generate --name <name>`; done when the latest snapshot has every table. */
  | {
      readonly kind: "migration";
      readonly name: string;
      readonly tables: readonly string[];
    };

export interface Addon {
  /** One line for `parlor add --help` and the docs. */
  readonly summary: string;
  readonly requires: LayoutRequirement;
  readonly dependencies: Readonly<Record<string, DependencyVersion>>;
  readonly files: readonly Payload[];
  readonly edits: readonly FileEdit[];
  readonly mounts: readonly Mount[];
  /** Lines added to `.env.example` when missing. */
  readonly env: readonly EnvVar[];
  readonly generate: readonly Generation[];
  /** Printed after a run that changed something. */
  readonly notes: readonly string[];
}

export function defineAddon<const A extends Addon>(addon: A): A {
  return addon;
}
