import { chat } from "@parlor/chat/server";
import { createDatabase } from "@parlor/data";
import { createServer } from "@parlor/server";

import { registry } from "./actions/index.js";
import { createAuth } from "./auth.js";

const database = await createDatabase({ migrationsFolder: "migrations" });

export default createServer({
  actions: registry,
  database,
  plugins: [chat()],
  auth: createAuth(database),
});
