import type { AddonName } from "../addons/index.js";
import { indentLines } from "../edit/ops.js";
import { projectFiles, templateFiles, writeFiles } from "../files.js";
import { uncommittedChanges } from "../git.js";
import { commandsFor, formatCommand, type PackageManager } from "../package-manager.js";
import type { ProjectLayout } from "./addon.js";
import { type AddPlan, type ManualChange, planAddons } from "./plan.js";
import {
  commitStaging,
  discardStaging,
  generateInStaging,
  installDependencies,
  type ManifestSnapshot,
  pendingInstallCommands,
  restoreManifests,
  snapshotManifests,
  stageProject,
} from "./transaction.js";

/**
 * The framework tools a run needs after files are staged. `parlor add` passes the same code
 * `parlor typegen` and `parlor db generate` run, so this package stays free of the toolchain.
 * Each takes the directory to run in, because the transaction runs them against the staging
 * copy, never against the project.
 */
export interface AddTools {
  routeTree(rootDir: string): Promise<void>;
  migration(rootDir: string, name: string): Promise<void>;
}

export interface AddRequest {
  readonly layout: ProjectLayout;
  readonly addons: readonly AddonName[];
  readonly packageManager: PackageManager;
  readonly tools: AddTools;
  /** `dry-run` plans and reports without writing or installing. */
  readonly mode: "apply" | "dry-run";
  /** `false` (`--no-install`) writes files only and reports the install and generate commands. */
  readonly install: boolean;
  /** `false` (`--no-git-check`) skips the refusal on uncommitted changes. */
  readonly gitCheck: boolean;
  readonly log: (line: string) => void;
}

type ReadyPlan = Extract<AddPlan, { kind: "ready" }>;

export type AddResult =
  | { readonly kind: "done"; readonly addons: readonly AddonName[] }
  | {
      readonly kind: "blocked";
      readonly addons: readonly AddonName[];
      readonly manual: readonly ManualChange[];
    }
  | { readonly kind: "planned"; readonly plan: ReadyPlan }
  /** The project has uncommitted changes and `gitCheck` is on: nothing was touched. */
  | {
      readonly kind: "dirty";
      readonly addons: readonly AddonName[];
      readonly files: readonly string[];
    }
  /** `pending` lists commands skipped by `--no-install`, to run before the next `parlor dev`. */
  | {
      readonly kind: "applied";
      readonly plan: ReadyPlan;
      /** Files the generators wrote, beyond the plan's own writes. */
      readonly generated: readonly string[];
      readonly pending: readonly string[];
    }
  /**
   * Nothing reached the project: a failed install restored `package.json` and the lockfile; a
   * failed or unvalidated generation discarded the staging copy and restored them too. Only
   * `node_modules` may hold more than before, which is a cache, not state.
   */
  | {
      readonly kind: "failed";
      readonly addons: readonly AddonName[];
      readonly stage: "install" | "generate";
      readonly message: string;
    };

/**
 * The one entry point behind `parlor add`. A transaction in stages, so a failure never leaves
 * an app that cannot boot and a crash is finished by the next run (every step it already did
 * is `done`):
 *   1. plan (no writes); `blocked`, `done` and `dry-run` return here
 *   2. git: `uncommittedChanges(rootDir)` non-empty and `gitCheck` -> `dirty`
 *   3. install: snapshot `package.json` and the lockfile; round one adds every dependency whose
 *      version is known (`<pm> add`), round two resolves each `FromPackage` from the manifest
 *      round one installed and adds those; any failure restores the snapshot -> `failed`
 *   4. stage: `stageProject` copies the tree (minus node_modules, .git, .parlor) into
 *      `.parlor/add/<run id>/` and lays the planned writes over it
 *   5. generate: each pending generation's tool runs in the staging dir; `generationDone`
 *      against the staging copy must then hold, else the copy is discarded -> `failed`
 *   6. commit: every staged file whose bytes differ from the project is written through a temp
 *      file and a rename; the staging dir is removed
 * `install: false` skips 3 and 5; `pending` then names the install commands and a second
 * `parlor add` to generate.
 */
