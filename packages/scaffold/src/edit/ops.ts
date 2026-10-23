import type {
  ArrayExpression,
  Expression,
  JSXElement,
  JSXFragment,
  JSXOpeningElement,
  Node,
  ObjectExpression,
  ObjectProperty,
} from "@babel/types";

import { applySplices, parseSource, type SourceFile, type Splice } from "./source.js";
import {
  type CallSite,
  findCall,
  forEachNode,
  importedName,
  objectArgument,
  propertyOf,
  textOf,
  valueOf,
} from "./syntax.js";

export type { CallSite } from "./syntax.js";

/**
 * The closed set of code edits. Each one knows how to tell that it is already done, how to
 * make it, and when it is unsafe. Add a kind here, with its tests, instead of editing text
 * anywhere else.
 */
export type Op =
  /** Joins an existing value import from `from`, else a new line where oxfmt's sorted imports put it. */
  | { readonly kind: "import"; readonly names: readonly string[]; readonly from: string }
  | { readonly kind: "export-all"; readonly from: string }
  /** Present when an element starts with the same identifier: `chat()` is present when `chat(...)` is. */
  | {
      readonly kind: "append-element";
      readonly call: CallSite;
      readonly path: readonly [string, ...string[]];
      readonly element: string;
    }
  /**
   * `$name` in `value` is replaced with the source text of the sibling property `name`, so
   * `createAuth($database)` follows whatever the app passes.
   */
  | {
      readonly kind: "set-property";
      readonly call: CallSite;
      readonly path: readonly [string, ...string[]];
      readonly value: string;
      /** `unsafe` for add-ons, which never overwrite; `replace` for create's own template. */
      readonly onConflict: "unsafe" | "replace";
    }
  | {
      readonly kind: "wrap-property";
      readonly call: CallSite;
      readonly path: readonly [string, ...string[]];
      readonly wrapper: string;
    }
  | {
      readonly kind: "jsx-attribute";
      readonly element: string;
      readonly name: string;
      readonly value: string;
    }
  /** The component must return exactly one JSX element or fragment. */
  | { readonly kind: "jsx-child"; readonly component: string; readonly element: string };

export type OpOutcome =
  | { readonly status: "done" }
  | { readonly status: "edit"; readonly splices: readonly Splice[] }
  | { readonly status: "unsafe"; readonly reason: string };

type CallOp = Extract<Op, { call: CallSite }>;
type Layout = {
  readonly multiline: boolean;
  readonly indent: string;
  readonly comma: boolean;
};

const DONE: OpOutcome = { status: "done" };
const INLINE: Layout = { multiline: false, indent: "", comma: false };
const unsafe = (reason: string): OpOutcome => ({ status: "unsafe", reason });
const edit = (...splices: Splice[]): OpOutcome => ({ status: "edit", splices });
const squash = (text: string) => text.replace(/\s+/g, "");
const INDENT = "  ";

function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? "";
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

function entry(path: readonly string[], value: string, layout: Layout): string {
  const [key, ...rest] = path;
  if (rest.length === 0) return `${key}: ${value}`;
  if (!layout.multiline) return `${key}: { ${entry(rest, value, layout)} }`;
  const inner = `${layout.indent}${INDENT}`;
  const child = entry(rest, value, { ...layout, indent: inner });
  return `${key}: {\n${inner}${child}${layout.comma ? "," : ""}\n${layout.indent}}`;
}

/** Appends to an object's properties or an array's elements in their own indentation and comma style. */
function appendEntry(
  file: SourceFile,
  container: ObjectExpression | ArrayExpression,
  render: (layout: Layout) => string,
): Splice {
  const items = (
    container.type === "ObjectExpression" ? container.properties : container.elements
  ).filter((item): item is NonNullable<typeof item> => item !== null);
  const last = items.at(-1);
  const close = (container.end ?? 0) - 1;
  if (!last) {
    const text = render(INLINE);
    return {
      start: (container.start ?? 0) + 1,
      end: close,
      text: container.type === "ObjectExpression" ? ` ${text} ` : text,
    };
  }
  const after = last.end ?? 0;
  const between = file.text.slice(after, close);
  if (!between.includes("\n"))
    return { start: after, end: after, text: `, ${render(INLINE)}` };
  const indent = lineIndent(file.text, last.start ?? 0);
  const comma = between.indexOf(",");
  const text = render({ multiline: true, indent, comma: comma !== -1 });
  return comma === -1
    ? { start: after, end: after, text: `,\n${indent}${text}` }
    : { start: after + comma + 1, end: after + comma + 1, text: `\n${indent}${text},` };
}

