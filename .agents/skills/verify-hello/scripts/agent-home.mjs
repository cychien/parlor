import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const DROPPED_ENV = /^(CLAUDECODE|CLAUDE_|ANTHROPIC_|CODEX_|OPENAI_)/;

/** The login the agents read: Codex's file login and, for Claude Code, the login Keychain. */
export function loginLinks(realHome = homedir()) {
  return [
    {
      link: ["Library", "Keychains"],
      target: join(realHome, "Library", "Keychains"),
      for: "claude",
    },
    {
      link: [".codex", "auth.json"],
      target: join(realHome, ".codex", "auth.json"),
      for: "codex",
    },
  ];
}

/**
 * An isolated HOME: an empty `~/.parlor`, read-only links to the developer's agent logins
 * and a `bin/open` that records the URL the host would open instead of opening it.
 */
export function prepareHome(home, realHome = homedir()) {
  const root = resolve(home);
  if (root === resolve(realHome)) throw new Error("the isolated HOME is the real HOME");
  mkdirSync(join(root, ".parlor"), { recursive: true });
  const linked = [];
  for (const { link, target, for: agent } of loginLinks(realHome)) {
    const path = join(root, ...link);
    mkdirSync(join(path, ".."), { recursive: true });
    if (!existsSync(target)) {
      linked.push({ agent, path, target, linked: false });
      continue;
    }
    try {
      lstatSync(path);
    } catch {
      symlinkSync(target, path);
    }
    linked.push({ agent, path, target, linked: true });
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  const shim = join(root, "bin", "open");
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(root, "opened-urls.log")}"\n`,
  );
  chmodSync(shim, 0o755);
  return { home: root, openedUrls: join(root, "opened-urls.log"), linked };
}

/** The environment of anything the isolated host starts: its HOME, the open shim, no inherited agent session. */
export function hostEnv(home, base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!DROPPED_ENV.test(key)) env[key] = value;
  }
  env.HOME = resolve(home);
  env.PATH = [join(resolve(home), "bin"), base.PATH ?? ""].join(delimiter);
  return env;
}

/** The unpublished host CLI in a checkout that has node_modules (an instance snapshot). */
export function hostBin(repoDir) {
  return join(repoDir, "packages", "agent-host", "bin", "parlor-host-dev.mjs");
}

/** `claude auth status` and `codex login status` under the isolated HOME. */
export function agentLoginStatus(home) {
  const env = hostEnv(home);
  const claude = spawnSync("claude", ["auth", "status"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  let claudeIn = false;
  try {
    claudeIn = JSON.parse(claude.stdout).loggedIn === true;
  } catch {
    claudeIn = false;
  }
  const codex = spawnSync("codex", ["login", "status"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    claude: {
      loggedIn: claudeIn,
      detail: (claude.stdout || claude.stderr || "").trim().slice(0, 300),
    },
    codex: {
      loggedIn: codex.status === 0,
      detail: `${codex.stdout ?? ""}${codex.stderr ?? ""}`.trim().slice(0, 300),
    },
  };
}

const AUTH_DROPS = [
  /^import \{ betterAuthProvider \} from "@parlor\/auth";\n/m,
  /^import \{ betterAuth \} from "better-auth";\n/m,
  /^import \{ drizzleAdapter \} from "better-auth\/adapters\/drizzle";\n/m,
  /^import \{ authOptions \} from "\.\/auth\.js";\n/m,
  /^import \* as schema from "\.\/schema\/index\.js";\n/m,
  /^const auth = betterAuth\(\{[\s\S]*?^\}\);\n\n?/m,
  /^[ \t]*auth: betterAuthProvider\(\{ instance: auth \}\),\n/m,
];

/** hello's `server.ts` with the `auth` option and everything only it uses removed. */
export function withoutAuth(source) {
  let text = source;
  for (const pattern of AUTH_DROPS) {
    if (!pattern.test(text)) {
      throw new Error(
        `--no-auth: examples/hello/server.ts no longer has ${pattern}; update the driver`,
      );
    }
    text = text.replace(pattern, "");
  }
  if (/better-?auth|\bauth\b/i.test(text)) {
    throw new Error(`--no-auth: server.ts still mentions auth after removal:\n${text}`);
  }
  return text;
}
