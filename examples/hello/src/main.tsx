import { createActionClient } from "@parlor/client";
import { FrameworkProvider } from "@parlor/client/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const client = createActionClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FrameworkProvider client={client}>
      <App />
    </FrameworkProvider>
  </StrictMode>,
);