function substitute(
  file: SourceFile,
  object: ObjectExpression,
  value: string,
): { readonly value: string } | { readonly missing: string } {
  let missing: string | undefined;
  const result = value.replace(/\$([A-Za-z_]\w*)/g, (_match, name: string) => {
    const sibling = propertyOf(file, object, name);
    if (!sibling.ok || !sibling.value) {
      missing = name;
      return name;
    }
    return textOf(file, valueOf(sibling.value));
  });
  return missing === undefined ? { value: result } : { missing };
}

type Target =
  | { readonly kind: "no-argument"; readonly close: number }
  | {
      readonly kind: "missing";
      readonly object: ObjectExpression;
      readonly rest: readonly string[];
    }
  | {
      readonly kind: "found";
      readonly object: ObjectExpression;
      readonly property: ObjectProperty;
    };

/** The property at `op.path`, or where it would go; a parent that is not an object literal is unsafe. */
function locate(file: SourceFile, op: CallOp): Target | { readonly reason: string } {
  const call = findCall(file, op.call);
  if (!call.ok) return { reason: call.reason };
  const argument = objectArgument(file, op.call, call.value);
  if (!argument.ok) return { reason: argument.reason };
  if (argument.value.kind === "none") {
    return { kind: "no-argument", close: (call.value.end ?? 0) - 1 };
  }
  let object = argument.value.node;
  for (const [depth, key] of op.path.entries()) {
    const property = propertyOf(file, object, key);
    if (!property.ok) return { reason: property.reason };
    if (!property.value) return { kind: "missing", object, rest: op.path.slice(depth) };
    if (depth === op.path.length - 1)
      return { kind: "found", object, property: property.value };
    const value = valueOf(property.value);
    if (value.type !== "ObjectExpression") {
      return {
        reason: `\`${key}\` is \`${textOf(file, value)}\`, not an object literal.`,
      };
    }
    object = value;
  }
  return { reason: "the path is empty." };
}

function leadingName(text: string): string | undefined {
  return /^[A-Za-z_$][\w$]*/.exec(text.trim())?.[0];
}

function expressionName(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "CallExpression") return expressionName(node.callee);
  return undefined;
}

function evaluateSetProperty(
  file: SourceFile,
  op: Extract<Op, { kind: "set-property" }>,
): OpOutcome {
  const target = locate(file, op);
  if ("reason" in target) return unsafe(target.reason);
  if (target.kind === "no-argument") {
    if (/\$\w/.test(op.value))
      return unsafe(`${op.call.callee}() has no options to read.`);
    const text = entry(op.path, op.value, INLINE);
    return edit({ start: target.close, end: target.close, text: `{ ${text} }` });
  }
  const value = substitute(file, target.object, op.value);
  if ("missing" in value) {
    return unsafe(`${op.call.callee}() has no \`${value.missing}\` to pass.`);
  }
  if (target.kind === "missing") {
    return edit(
      appendEntry(file, target.object, (layout) =>
        entry(target.rest, value.value, layout),
      ),
    );
  }
  const current = valueOf(target.property);
  if (squash(textOf(file, current)) === squash(value.value)) return DONE;
  if (op.onConflict === "unsafe") {
    return unsafe(`\`${op.path.at(-1)}\` is already \`${textOf(file, current)}\`.`);
  }
  return edit({ start: current.start ?? 0, end: current.end ?? 0, text: value.value });
}

function evaluateAppendElement(
  file: SourceFile,
  op: Extract<Op, { kind: "append-element" }>,
): OpOutcome {
  const target = locate(file, op);
  if ("reason" in target) return unsafe(target.reason);
  const array = `[${op.element}]`;
  if (target.kind === "no-argument") {
    const text = entry(op.path, array, INLINE);
    return edit({ start: target.close, end: target.close, text: `{ ${text} }` });
  }
  if (target.kind === "missing") {
    return edit(
      appendEntry(file, target.object, (layout) => entry(target.rest, array, layout)),
    );
  }
  const key = op.path.at(-1);
  const current = valueOf(target.property);
  if (current.type !== "ArrayExpression") {
    return unsafe(`\`${key}\` is \`${textOf(file, current)}\`, not an array literal.`);
  }
  const spread = current.elements.find((element) => element?.type === "SpreadElement");
  if (spread) {
    return unsafe(
      `\`${key}\` spreads \`${textOf(file, spread)}\`, which may already hold ${op.element}.`,
    );
  }
  const wanted = leadingName(op.element);
  if (current.elements.some((element) => element && expressionName(element) === wanted)) {
    return DONE;
  }
  return edit(appendEntry(file, current, () => op.element));
}

