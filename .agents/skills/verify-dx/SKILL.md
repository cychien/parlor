---
name: verify-dx
description: "Drive Parlor the way a developer outside the monorepo does: publish every public package from this checkout to the local Verdaccio registry at a fresh version, make an empty project folder with its own HOME, install from the registry with pnpm or npm, and run the CLI, tsc and parlor dev there. Use it whenever a change must be proved on a published install (create-parlor, parlor add, package exports, bins, the vite field, @parlor/config/tsconfig) rather than on workspace links."
---

# Verify DX

Workspace links hide every packaging bug: a missing export, a bin the tarball does not ship, a `workspace:` specifier, a tsconfig path that only resolves inside the repo. This skill proves a change on packages a developer would install. Everything goes through one CLI:

```sh
D=.agents/skills/verify-dx/scripts/dx.mjs
$D --help
```

## Registry and publishing

- The registry is Verdaccio on `http://127.0.0.1:4873/`, from `~/cychien/parlor-dx/registry` (`PARLOR_DX_REGISTRY_DIR`). `$D registry` starts it when it is down. `@parlor/*` is served only from it; every other package is proxied from npmjs and cached, so a second install is warm.
- `$D publish` runs `pnpm build`, copies every non-private `packages/*` into a stage folder, sets every version to `0.0.0-dx.<UTC stamp>`, installs the stage from the repo lockfile and the local store, and runs `pnpm -r publish` there (moving `latest`, so `pnpm create parlor` picks it up), so `workspace:` and `catalog:` are rewritten and `publishConfig` is applied exactly as a real `pnpm publish` does. The checkout is never modified. `--no-build` skips the build when `dist` is current.
- A fresh version per publish means no unpublish, and no client cache can serve a stale tarball for the same version. `$D version` prints the last one; `~/.cache/parlor-verify-dx/published.json` records it with the commit and whether the tree was dirty.
- Publish after every framework change you want to prove. A project installed before keeps its old version until you reinstall it with the new one.

## Projects

```sh
$D new demo --fixture minimal     # empty folder + .npmrc, filled from fixtures/minimal
$D run demo -- pnpm install       # any command, isolated
$D run demo -- pnpm exec parlor typegen
$D up demo [--pm npm]             # dev script in the background, JSON when ready
$D down demo
$D rm demo
```

- `new` gives the HOME a git identity (`DX Developer <dx@example.com>`), as a developer's machine has, and writes the registry into both `app/.npmrc` and `home/.npmrc`, because pnpm 11 ignores `npm_config_registry` in the environment and a project that `create` makes below `app/` reads only the user config.
- A project lives in `~/.cache/parlor-verify-dx/projects/<name>/` (`PARLOR_DX_HOME`) as `app/` (the project) and `home/` (its HOME). `run` and `up` set `HOME`, the XDG dirs, the registry, a shared npm cache and pnpm store under the root, and drop every inherited `npm_*`, `pnpm_*`, `PARLOR_*`, `NODE_OPTIONS` and `VITEST*` variable, so nothing of the repo or of your own HOME (Claude Code config, Keychain-backed grants, a global pnpm) leaks in. `PATH` is kept.
- `new` with no fixture leaves an empty folder for flows that create the project themselves (`pnpm create parlor`). A fixture's `package.json` uses `{{VERSION}}` for `@parlor/*`, replaced with the last published version.
- `up` needs port 3000 free (the server's default `server.port`; a project cannot override it from the command line) and picks the first free web port from 5173 for `--port`, because other apps on this machine hold 5173. It returns when `GET <web>/` and `GET <server>/_parlor/manifest` answer, with `readyMs`. Output goes to `<project>/dev.log`. One project is up at a time.

## Fixtures

- `minimal`: not hello. One action `ping` returning `{ "pong": true }`, one route rendering `pong` in an `<h1 class="text-[#0a0b0c]">`, Tailwind v4 through the `vite` field of `parlor.config.ts`, `tsconfig.json` extending `@parlor/config/tsconfig`, and a `pnpm-workspace.yaml` that allows esbuild's build script (pnpm 11 fails the install on ignored builds).

## What to know

- pnpm 11 adds the fresh `@parlor/*` versions to `minimumReleaseAgeExclude` in the project's `pnpm-workspace.yaml` on first install instead of refusing them; that is pnpm's non-strict release-age policy, not something to fix.
- npm 11 warns that esbuild's install scripts are not in `allowScripts`; the install still exits 0.
- `pnpm exec` in pnpm 11 verifies the lockfile against supply-chain policies first; its lines in a transcript are pnpm's, not Parlor's.
- Drive the page with chrome-devtools-axi under a named session (`CHROME_DEVTOOLS_AXI_SESSION=dx-<name>`), never the default one.