export async function addAddons(request: AddRequest): Promise<AddResult> {
  const { layout, addons, packageManager, log } = request;
  const { rootDir } = layout;
  const plan = await planAddons(layout, addons, projectFiles(rootDir), templateFiles());
  if (plan.kind === "done") return plan;
  if (plan.kind === "blocked") return { kind: "blocked", addons, manual: plan.manual };
  if (request.mode === "dry-run") return { kind: "planned", plan };
  if (request.gitCheck) {
    const files = await uncommittedChanges(rootDir);
    if (files && files.length > 0) return { kind: "dirty", addons, files };
  }
  if (!request.install) {
    await writeFiles(
      rootDir,
      new Map(plan.writes.map((write) => [write.path, write.content])),
    );
    const pm = commandsFor(packageManager);
    const rerun =
      plan.generate.length > 0 ||
      plan.dependencies.some((dependency) => typeof dependency.version !== "string");
    return {
      kind: "applied",
      plan,
      generated: [],
      pending: [
        ...pendingInstallCommands(plan.dependencies, packageManager).map(formatCommand),
        ...(rerun ? [pm.exec("parlor", ["add", ...addons])] : []),
      ],
    };
  }
  let snapshot: ManifestSnapshot | undefined;
  if (plan.dependencies.length > 0) {
    snapshot = await snapshotManifests(rootDir);
    const installed = await installDependencies(
      rootDir,
      plan.dependencies,
      packageManager,
      projectFiles(rootDir),
      log,
    );
    if (!installed.ok) {
      await restoreManifests(rootDir, snapshot);
      return { kind: "failed", addons, stage: "install", message: installed.message };
    }
  }
  const staging = await stageProject(rootDir, plan.writes);
  if (plan.generate.length > 0) {
    log(
      `generating ${plan.generate
        .map((generation) =>
          generation.kind === "route-tree"
            ? "the route tree"
            : `the migration "${generation.name}"`,
        )
        .join(", then ")}`,
    );
    const generated = await generateInStaging(
      layout,
      staging,
      plan.generate,
      request.tools,
    );
    if (!generated.ok) {
      await discardStaging(staging);
      if (snapshot) await restoreManifests(rootDir, snapshot);
      return { kind: "failed", addons, stage: "generate", message: generated.message };
    }
  }
  const written = await commitStaging(rootDir, staging);
  const planned = new Set(plan.writes.map((write) => write.path));
  return {
    kind: "applied",
    plan,
    generated: written.filter((path) => !planned.has(path)),
    pending: [],
  };
}

function planLines(plan: ReadyPlan, generated: readonly string[]): string[] {
  const width = Math.max(
    0,
    ...plan.writes
      .filter((write) => write.change === "update")
      .map((write) => write.path.length),
  );
  return [
    ...plan.writes
      .filter((write) => write.change === "create")
      .map((write) => `+ ${write.path}`),
    ...plan.writes
      .filter((write) => write.change === "update")
      .map((write) =>
        write.summary.length > 0
          ? `~ ${write.path.padEnd(width)}  ${write.summary.join(", ")}`
          : `~ ${write.path}`,
      ),
    ...(generated.length > 0 ? [`~ ${generated.join(", ")}`] : []),
  ];
}

/** The terminal text for a result and the exit code: 1 for `blocked`, `dirty` and `failed`, else 0. */
export function formatAddResult(
  result: AddResult,
  manager: PackageManager,
): { readonly text: string; readonly exitCode: 0 | 1 } {
  const pm = commandsFor(manager);
  const command = (addons: readonly AddonName[]) => `parlor add ${addons.join(" ")}`;
  switch (result.kind) {
    case "done":
      return {
        text: `${result.addons.join(", ")} ${result.addons.length === 1 ? "is" : "are"} already added. Nothing changed.`,
        exitCode: 0,
      };
    case "blocked": {
      const files = [...new Set(result.manual.map((change) => change.file))];
      const rerun = pm.exec("parlor", ["add", ...result.addons]);
      return {
        text: [
          `${command(result.addons)}: cannot edit ${files.join(", ")} safely, so nothing was changed.`,
          ...result.manual.flatMap((change) => [
            "",
            `  ${change.file}: ${change.reason}`,
            `  Make this change by hand, then run \`${rerun}\` again:`,
            "",
            indentLines(change.change, "    "),
          ]),
        ].join("\n"),
        exitCode: 1,
      };
    }
    case "dirty":
      return {
        text: `${command(result.addons)}: this project has uncommitted changes (${result.files.join(", ")}).\nCommit or stash them so the change is easy to review, or pass --no-git-check.`,
        exitCode: 1,
      };
    case "failed":
      return {
        text: `${command(result.addons)}: ${result.message}\nNothing was changed.`,
        exitCode: 1,
      };
    case "planned": {
      const installs = result.plan.dependencies.map((dependency) =>
        typeof dependency.version === "string"
          ? `${dependency.name}@${dependency.version}`
          : `${dependency.name} (pinned by ${dependency.version.fromPackage})`,
      );
      return {
        text: [
          ...planLines(result.plan, []),
          ...(installs.length > 0 ? [`would install ${installs.join(", ")}`] : []),
          "Nothing was written (--dry-run).",
        ].join("\n"),
        exitCode: 0,
      };
    }
    case "applied":
      return {
        text: [
          ...planLines(result.plan, result.generated),
          ...result.plan.notes,
          ...(result.pending.length > 0
            ? ["", "Run these to finish:", ...result.pending.map((line) => `  ${line}`)]
            : []),
        ].join("\n"),
        exitCode: 0,
      };
  }
}
