import { createServer } from "@parlor/server";

import { registry } from "./actions/index.js";

export default createServer({ actions: registry });
