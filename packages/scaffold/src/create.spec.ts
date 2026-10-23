import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProject,
  identityOps,
  renderProject,
  rewritePackageJson,
} from "./create.js";
import { editSource } from "./edit/ops.js";
import { parseSource } from "./edit/source.js";
import { templateFiles } from "./files.js";
import type { AppIdentity } from "./identity.js";

const identity: AppIdentity = {
  directoryName: "my-app",
  packageName: "my-app",
  appName: "My App",
  appId: "com.example.myapp",
};

describe("rewritePackageJson (D1)", () => {
  const template = JSON.stringify(
    {
      name: "parlor-template-default",
      version: "0.1.0",
      private: true,
      dependencies: {
        "@parlor/core": "workspace:*",
        react: "catalog:",
        "drizzle-orm": "^0.45.4",
      },
      devDependencies: { "@parlor/cli": "workspace:*", typescript: "catalog:" },
    },
    null,
    2,
  );

  it("names the project and pins the framework exactly and the catalog by its range", () => {
    const text = rewritePackageJson(
      template,
      identity,
      { name: "pnpm", version: "11.21.0" },
      "0.3.0",
    );
    expect(JSON.parse(text)).toEqual({
      name: "my-app",
      version: "0.1.0",
      private: true,
      packageManager: "pnpm@11.21.0",
      dependencies: {
        "@parlor/core": "0.3.0",
        react: "^19.3.0",
        "drizzle-orm": "^0.45.4",
      },
      devDependencies: { "@parlor/cli": "0.3.0", typescript: "^7.0.2" },
    });
    expect(text).not.toContain("workspace:");
    expect(text).not.toContain("catalog:");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("omits packageManager for npm", () => {
    const text = rewritePackageJson(
      template,
      identity,
      { name: "npm", version: "11.6.0" },
      "0.3.0",
    );
    expect(JSON.parse(text)).not.toHaveProperty("packageManager");
  });

  it("throws on a specifier a project could not install", () => {
    const left = template.replace('"drizzle-orm": "^0.45.4"', '"left": "catalog:"');
    expect(() =>
      rewritePackageJson(left, identity, { name: "npm", version: undefined }, "0.3.0"),
    ).toThrow(/left/);
  });
});

describe("identityOps", () => {
  it("renames the template's config through the edit engine", () => {
    const config = `import { defineConfig } from "@parlor/config";\nimport tailwindcss from "@tailwindcss/vite";\n\nexport default defineConfig({\n  app: {\n    id: "com.example.parlorapp",\n    name: "Parlor App",\n  },\n  vite: {\n    plugins: [tailwindcss()],\n  },\n});\n`;
    expect(
      editSource(parseSource("parlor.config.ts", config), identityOps(identity)),
    ).toEqual({
      status: "edit",
      text: config
        .replace('"com.example.parlorapp"', '"com.example.myapp"')
        .replace('"Parlor App"', '"My App"'),
    });
  });
});

const EXPECTED_FILES = [
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "actions/index.ts",
  "actions/todos.spec.ts",
  "index.html",
  "migrations/0000_init.sql",
  "migrations/meta/0000_snapshot.json",
  "migrations/meta/_journal.json",
  "package.json",
  "parlor.config.ts",
  "schema/index.ts",
  "schema/todos.ts",
  "server.ts",
  "src/agent/agent-button.tsx",
  "src/agent/agent.css",
  "src/agent/agent-sidebar.tsx",
  "src/agent/confirmation-card.tsx",
  "src/agent/sidebar-view.ts",
  "src/agent/views.ts",
  "src/app.css",
  "src/header-actions.tsx",
  "src/main.tsx",
  "src/parlor.d.ts",
  "src/routeTree.gen.ts",
  "src/routes/__root.tsx",
  "src/routes/index.tsx",
  "tsconfig.json",
  "vitest.config.ts",
];

describe("renderProject (D1)", () => {
  it("renders the default template as a standalone project", async () => {
    const files = await renderProject(
      identity,
      { name: "pnpm", version: "11.21.0" },
      templateFiles(),
      "0.3.0",
    );
    expect([...files.keys()]).toEqual(
      [...EXPECTED_FILES, "pnpm-workspace.yaml"].sort((a, b) => a.localeCompare(b)),
    );
    for (const [path, text] of files) {
      expect(text, path).not.toMatch(/workspace:|catalog:|\.\.\/\.\.\//);
    }
    expect(files.get("parlor.config.ts")).toContain('id: "com.example.myapp"');
    expect(files.get("parlor.config.ts")).toContain('name: "My App"');
    expect(files.get("pnpm-workspace.yaml")).toBe("allowBuilds:\n  esbuild: true\n");
    const manifest = JSON.parse(files.get("package.json")!) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.name).toBe("my-app");
    const framework = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([name]) => name.startsWith("@parlor/"))
      .map(([, range]) => range);
    expect(new Set(framework)).toEqual(new Set(["0.3.0"]));
    expect(files.get("AGENTS.md")).toContain("This is a Parlor 0.3.0 app.");
    expect(files.get("README.md")).toContain("pnpm parlor add auth");
  });

  it("speaks npm in the docs and writes no package manager files for it", async () => {
    const files = await renderProject(
      identity,
      { name: "npm", version: undefined },
      templateFiles(),
    );
    expect(files.has("pnpm-workspace.yaml")).toBe(false);
    expect(files.get("README.md")).toContain("npm run dev");
    expect(files.get("AGENTS.md")).toContain("npx parlor add <auth|agent>");
  });
});

describe("createProject", () => {
  const options = (directory: string) =>
    ({
      directory,
      packageManager: { name: "pnpm", version: "11.21.0" },
      mode: "apply",
      install: false,
      git: false,
      addons: [],
      log: () => {},
    }) as const;

  it("lists the files of a dry run and writes nothing", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "parlor-create-")), "my-app");
    const project = await createProject({
      ...options(directory),
      mode: "dry-run",
      addons: ["auth"],
    });
    expect(project.files).toContain("package.json");
    expect(project.addons).toEqual({ applied: [], deferred: ["auth"] });
    await expect(readdir(directory)).rejects.toThrow(/ENOENT/);
  });

  it("writes the project into a folder that holds only safe entries", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "parlor-create-")), "my-app");
    await mkdir(join(directory, ".git"), { recursive: true });
    const project = await createProject(options(directory));
    expect(project.install).toEqual({ kind: "skipped" });
    expect(project.git).toEqual({ kind: "disabled" });
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toContain(".parlor");
    expect((await readdir(directory)).sort()).toEqual(
      expect.arrayContaining(["AGENTS.md", "README.md", "src", ".git"]),
    );
  });

  it("refuses a folder with other files in it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "parlor-create-"));
    await writeFile(join(directory, "notes.txt"), "mine");
    await expect(createProject(options(directory))).rejects.toThrow(/notes\.txt/);
  });
});
