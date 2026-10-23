import type { ObjectExpression, ObjectProperty } from "@babel/types";

import { applySplices, parseSource, type SourceFile, type Splice } from "./source.js";
import {
  type CallSite,
  findCall,
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
  /**
   * Sets the property at `path` of the call's object argument to `value`; a call with no
   * argument gets `{ <path>: value }`. `$name` in `value` is replaced with the source text of
   * the sibling property `name`, so `createAuth($database)` follows whatever the app passes.
   */
  {
    readonly kind: "set-property";
    readonly call: CallSite;
    readonly path: readonly [string, ...string[]];
    readonly value: string;
    /** `unsafe` for add-ons, which never overwrite; `replace` for create's own template. */
    readonly onConflict: "unsafe" | "replace";
  };

export type OpOutcome =
  | { readonly status: "done" }
  | { readonly status: "edit"; readonly splices: readonly Splice[] }
  | { readonly status: "unsafe"; readonly reason: string };

const squash = (text: string) => text.replace(/\s+/g, "");

function nested(path: readonly string[], value: string): string {
  const [key, ...rest] = path;
  return rest.length === 0 ? `${key}: ${value}` : `${key}: { ${nested(rest, value)} }`;
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}

function appendProperty(
  file: SourceFile,
  object: ObjectExpression,
  entry: string,
): Splice {
  const last = object.properties.at(-1);
  const close = (object.end ?? 0) - 1;
  if (!last) return { start: (object.start ?? 0) + 1, end: close, text: ` ${entry} ` };
  const between = file.text.slice(last.end ?? 0, close);
  const multiline = between.includes("\n");
  const indent = lineIndent(file.text, last.start ?? 0);
  if (!multiline) return { start: last.end ?? 0, end: last.end ?? 0, text: `, ${entry}` };
  const comma = between.indexOf(",");
  return comma === -1
    ? { start: last.end ?? 0, end: last.end ?? 0, text: `,\n${indent}${entry}` }
    : {
        start: (last.end ?? 0) + comma + 1,
        end: (last.end ?? 0) + comma + 1,
        text: `\n${indent}${entry},`,
      };
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

function evaluateSetProperty(file: SourceFile, op: Op): OpOutcome {
  const call = findCall(file, op.call);
  if (!call.ok) return { status: "unsafe", reason: call.reason };
  const argument = objectArgument(file, op.call, call.value);
  if (!argument.ok) return { status: "unsafe", reason: argument.reason };
  if (argument.value.kind === "none") {
    if (/\$\w/.test(op.value)) {
      return { status: "unsafe", reason: `${op.call.callee}() has no options to read.` };
    }
    const close = (call.value.end ?? 0) - 1;
    return {
      status: "edit",
      splices: [{ start: close, end: close, text: `{ ${nested(op.path, op.value)} }` }],
    };
  }
  let object = argument.value.node;
  for (const [depth, key] of op.path.entries()) {
    const property = propertyOf(file, object, key);
    if (!property.ok) return { status: "unsafe", reason: property.reason };
    if (!property.value || depth === op.path.length - 1) {
      return setLeaf(file, op, object, op.path.slice(depth), property.value);
    }
    const current = valueOf(property.value);
    if (current.type !== "ObjectExpression") {
      return {
        status: "unsafe",
        reason: `\`${key}\` is \`${textOf(file, current)}\`, not an object literal.`,
      };
    }
    object = current;
  }
  return { status: "done" };
}

function setLeaf(
  file: SourceFile,
  op: Op,
  object: ObjectExpression,
  rest: readonly string[],
  existing: ObjectProperty | undefined,
): OpOutcome {
  const value = substitute(file, object, op.value);
  if ("missing" in value) {
    return {
      status: "unsafe",
      reason: `${op.call.callee}() has no \`${value.missing}\` to pass.`,
    };
  }
  if (!existing) {
    return {
      status: "edit",
      splices: [appendProperty(file, object, nested(rest, value.value))],
    };
  }
  const current = valueOf(existing);
  if (squash(textOf(file, current)) === squash(value.value)) return { status: "done" };
  if (op.onConflict === "unsafe") {
    return {
      status: "unsafe",
      reason: `\`${rest[0]}\` is already \`${textOf(file, current)}\`.`,
    };
  }
  return {
    status: "edit",
    splices: [{ start: current.start ?? 0, end: current.end ?? 0, text: value.value }],
  };
}

export function evaluateOp(file: SourceFile, op: Op): OpOutcome {
  switch (op.kind) {
    case "set-property":
      return evaluateSetProperty(file, op);
  }
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
