import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(PACKAGE, "..", "..");
const SDK_IMPORT =
  /from\s+["']@agentclientprotocol\/sdk["']|import\(\s*["']@agentclientprotocol\/sdk["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts|mjs|js)$/.test(name) ? [path] : [];
  });
}

interface PatchedFile {
  /** Each run of lines the patch adds; the whole file in one run when the patch creates it. */
  readonly runs: readonly string[];
}

function filesOfPatch(patch: string): Map<string, PatchedFile> {
  const files = new Map<string, PatchedFile>();
  for (const section of patch.split(/^diff --git /m).slice(1)) {
    const name = /^a\/(\S+)/.exec(section)?.[1];
    if (!name) continue;
    const runs: string[][] = [[]];
    for (const line of section.split("\n").slice(1)) {
      if (line.startsWith("+") && !line.startsWith("+++"))
        runs.at(-1)!.push(line.slice(1));
      else if (runs.at(-1)!.length > 0) runs.push([]);
    }
    files.set(name, { runs: runs.map((run) => run.join("\n")) });
  }
  return files;
}

const OPENING = "([{";
const CLOSING = ")]}";

/** The top-level statements of a TypeScript file, comments removed. */
function statementsOf(text: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  const open: string[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    const next = text[at + 1];
    if (char === "/" && next === "/") {
      while (at < text.length && text[at] !== "\n") at += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      at = text.indexOf("*/", at + 2) + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let end = at + 1;
      while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
      current += text.slice(at, end + 1);
      at = end;
      continue;
    }
    if (CLOSING.includes(char) && depth === 0) {
      current = "";
      continue;
    }
    current += char;
    if (OPENING.includes(char)) {
      depth += 1;
      open.push(CLOSING[OPENING.indexOf(char)]!);
    } else if (CLOSING.includes(char)) {
      depth -= 1;
      open.pop();
      const blockEnded = char === "}" && depth === 0;
      const rest = text.slice(at + 1).match(/^\s*(\S)/)?.[1];
      if (blockEnded && rest !== ";" && rest !== "," && rest !== "." && rest !== ")") {
        const head = current.trim();
        const isBlock = /^(export\s+)?(async\s+)?(function|interface|class|enum)\b/.test(
          head,
        );
        const hasBody =
          !/^(export\s+)?(async\s+)?function\b/.test(head) ||
          endOfSignature(head) < head.length;
        if (isBlock && hasBody) {
          statements.push(current.trim());
          current = "";
        }
      }
    } else if (char === ";" && depth === 0) {
      statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) statements.push(`${current.trim()}${open.reverse().join("")}`);
  return statements;
}

const compact = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/\s*([(){}[\],;:<>|&=?])\s*/g, "$1")
    .replace(/[,;](?=[)\]}>])/g, "");

function endOfSignature(statement: string): number {
  let parens = 0;
  let angles = 0;
  let seenParams = false;
  for (let at = 0; at < statement.length; at += 1) {
    const char = statement[at]!;
    if (char === "(") parens += 1;
    else if (char === ")") {
      parens -= 1;
      if (parens === 0) seenParams = true;
    } else if (parens === 0 && seenParams) {
      if (char === "<") angles += 1;
      else if (char === ">" && statement[at - 1] !== "=") angles -= 1;
      else if (
        char === "{" &&
        angles === 0 &&
        !/[:|&]\s*$/.test(statement.slice(0, at))
      ) {
        return at;
      }
    }
  }
  return statement.length;
}

