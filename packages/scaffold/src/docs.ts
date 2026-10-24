import type { AppIdentity } from "./identity.js";
import { commandsFor, type PackageManager } from "./package-manager.js";
import { DOCS_URL } from "./version.js";

export interface ProjectDocsInput {
  readonly identity: AppIdentity;
  readonly packageManager: PackageManager;
  readonly version: string;
}

/** Rendered per package manager, so every command in it runs as written. */
export function renderReadme({ identity, packageManager }: ProjectDocsInput): string {
  const pm = commandsFor(packageManager);
  return `# ${identity.appName}

A [Parlor](${DOCS_URL}) app. Everything the UI does goes through actions, so your coding agent
can do it too: from the sidebar, over MCP, or over HTTP.

## Develop

\`\`\`sh
${pm.run("dev")}
\`\`\`

Open http://localhost:5173 and press **Agent** to chat with the coding agent on this computer
(Claude Code or Codex). Ask it to add a todo.

| Command | What it does |
| --- | --- |
| \`${pm.run("dev")}\` | App, API and agent host with hot reload |
| \`${pm.run("typecheck")}\` | Regenerate the route tree, then \`tsc\` |
| \`${pm.run("test")}\` | Vitest |
| \`${pm.run("db:generate")}\` | A SQL migration from \`schema/\` |
| \`${pm.run("build")}\` | Production build in \`.parlor/\` |
| \`${pm.exec("parlor", ["add", "auth"])}\` | Sign-in, so each user sees only their own data |
| \`${pm.exec("parlor", ["dev", "--target", "mac"])}\` | The same app as a macOS window |

## Layout

- \`actions/\`: every piece of business logic, as \`defineAction\`. The UI, agents, HTTP and MCP all call these.
- \`schema/\`: the Drizzle tables; \`migrations/\` is generated from them.
- \`src/routes/\`: pages. \`src/agent/\`: the agent sidebar, yours to change.
- \`parlor.config.ts\`: app name, id, ports, and Vite options under \`vite\`.

Learn more at ${DOCS_URL}/getting-started/.
`;
}

/** Facts a coding agent cannot infer from the files, plus where the full docs are. */
export function renderAgentsMd({ packageManager, version }: ProjectDocsInput): string {
  const pm = commandsFor(packageManager);
  return `# AGENTS.md

This is a Parlor ${version} app. Parlor changes faster than your training data: read
${DOCS_URL}/llms.txt (every page, as Markdown) before changing how the app is wired.

## Rules

- Business logic lives only in \`actions/\` as \`defineAction\`. The UI calls actions with
  \`useActionQuery\` and \`useActionMutation\` from \`@parlor/client/react\`, never \`fetch\`.
- Every table has a \`scope\` column and every action filters by \`ctx.scope\`.
- An action that changes data declares \`writes\`; one that reads declares \`reads\`. That is how
  pages refresh when an agent changes something.
- After changing \`schema/\`, run \`${pm.run("db:generate")}\` and commit the migration.
- \`.parlor/\` is generated. Never edit it. There is no \`vite.config.ts\`: Vite options go in the
  \`vite\` field of \`parlor.config.ts\`.
- Add features with \`${pm.exec("parlor", ["add", "<auth|agent>"])}\` instead of wiring them by hand.
- Porting an existing app into this project? Follow ${DOCS_URL}/guides/migrating/ step by step,
  and ask the person before working around anything it lists as not supported yet.

## Commands

- \`${pm.run("dev")}\`: runs until stopped; the app is on http://localhost:5173.
- \`${pm.run("typecheck")}\` and \`${pm.run("test")}\` must pass before you finish.
`;
}
