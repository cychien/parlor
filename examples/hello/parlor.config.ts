import { defineConfig } from "@parlor/config";

export default defineConfig({
  app: {
    id: "dev.parlor.hello",
    name: "Hello",
    description: "Parlor hello example",
    scheme: "hello",
  },
  server: { url: "http://localhost:3000" },
});