function evaluateWrapProperty(
  file: SourceFile,
  op: Extract<Op, { kind: "wrap-property" }>,
): OpOutcome {
  const target = locate(file, op);
  if ("reason" in target) return unsafe(target.reason);
  if (target.kind !== "found")
    return unsafe(`${op.call.callee}() sets no \`${op.path.at(-1)}\`.`);
  const current = valueOf(target.property);
  if (
    current.type === "CallExpression" &&
    current.callee.type === "Identifier" &&
    current.callee.name === op.wrapper
  ) {
    return DONE;
  }
  return edit({
    start: current.start ?? 0,
    end: current.end ?? 0,
    text: `${op.wrapper}(${textOf(file, current)})`,
  });
}

/** Where `name` is bound at module scope: the module it is imported from, or this file. */
function topLevelBinding(file: SourceFile, name: string): string | undefined {
  for (const statement of file.ast.program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.specifiers.some((specifier) => specifier.local.name === name)) {
        return statement.source.value;
      }
      continue;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" ||
        declaration.type === "ClassDeclaration") &&
      declaration.id?.name === name
    ) {
      return file.path;
    }
    if (
      declaration.type === "VariableDeclaration" &&
      declaration.declarations.some(
        (declarator) =>
          declarator.id.type === "Identifier" && declarator.id.name === name,
      )
    ) {
      return file.path;
    }
  }
  return undefined;
}

const isRelative = (source: string) => source.startsWith(".");

function importLine(op: Extract<Op, { kind: "import" }>): string {
  return `import { ${op.names.join(", ")} } from "${op.from}";`;
}

function evaluateImport(
  file: SourceFile,
  op: Extract<Op, { kind: "import" }>,
): OpOutcome {
  const missing = op.names.filter((name) => importedName(file, name, op.from) !== name);
  if (missing.length === 0) return DONE;
  for (const name of missing) {
    const bound = topLevelBinding(file, name);
    if (bound !== undefined) {
      return unsafe(
        bound === file.path
          ? `\`${name}\` is already declared in ${file.path}.`
          : `\`${name}\` is already imported from ${bound}.`,
      );
    }
  }
  const imports = file.ast.program.body.filter(
    (statement) => statement.type === "ImportDeclaration",
  );
  const existing = imports.find(
    (statement) =>
      statement.source.value === op.from &&
      statement.importKind !== "type" &&
      statement.specifiers.length > 0 &&
      statement.specifiers.every((specifier) => specifier.type === "ImportSpecifier"),
  );
  if (existing) {
    const at = existing.specifiers.at(-1)?.end ?? 0;
    return edit({ start: at, end: at, text: `, ${missing.join(", ")}` });
  }
  const line = importLine({ ...op, names: missing });
  const group = imports.filter(
    (statement) => isRelative(statement.source.value) === isRelative(op.from),
  );
  const before = group.find((statement) => statement.source.value > op.from);
  if (before) {
    const start = lineStart(file.text, before.start ?? 0);
    return edit({ start, end: start, text: `${line}\n` });
  }
  const lastOfGroup = group.at(-1);
  if (lastOfGroup) {
    const at = lineEnd(file.text, lastOfGroup.end ?? 0);
    return edit({ start: at, end: at, text: `\n${line}` });
  }
  const lastImport = imports.at(-1);
  if (isRelative(op.from) && lastImport) {
    const at = lineEnd(file.text, lastImport.end ?? 0);
    return edit({ start: at, end: at, text: `\n\n${line}` });
  }
  const start = imports[0] ? lineStart(file.text, imports[0].start ?? 0) : 0;
  return edit({ start, end: start, text: `${line}\n\n` });
}

function evaluateExportAll(
  file: SourceFile,
  op: Extract<Op, { kind: "export-all" }>,
): OpOutcome {
  const present = file.ast.program.body.some(
    (statement) =>
      statement.type === "ExportAllDeclaration" && statement.source.value === op.from,
  );
  if (present) return DONE;
  const at = file.text.length;
  const newline = at === 0 || file.text.endsWith("\n") ? "" : "\n";
  return edit({ start: at, end: at, text: `${newline}export * from "${op.from}";\n` });
}

function openingElements(root: Node, name: string): JSXOpeningElement[] {
  const found: JSXOpeningElement[] = [];
  forEachNode(root, (node) => {
    if (
      node.type === "JSXOpeningElement" &&
      node.name.type === "JSXIdentifier" &&
      node.name.name === name
    ) {
      found.push(node);
    }
  });
  return found;
}

