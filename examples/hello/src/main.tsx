import { createActionClient } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { auth } from "./auth.js";
import { routeTree } from "./routeTree.gen.js";

const client = createActionClient({ headers: auth.headers });
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrameworkProvider client={client} router={router} auth={auth}>
      <RouterProvider router={router} />
    </FrameworkProvider>
  </StrictMode>,
);
