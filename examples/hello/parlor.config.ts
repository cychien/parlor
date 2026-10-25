import { defineConfig } from "@parlor/config";

export default defineConfig({
  app: {
    id: "dev.parlor.hello",
    name: "Hello",
    description: "Parlor hello example",
    scheme: "hello",
  },
  server: { url: "http://localhost:3000" },
  web: { ssr: { app: "src/app.tsx" } },
  desktop: { agentHost: true },
});
