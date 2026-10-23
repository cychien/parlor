import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Expression } from "@babel/types";

import { parseSource, type SourceFile } from "./source.js";
import {
  type CallSite,
  findCall,
  importedName,
  objectArgument,
  propertyOf,
  valueOf,
} from "./syntax.js";

export type Presence = "installed" | "absent" | "unknown";

/**
 * What the app's server entry passes to `createServer`, read from its syntax without running
 * it. `unknown` when the shape hides it (options built elsewhere, spreads, a plugins variable),
 * so every reader picks the behavior that is safe when it cannot tell.
 */
export interface ServerShape {
  readonly auth: Presence;
  readonly chat: Presence;
}

export const UNKNOWN_SERVER: ServerShape = { auth: "unknown", chat: "unknown" };

const SERVER: CallSite = { callee: "createServer", from: "@parlor/server" };
const CHAT: CallSite = { callee: "chat", from: "@parlor/chat/server" };

/** A call, or a module-scope `const` bound once to a call; anything conditional is unknown. */
function authPresence(file: SourceFile, value: Expression): Presence {
  if (value.type === "Identifier" && value.name === "undefined") return "absent";
  const unwrapped = value.type === "AwaitExpression" ? value.argument : value;
  if (unwrapped.type === "CallExpression" || unwrapped.type === "NewExpression") {
    return "installed";
  }
  if (value.type !== "Identifier") return "unknown";
  const declarators = file.ast.program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    return declaration?.type === "VariableDeclaration" && declaration.kind === "const"
      ? declaration.declarations.filter(
          (declarator) =>
            declarator.id.type === "Identifier" && declarator.id.name === value.name,
        )
      : [];
  });
  const init = declarators.length === 1 ? declarators[0]?.init : undefined;
  const call = init?.type === "AwaitExpression" ? init.argument : init;
  return call?.type === "CallExpression" || call?.type === "NewExpression"
    ? "installed"
    : "unknown";
}

function chatPresence(file: SourceFile, plugins: Expression): Presence {
  if (plugins.type !== "ArrayExpression") return "unknown";
  if (plugins.elements.some((element) => element?.type === "SpreadElement"))
    return "unknown";
  const local = importedName(file, CHAT.callee, CHAT.from);
  if (!local) return "absent";
  return plugins.elements.some(
    (element) =>
      element?.type === "CallExpression" &&
      element.callee.type === "Identifier" &&
      element.callee.name === local,
  )
    ? "installed"
    : "absent";
}

export function inspectServer(file: SourceFile): ServerShape {
  const call = findCall(file, SERVER);
  if (!call.ok) return UNKNOWN_SERVER;
  const argument = objectArgument(file, SERVER, call.value);
  if (!argument.ok) return UNKNOWN_SERVER;
  if (argument.value.kind === "none") return { auth: "absent", chat: "absent" };
  const auth = propertyOf(file, argument.value.node, "auth");
  const plugins = propertyOf(file, argument.value.node, "plugins");
  if (!auth.ok || !plugins.ok) return UNKNOWN_SERVER;
  return {
    auth: auth.value ? authPresence(file, valueOf(auth.value)) : "absent",
    chat: plugins.value ? chatPresence(file, valueOf(plugins.value)) : "absent",
  };
}

export async function inspectServerEntry(
  rootDir: string,
  entry: string,
): Promise<ServerShape> {
  const text = await readFile(join(rootDir, entry), "utf8").catch(() => undefined);
  if (text === undefined) return UNKNOWN_SERVER;
  try {
    return inspectServer(parseSource(entry, text));
  } catch {
    return UNKNOWN_SERVER;
  }
}
