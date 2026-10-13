import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";
import { serve } from "srvx";

import { registry } from "./actions/index.js";

const database = await createDatabase({
  dataDir: ".parlor/pglite",
  migrationsFolder: "migrations",
});
const server = createServer({ actions: registry, database });
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: server.fetch, port });
console.log(
  `hello-example server (${database.driver}) listening on http://localhost:${port}`,
);
