---
title: create-parlor
description: Create a new Parlor app.
---

```sh
pnpm create parlor my-app
npm create parlor@latest my-app
yarn create parlor my-app
bun create parlor my-app
```

It asks only for the project name, then writes the app, installs its dependencies with the package manager that ran it, and makes the first git commit.

| Option                                     | Meaning                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `-y, --yes`                                | take every default and never prompt; the name defaults to `my-parlor-app` |
| `--package-manager <npm\|pnpm\|yarn\|bun>` | override the detected package manager                                     |
| `--add <auth\|agent>`                      | run `parlor add` after the install; repeatable                            |
| `--no-install`                             | skip the install                                                          |
| `--no-git`                                 | skip the first commit                                                     |
| `--dry-run`                                | list the files and write nothing                                          |

Without a terminal, for example from an agent or CI, pass the name or `--yes`; otherwise it exits 1 and prints the command to run.

## The app it creates

| Path                     | What                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `actions/`               | the actions, and a test that runs them on an in-memory database |
| `schema/`, `migrations/` | the tables and their migrations                                 |
| `src/routes/`            | the pages                                                       |
| `src/agent/`             | the agent sidebar, yours to change                              |
| `parlor.config.ts`       | the app's name, id and Vite options                             |
| `AGENTS.md`              | what a coding agent needs to know to work on the app            |
