import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const INITIAL_COMMIT_MESSAGE = "Initial commit from create-parlor";

export type GitOutcome =
  | { readonly kind: "committed" }
  | { readonly kind: "skipped"; readonly reason: "inside-repository" | "git-missing" }
  | { readonly kind: "failed"; readonly message: string };

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd: directory });
  return stdout;
}

/**
 * `git init -b main`, `git add -A`, one commit. Never fails the create: a missing identity or
 * hook failure becomes `failed` with git's message, and the files stay as they are.
 */
export async function initialCommit(directory: string): Promise<GitOutcome> {
  try {
    await git(directory, ["--version"]);
  } catch {
    return { kind: "skipped", reason: "git-missing" };
  }
  const inside = await git(directory, ["rev-parse", "--is-inside-work-tree"]).then(
    () => true,
    () => false,
  );
  if (inside) return { kind: "skipped", reason: "inside-repository" };
  try {
    await git(directory, ["init", "-b", "main"]);
    await git(directory, ["add", "-A"]);
    await git(directory, ["commit", "-m", INITIAL_COMMIT_MESSAGE]);
    return { kind: "committed" };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    return { kind: "failed", message: stderr || (error as Error).message };
  }
}

/**
 * Paths with uncommitted changes, untracked included, so `parlor add` refuses to edit a tree
 * whose diff the developer could not review afterwards. `undefined` outside a work tree or
 * without git: nothing to check against.
 */
export async function uncommittedChanges(
  directory: string,
): Promise<readonly string[] | undefined> {
  try {
    const output = await git(directory, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      ".",
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^.* -> /, ""));
  } catch {
    return undefined;
  }
}
