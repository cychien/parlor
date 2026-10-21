const OPENING = "([{";
const CLOSING = ")]}";

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

export const compact = (text: string) =>
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

function signaturesOf(text: string): Map<string, string> {
  const signatures = new Map<string, string>();
  const add = (name: string, signature: string) =>
    signatures.set(
      name,
      [signatures.get(name), compact(signature)].filter(Boolean).join("\n"),
    );
  for (const statement of statementsOf(text)) {
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

export interface Difference {
  readonly file: string;
  readonly symbol: string;
  readonly kind: "changed" | "missing" | "added";
}

export function differences(
  file: string,
  skeleton: string,
  actual: string,
  only?: readonly string[],
): Difference[] {
  const wanted = signaturesOf(skeleton);
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
