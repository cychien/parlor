import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORKSPACE_YAML = new URL("../../../pnpm-workspace.yaml", import.meta.url);

/** The `catalog:` block of `pnpm-workspace.yaml`, which has only `name: range` lines. */
export function workspaceCatalog(yaml: string): Readonly<Record<string, string>> {
  const block = /^catalog:\n((?: {2}.+\n)+)/m.exec(yaml)?.[1] ?? "";
  return Object.fromEntries(
    block
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [name = "", range = ""] = line.trim().split(/:\s+/);
        return [name.replaceAll('"', ""), range];
      }),
  );
}

export function renderCatalogModule(catalog: Readonly<Record<string, string>>): string {
  const key = (name: string) =>
    /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  const entries = Object.entries(catalog).map(
    ([name, range]) => `  ${key(name)}: ${JSON.stringify(range)},`,
  );
  return `/** Generated from the \`catalog\` in the repo's \`pnpm-workspace.yaml\` by \`scripts/write-catalog.ts\`; \`catalog.spec.ts\` fails when they differ. */
export const CATALOG: Readonly<Record<string, string>> = {
${entries.join("\n")}
};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(
    new URL("../src/catalog.ts", import.meta.url),
    renderCatalogModule(workspaceCatalog(readFileSync(WORKSPACE_YAML, "utf8"))),
  );
}
