# @parlor/cli

```sh
pnpm add -D @parlor/cli
```

Run the commands through the package manager: `pnpm parlor <command>`, `npx parlor <command>`.

| Command                                                                   | What it does                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parlor dev [--target <t>] [--port <p>] [--device <d>] [--no-agent-host]` | runs the server, the web app and, without sign-in, the agent host; `--target` is `web`, `mac`, `windows`, `linux`, `ios` or `android`, or several joined by commas (`web,mac`) sharing one server; a busy server or web port moves to the next free one; one `parlor dev` per project at a time |
| `parlor build [--target <t>] [--preset <p>]`                              | builds for a target; the web target builds the server for a deploy preset, and warns that serverless presets are not supported yet; see [Deploy](/parlor/guides/deploy/)                                                                                                                        |
| `parlor deploy [--preset <p>]`                                            | builds and deploys the server to its platform                                                                                                                                                                                                                                                   |
| `parlor db generate [--name <n>]`                                         | writes a SQL migration from `schema/`                                                                                                                                                                                                                                                           |
| `parlor db migrate`                                                       | applies pending migrations                                                                                                                                                                                                                                                                      |
| `parlor add <addon...> [--dry-run] [--no-install] [--no-git-check]`       | adds `auth` or `agent` by editing the project's files; see [Auth](/parlor/guides/auth/)                                                                                                                                                                                                         |
| `parlor typegen`                                                          | writes `src/routeTree.gen.ts` without starting Vite                                                                                                                                                                                                                                             |

## parlor add

- It refuses a project with uncommitted changes so its edits are one diff; `--no-git-check` skips that.
- `--dry-run` prints the files it would create and change.
- `--no-install` writes the files and prints the install command plus a second `parlor add` that finishes the generated files.
- When it cannot edit a file safely it changes nothing, exits 1, and prints the code to add by hand.

## Generated files

Everything under `.parlor/` is generated: the database in development, the native projects, the build output. Never edit it; add it to `.gitignore`.
