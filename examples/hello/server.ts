import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

import { registry } from "./actions/index.js";

const database = await createDatabase({
  dataDir: ".parlor/pglite",
  migrationsFolder: "migrations",
});

export default createServer({ actions: registry, database });
