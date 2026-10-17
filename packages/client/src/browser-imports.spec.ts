import { fileURLToPath } from "node:url";

import { build, type Plugin } from "vite";
import { describe, expect, it } from "vitest";

const entries = ["./index.ts", "./react/index.ts"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

async function runtimeImports(): Promise<Map<string, string[]>> {
  const imports = new Map<string, string[]>();
  const recorder: Plugin = {
    name: "record-runtime-imports",
    enforce: "pre",
    resolveId(source, importer) {
      if (/^[./]|^@parlor\/|^\0/.test(source)) return null;
      const name = source.startsWith("@")
        ? source.split("/").slice(0, 2).join("/")
        : source.split("/")[0]!;
      imports.set(name, [...(imports.get(name) ?? []), importer ?? ""]);
      return { id: source, external: true };
    },
  };
  await build({
    configFile: false,
    logLevel: "silent",
    plugins: [recorder],
    build: {
      write: false,
      lib: { entry: entries, formats: ["es"] },
    },
  });
  return imports;
}

describe("the browser entry points", () => {
  it("import no zod at runtime, through @parlor/agent-ui or otherwise", async () => {
    const imports = await runtimeImports();
    expect(imports.get("react")).toBeDefined();
    expect(imports.get("zod") ?? []).toEqual([]);
  });
});
