import { relative } from "node:path";

import {
  commandsFor,
  type CreatedProject,
  DOCS_URL,
  formatCommand,
} from "@parlor/scaffold";

const COLUMN = 31;

function step(command: string, note?: string): string {
  return note ? `  ${command.padEnd(COLUMN)}${note}` : `  ${command}`;
}

export function nextSteps(project: CreatedProject, cwd: string): readonly string[] {
  const pm = commandsFor(project.packageManager);
  const where = relative(cwd, project.directory) || ".";
  return [
    `Created ${where} with ${project.packageManager.name}.`,
    "",
    ...(where === "." ? [] : [step(`cd ${where}`)]),
    ...(project.install.kind === "installed" || project.install.kind === "ignored-builds"
      ? []
      : [step(formatCommand(pm.install))]),
    step(pm.run("dev"), "web app on http://localhost:5173, API on :3000"),
    ...project.addons.deferred.map((addon) =>
      step(pm.exec("parlor", ["add", addon]), `finish adding ${addon}`),
    ),
    ...(project.addons.applied.includes("auth") ||
    project.addons.deferred.includes("auth")
      ? []
      : [step(pm.exec("parlor", ["add", "auth"]), "sign-in with Better Auth")]),
    step(
      pm.exec("parlor", ["dev", "--target", "mac"]),
      "the same app as a desktop window",
    ),
    "",
    "Open http://localhost:5173 and press Agent to chat with your coding agent.",
    `AGENTS.md tells coding agents how this project works. Docs: ${DOCS_URL}/llms.txt`,
    ...(project.git.kind === "failed"
      ? [
          "",
          `No initial commit: ${project.git.message.split("\n").find((line) => line.trim()) ?? "git failed"}. Commit the files once git works.`,
        ]
      : []),
  ];
}

export function dryRunReport(project: CreatedProject): readonly string[] {
  const name = project.identity.directoryName;
  return [
    ...project.files.map((path) => `${name}/${path}`),
    "",
    `${project.files.length} files would be written to ${name}. Nothing was.`,
  ];
}
