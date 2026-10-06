import { createActionClient } from "@fw/client";
import { FrameworkProvider } from "@fw/client/react";
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