function evaluateJsxAttribute(
  file: SourceFile,
  op: Extract<Op, { kind: "jsx-attribute" }>,
): OpOutcome {
  const elements = openingElements(file.ast, op.element);
  if (elements.length === 0) return unsafe(`${file.path} renders no <${op.element}>.`);
  if (elements.length > 1) {
    return unsafe(`<${op.element}> appears more than once in ${file.path}.`);
  }
  const element = elements[0]!;
  const existing = element.attributes.find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === op.name,
  );
  if (existing) {
    return squash(textOf(file, existing)) === squash(`${op.name}=${op.value}`)
      ? DONE
      : unsafe(`<${op.element}> already sets \`${textOf(file, existing)}\`.`);
  }
  const after = element.attributes.at(-1)?.end ?? element.name.end ?? 0;
  return edit({ start: after, end: after, text: ` ${op.name}=${op.value}` });
}

function componentBody(file: SourceFile, name: string): Node | undefined {
  for (const statement of file.ast.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === name) {
      return declaration.body;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (
        declarator.id.type === "Identifier" &&
        declarator.id.name === name &&
        (declarator.init?.type === "ArrowFunctionExpression" ||
          declarator.init?.type === "FunctionExpression")
      ) {
        return declarator.init.body;
      }
    }
  }
  return undefined;
}

/** The values the component itself returns, not those of functions nested in it. */
function returnedValues(body: Node): readonly (Expression | null | undefined)[] {
  if (body.type !== "BlockStatement") return [body as Expression];
  const returned: (Expression | null | undefined)[] = [];
  const visit = (node: Node) => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return;
    }
    if (node.type === "ReturnStatement") returned.push(node.argument);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (
          child &&
          typeof child === "object" &&
          typeof (child as Node).type === "string"
        ) {
          visit(child as Node);
        }
      }
    }
  };
  for (const statement of body.body) visit(statement);
  return returned;
}

function evaluateJsxChild(
  file: SourceFile,
  op: Extract<Op, { kind: "jsx-child" }>,
): OpOutcome {
  const body = componentBody(file, op.component);
  if (!body) return unsafe(`${file.path} has no component ${op.component}.`);
  const returned = returnedValues(body);
  const root = returned[0];
  if (
    returned.length !== 1 ||
    !root ||
    (root.type !== "JSXElement" && root.type !== "JSXFragment")
  ) {
    return unsafe(
      `${op.component} must return exactly one JSX element to add <${op.element} />.`,
    );
  }
  if (openingElements(root, op.element).length > 0) return DONE;
  const parent: JSXElement | JSXFragment = root;
  const closing =
    parent.type === "JSXElement" ? parent.closingElement : parent.closingFragment;
  if (!closing) return unsafe(`${op.component} returns a self-closing element.`);
  const last = parent.children
    .filter((child) => child.type !== "JSXText" || child.value.trim() !== "")
    .at(-1);
  const tag = `<${op.element} />`;
  if (!last) {
    const at = closing.start ?? 0;
    return edit({ start: at, end: at, text: tag });
  }
  const at = last.end ?? 0;
  return edit({
    start: at,
    end: at,
    text: `\n${lineIndent(file.text, last.start ?? 0)}${tag}`,
  });
}

export function evaluateOp(file: SourceFile, op: Op): OpOutcome {
  switch (op.kind) {
    case "import":
      return evaluateImport(file, op);
    case "export-all":
      return evaluateExportAll(file, op);
    case "append-element":
      return evaluateAppendElement(file, op);
    case "set-property":
      return evaluateSetProperty(file, op);
    case "wrap-property":
      return evaluateWrapProperty(file, op);
    case "jsx-attribute":
      return evaluateJsxAttribute(file, op);
    case "jsx-child":
      return evaluateJsxChild(file, op);
  }
}

/** One short line for the printed plan, such as "auth: createAuth(database)"; none for an import. */
export function opSummary(file: SourceFile, op: Op): string | undefined {
  switch (op.kind) {
    case "import":
      return undefined;
    case "export-all":
      return `export * from "${op.from}"`;
    case "append-element":
      return `${op.path.join(".")}: ${op.element}`;
    case "set-property": {
      const target = locate(file, op);
      const value =
        "reason" in target || target.kind === "no-argument"
          ? op.value
          : (() => {
              const substituted = substitute(file, target.object, op.value);
              return "value" in substituted ? substituted.value : op.value;
            })();
      return `${op.path.join(".")}: ${value}`;
    }
    case "wrap-property": {
      const target = locate(file, op);
      const current =
        !("reason" in target) && target.kind === "found"
          ? textOf(file, valueOf(target.property))
          : "...";
      return `${op.path.join(".")}: ${op.wrapper}(${current})`;
    }
    case "jsx-attribute":
      return `<${op.element} ${op.name}=${op.value}>`;
    case "jsx-child":
      return `<${op.element} />`;
  }
}

