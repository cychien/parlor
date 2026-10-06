import { createServer } from "@fw/server";
import { serve } from "srvx";

import { registry } from "./actions/index.js";

const server = createServer({ actions: registry });
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: server.fetch, port });
console.log(`hello-example server listening on http://localhost:${port}`);
