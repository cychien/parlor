import { createActionClient } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createParlorRouter } from "@parlor/client/router";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen.js";

const client = createActionClient();
const router = createParlorRouter({ routeTree, client });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrameworkProvider client={client} router={router}>
      <RouterProvider router={router} />
    </FrameworkProvider>
  </StrictMode>,
);