function callCode(op: CallOp, value: string): string {
  const nested = (path: readonly string[], indent: string): string => {
    const [key, ...rest] = path;
    if (rest.length === 0) return `${indent}${key}: ${value},`;
    return `${indent}${key}: {\n${nested(rest, `${indent}${INDENT}`)}\n${indent}},`;
  };
  return `${op.call.callee}({\n${INDENT}...\n${nested(op.path, INDENT)}\n});`;
}

/** The code to write by hand for `op`; a `$name` stands for the sibling the app passes. */
export function manualCode(op: Op): string {
  switch (op.kind) {
    case "import":
      return importLine(op);
    case "export-all":
      return `export * from "${op.from}";`;
    case "append-element":
      return callCode(op, `[..., ${op.element}]`);
    case "set-property":
      return callCode(op, op.value.replace(/\$([A-Za-z_]\w*)/g, "$1"));
    case "wrap-property":
      return callCode(op, `${op.wrapper}(...)`);
    case "jsx-attribute":
      return `<${op.element} ... ${op.name}=${op.value}>`;
    case "jsx-child":
      return [
        `function ${op.component}() {`,
        `${INDENT}return (`,
        `${INDENT}${INDENT}<...>`,
        `${INDENT}${INDENT}${INDENT}...`,
        `${INDENT}${INDENT}${INDENT}<${op.element} />`,
        `${INDENT}${INDENT}</...>`,
        `${INDENT});`,
        "}",
      ].join("\n");
  }
}

function manualHeading(file: string, op: Op): string {
  switch (op.kind) {
    case "import":
      return `In ${file}, import ${op.names.join(", ")} from ${op.from}:`;
    case "export-all":
      return `In ${file}, re-export ${op.from}:`;
    case "append-element":
      return `In ${file}, add ${op.element} to \`${op.path.join(".")}\` of ${op.call.callee}:`;
    case "set-property":
      return `In ${file}, pass \`${op.path.join(".")}\` to ${op.call.callee}:`;
    case "wrap-property":
      return `In ${file}, wrap \`${op.path.join(".")}\` of ${op.call.callee} in ${op.wrapper}:`;
    case "jsx-attribute":
      return `In ${file}, add \`${op.name}=${op.value}\` to <${op.element}>:`;
    case "jsx-child":
      return `In ${file}, render <${op.element} /> in ${op.component}:`;
  }
}

export function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `${indent}${line}` : line))
    .join("\n");
}

/** The change to make by hand when `op` is unsafe. */
export function manualChange(file: string, op: Op): string {
  return `${manualHeading(file, op)}\n\n${indentLines(manualCode(op), INDENT)}`;
}

export type EditOutcome =
  | { readonly status: "done" }
  | { readonly status: "edit"; readonly text: string }
  | { readonly status: "unsafe"; readonly unsafe: readonly UnsafeOp[] };

export interface UnsafeOp {
  readonly op: Op;
  readonly reason: string;
}

export const UNCONFIRMED = "could not confirm the edit";

/**
 * Applies `ops` in order, reparsing after each one, then proves the result: it must still
 * parse and every op must now evaluate to `done`. A failed proof is `unsafe`, so a bug in an op
 * can cost a manual step but never a broken or half-edited file, and a second run is a no-op
 * by construction. Collects every unsafe op instead of stopping at the first.
 */
export function editSource(file: SourceFile, ops: readonly Op[]): EditOutcome {
  let current = file;
  const failed: UnsafeOp[] = [];
  for (const op of ops) {
    const outcome = evaluateOp(current, op);
    if (outcome.status === "unsafe") failed.push({ op, reason: outcome.reason });
    if (outcome.status === "edit") {
      try {
        current = parseSource(file.path, applySplices(current.text, outcome.splices));
      } catch {
        failed.push({ op, reason: UNCONFIRMED });
      }
    }
  }
  if (failed.length > 0) return { status: "unsafe", unsafe: failed };
  if (current.text === file.text) return { status: "done" };
  const unconfirmed = ops.filter((op) => evaluateOp(current, op).status !== "done");
  if (unconfirmed.length > 0) {
    return {
      status: "unsafe",
      unsafe: unconfirmed.map((op) => ({ op, reason: UNCONFIRMED })),
    };
  }
  return { status: "edit", text: current.text };
}
