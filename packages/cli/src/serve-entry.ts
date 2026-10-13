import { pathToFileURL } from "node:url";

import { serve } from "srvx";

const entry = process.argv[2];
if (!entry) throw new Error("serve-entry needs the server entry path");

const loaded = (await import(pathToFileURL(entry).href)) as {
  default?: { fetch?: (request: Request) => Promise<Response> | Response };
};
const handler = loaded.default?.fetch;

if (handler) {
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: (request) => handler(request), port });
  console.log(`parlor server listening on http://localhost:${port}`);
}
