import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@parlor/data";
import { generateDrizzleSchema } from "auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { describe, expect, it } from "vitest";

import { parlorAuth } from "./better-auth.js";

const SCHEMA_FILE = new URL("./schema.ts", import.meta.url);
const OXFMT = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));

/** The committed file minus its leading comment, which the generator does not write. */
function withoutHeader(text: string): string {
  return text.replace(/^(\/\/.*\n)+/, "");
}

/**
 * `@parlor/auth/schema` ships the tables `auth generate` would write for `parlorAuth()`
 * defaults. This regenerates them with Better Auth's own generator (the one behind the CLI),
 * formats the output as the repo does, and diffs, so a `better-auth` bump that changes a table
 * fails here instead of desynchronizing apps that re-export the schema.
 */
describe("@parlor/auth/schema", () => {
  it("equals what Better Auth's drizzle generator writes for parlorAuth() defaults", async () => {
    const database = await createDatabase({ dataDir: "memory://" });
    try {
      const options = parlorAuth({
        appName: "Schema",
        origin: "http://localhost",
        signInPage: "/sign-in",
        emailAndPassword: { enabled: true },
      });
      const adapter = drizzleAdapter(database.db, { provider: "pg", schema: {} })(
        options,
      );
      const dir = await mkdtemp(join(tmpdir(), "parlor-auth-schema-"));
      const generated = join(dir, "schema.ts");
      const result = await generateDrizzleSchema({ adapter, options, file: generated });
      await writeFile(generated, result.code ?? "");
      execFileSync(OXFMT, ["--write", generated], { stdio: "pipe" });
      const committed = await readFile(SCHEMA_FILE, "utf8");
      expect(withoutHeader(await readFile(generated, "utf8"))).toBe(
        withoutHeader(committed),
      );
    } finally {
      await database.close();
    }
  });
});
