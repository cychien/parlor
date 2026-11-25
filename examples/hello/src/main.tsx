import { createActionClient } from "@parlor/client";
import { mount } from "@parlor/client/router";

import createApp from "./app.js";

mount(document.getElementById("root")!, createApp(createActionClient()));
