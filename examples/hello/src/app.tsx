import type { ActionClient, RegisteredActions } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { createParlorRouter } from "@parlor/client/router";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import { auth } from "./auth.js";
import { routeTree } from "./routeTree.gen.js";

/** The browser builds the app once; the server builds one for every page it renders. */
export default function createApp(client: ActionClient<RegisteredActions>) {
  const router = createParlorRouter({ routeTree, client });
  return {
    router,
    element: (
      <StrictMode>
        <FrameworkProvider client={client} router={router} auth={auth}>
          <RouterProvider router={router} />
        </FrameworkProvider>
      </StrictMode>
    ),
  };
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createApp>["router"];
  }
}
