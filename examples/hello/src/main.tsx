import { createActionClient } from "@parlor/client";
import { mount } from "@parlor/client/router";

import createApp from "./app.js";
import { auth } from "./auth.js";

mount(
  document.getElementById("root")!,
  createApp(createActionClient({ headers: auth.headers })),
);