/** Each export's declaration with its body, comments and `export` keyword left out. */
function signaturesOf(...texts: readonly string[]): Map<string, string> {
  const signatures = new Map<string, string>();
  const add = (name: string, signature: string) =>
    signatures.set(
      name,
      [signatures.get(name), compact(signature)].filter(Boolean).join("\n"),
    );
  for (const statement of texts.flatMap(statementsOf)) {
    if (!statement.startsWith("export")) continue;
    const declaration = statement.replace(/^export\s+(default\s+)?/, "");
    const named = /^(?:async\s+)?(function|interface|type|class|enum)\s+(\w+)/.exec(
      declaration,
    );
    if (named) {
      const [, kind, name] = named;
      const keep =
        kind === "function"
          ? declaration.slice(0, endOfSignature(declaration)).replace(/^async\s+/, "")
          : declaration;
      add(name!, keep);
    } else if (/^(const|let)\s/.test(declaration)) {
      const name = /^(?:const|let)\s+(\w+)/.exec(declaration)![1]!;
      const [head] = declaration.split(/(?<![=!<>])=(?![=>])/);
      const annotated = /^(?:const|let)\s+\w+\s*:/.test(declaration);
      const callee = /=\s*([\w.]+(?:<[^(]*>)?)\(/.exec(declaration)?.[1];
      add(name, annotated ? head! : `${name} = ${callee ?? ""}`);
    } else if (/^(type\s+)?\{/.test(declaration) || declaration.startsWith("*")) {
      for (const [, name] of declaration.matchAll(/(?:\btype\s+)?(\w+)(?=\s*[,}])/g)) {
        if (name !== "type") add(name!, "re-export");
      }
    }
  }
  return signatures;
}

interface Difference {
  readonly file: string;
  readonly symbol: string;
  readonly kind: "changed" | "missing" | "added";
}

function differences(
  file: string,
  skeleton: readonly string[],
  actual: string,
  only?: readonly string[],
): Difference[] {
  const wanted = signaturesOf(...skeleton);
  const found = signaturesOf(actual);
  const names = new Set([...wanted.keys(), ...found.keys()]);
  const out: Difference[] = [];
  for (const symbol of [...names].sort()) {
    if (only && !only.includes(symbol)) continue;
    const before = wanted.get(symbol);
    const after = found.get(symbol);
    if (before === undefined) out.push({ file, symbol, kind: "added" });
    else if (after === undefined) out.push({ file, symbol, kind: "missing" });
    else if (before !== after) out.push({ file, symbol, kind: "changed" });
  }
  return out;
}

describe("the phase 4 skeleton contract", () => {
  it("K4: acp.ts is the only file that imports the ACP SDK", () => {
    const importers = ["packages", "examples"]
      .flatMap((root) => sources(join(REPOSITORY, root)))
      .filter((file) => SDK_IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPOSITORY, file));
    expect(importers).toEqual(["packages/agent-host/src/acp.ts"]);
  });

  it("K4: policy.spec-d.ts holds under the type checker", () => {
    const tsc = join(PACKAGE, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["-p", "tsconfig.spec.json", "--noEmit"], {
        cwd: PACKAGE,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 60_000);
});

const PATCH = join(REPOSITORY, "docs", "features", "inline-agent", "skeleton.patch");

const source = (file: string) => readFileSync(join(REPOSITORY, file), "utf8");

function drift(file: string, only?: readonly string[]): Difference[] {
  const patched = filesOfPatch(readFileSync(PATCH, "utf8")).get(file);
  if (!patched) throw new Error(`${file} is not in the skeleton patch`);
  return differences(file, patched.runs, source(file), only);
}

const DIFFERENCES: Readonly<
  Record<string, { readonly agreed: boolean; readonly why: string }>
> = {
  "chat/src/model.ts TurnStatus changed": {
    agreed: true,
    why: "addendum D9: the failure the sidebar shows",
  },
  "capabilities/src/device-key/index.ts CapacitorDeviceKeyModule missing": {
    agreed: false,
    why: "the native adapters report unavailable until phase 6, so they load nothing",
  },
  "capabilities/src/device-key/index.ts TauriInvoke missing": {
    agreed: false,
    why: "the native adapters report unavailable until phase 6, so they load nothing",
  },
  "capabilities/src/device-key/tauri.ts TauriInvoke missing": {
    agreed: false,
    why: "the native adapters report unavailable until phase 6, so they load nothing",
  },
  "capabilities/src/device-key/tauri.ts tauriDeviceKey changed": {
    agreed: false,
    why: "no `load` parameter: nothing to load while unavailable",
  },
  "capabilities/src/device-key/capacitor.ts CapacitorDeviceKeyModule missing": {
    agreed: false,
    why: "the native adapters report unavailable until phase 6, so they load nothing",
  },
  "capabilities/src/device-key/capacitor.ts capacitorDeviceKey changed": {
    agreed: false,
    why: "no `load` parameter: nothing to load while unavailable",
  },
  "capabilities/src/device-key/index.ts canonicalBytes added": {
    agreed: false,
    why: "the one encoder the device and the account both sign and verify with",
  },
  "capabilities/src/device-key/index.ts decodeBase64url added": {
    agreed: false,
    why: "the one encoder the device and the account both sign and verify with",
  },
  "capabilities/src/device-key/index.ts encodeBase64url added": {
    agreed: false,
    why: "the one encoder the device and the account both sign and verify with",
  },
  "capabilities/src/device-key/index.ts enrollmentBytes added": {
    agreed: false,
    why: "addendum D5: the proof signs the challenge and both public keys, so device and account share the bytes",
  },
  "agent-host/src/policy.ts changePolicy added": {
    agreed: false,
    why: "addendum D7: `parlor-host config` writes policy.json",
  },
  "agent-host/src/policy.ts loadPolicy added": {
    agreed: false,
    why: "addendum D7: the overlay read at the start of each turn",
  },
  "agent-host/src/prompter.ts LocalPrompter changed": {
    agreed: false,
    why: "addendum D8: `signal` closes a dialog whose turn ended",
  },
};

describe("the phase 5 skeleton contract", () => {
  it("K5: every file this phase implements keeps the skeleton's exported signatures, but for the differences listed here", () => {
    const found = [
      ...drift("packages/auth/src/statements.ts"),
      ...drift("packages/auth/src/devices.ts"),
      ...drift("packages/auth/src/client/index.ts", ["DeviceHandle"]),
      ...drift("packages/capabilities/src/device-key/interface.ts"),
      ...drift("packages/capabilities/src/device-key/index.ts"),
      ...drift("packages/capabilities/src/device-key/web.ts"),
      ...drift("packages/capabilities/src/device-key/tauri.ts"),
      ...drift("packages/capabilities/src/device-key/capacitor.ts"),
      ...drift("packages/server/src/auth.ts", [
        "DeviceKeys",
        "PresenceKey",
        "AccountProfile",
      ]),
      ...drift("packages/client/src/session.ts", [
        "SessionDevice",
        "DeviceSource",
        "HostAuthorizer",
        "FrameworkAuth",
      ]),
      ...drift("packages/agent-host/src/trust.ts"),
      ...drift("packages/agent-host/src/policy.ts"),
      ...drift("packages/agent-host/src/prompter.ts", [
        "LocalPrompter",
        "terminalPrompter",
        "macDialogPrompter",
      ]),
      ...drift("packages/agent-host/src/turn.ts", [
        "PROMPT_MAX_AGE_MS",
        "TurnDeps",
        "runTurn",
      ]),
      ...drift("packages/agent-host/src/daemon.ts", ["DaemonDeps"]),
      ...drift("packages/chat/src/model.ts", ["TurnStatus"]),
    ].map(
      ({ file, symbol, kind }) =>
        `${file.split("/").slice(1).join("/")} ${symbol} ${kind}`,
    );
    expect(found.sort()).toEqual(Object.keys(DIFFERENCES).sort());
  });

  it("K5: device-key.spec-d.ts is the skeleton's, unchanged, and holds under the type checker", () => {
    const file = "packages/capabilities/src/device-key/device-key.spec-d.ts";
    const patched = filesOfPatch(readFileSync(PATCH, "utf8")).get(file)!;
    expect(compact(source(file))).toBe(compact(patched.runs.join("\n")));
    const capabilities = join(REPOSITORY, "packages", "capabilities");
    expect(() =>
      execFileSync(
        join(capabilities, "node_modules", ".bin", "tsc"),
        ["-p", "tsconfig.spec.json", "--noEmit"],
        {
          cwd: capabilities,
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  }, 60_000);
});
