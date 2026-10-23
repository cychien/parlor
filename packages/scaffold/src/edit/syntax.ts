import type {
  CallExpression,
  Expression,
  Node,
  ObjectExpression,
  ObjectProperty,
} from "@babel/types";

import type { SourceFile } from "./source.js";

/** A call found by what it calls: `createServer` imported from `@parlor/server`, under any local name. */
export interface CallSite {
  readonly callee: string;
  readonly from: string;
}

export type Found<T> = { readonly ok: true; readonly value: T } | Unsafe;
export interface Unsafe {
  readonly ok: false;
  readonly reason: string;
}

export const unsafe = (reason: string): Unsafe => ({ ok: false, reason });
const found = <T>(value: T): Found<T> => ({ ok: true, value });

export function textOf(file: SourceFile, node: Node): string {
  return file.text.slice(node.start ?? 0, node.end ?? 0);
}

export function forEachNode(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments")) continue;
    const children: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (
        child &&
        typeof child === "object" &&
        typeof (child as Node).type === "string"
      ) {
        forEachNode(child as Node, visit);
      }
    }
  }
}

/** The local name a value import of `name` from `from` binds, following `as` renames. */
export function importedName(
  file: SourceFile,
  name: string,
  from: string,
): string | undefined {
  for (const statement of file.ast.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== from)
      continue;
    if (statement.importKind === "type") continue;
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        (specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value) === name
      ) {
        return specifier.local.name;
      }
    }
  }
  return undefined;
}

function declaresAtTopLevel(file: SourceFile, name: string): boolean {
  return file.ast.program.body.some((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!declaration) return false;
    if (
      (declaration.type === "FunctionDeclaration" ||
        declaration.type === "ClassDeclaration") &&
      declaration.id?.name === name
    ) {
      return true;
    }
    return (
      declaration.type === "VariableDeclaration" &&
      declaration.declarations.some(
        (declarator) =>
          declarator.id.type === "Identifier" && declarator.id.name === name,
      )
    );
  });
}

export function callsOf(file: SourceFile, local: string): CallExpression[] {
  const calls: CallExpression[] = [];
  forEachNode(file.ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === local
    ) {
      calls.push(node);
    }
  });
  return calls;
}

/** Exactly one call of `site.callee` through its import binding; never a same-named local. */
export function findCall(file: SourceFile, site: CallSite): Found<CallExpression> {
  const local = importedName(file, site.callee, site.from);
  if (!local) {
    return unsafe(
      declaresAtTopLevel(file, site.callee)
        ? `\`${site.callee}\` here is declared in ${file.path}, not imported from ${site.from}.`
        : `${file.path} does not import ${site.callee} from ${site.from}.`,
    );
  }
  const calls = callsOf(file, local);
  if (calls.length === 0) return unsafe(`${file.path} never calls ${site.callee}().`);
  if (calls.length > 1) {
    return unsafe(`${site.callee}() is called in more than one place in ${file.path}.`);
  }
  return found(calls[0]!);
}

export type ObjectArgument =
  | { readonly kind: "none" }
  | { readonly kind: "object"; readonly node: ObjectExpression };

export function objectArgument(
  file: SourceFile,
  site: CallSite,
  call: CallExpression,
): Found<ObjectArgument> {
  const [first] = call.arguments;
  if (!first) return found({ kind: "none" });
  if (first.type === "ObjectExpression") return found({ kind: "object", node: first });
  return unsafe(
    `${site.callee}() is called with \`${textOf(file, first)}\`, not an object literal.`,
  );
}

function keyName(property: ObjectProperty): string | undefined {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "StringLiteral") return property.key.value;
  return undefined;
}

/** The property `key` of `object`, refusing shapes that could hide it: spreads and computed keys. */
export function propertyOf(
  file: SourceFile,
  object: ObjectExpression,
  key: string,
): Found<ObjectProperty | undefined> {
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      return unsafe(
        `the object passes \`...${textOf(file, property.argument)}\`, which may already set \`${key}\`.`,
      );
    }
    if (property.type === "ObjectProperty" && property.computed) {
      return unsafe(`the object has a computed key, which may already set \`${key}\`.`);
    }
  }
  const match = object.properties.find(
    (property): property is ObjectProperty =>
      property.type === "ObjectProperty" && keyName(property) === key,
  );
  return found(match);
}

export function valueOf(property: ObjectProperty): Expression {
  return property.value as Expression;
}
