import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "packages/scaffold/templates/default",
      "packages/scaffold/fixtures/with-auth",
      "examples/*",
      "website",
      {
        extends: "./packages/chat/vitest.config.ts",
        test: {
          name: "@parlor/chat as the only server",
          root: "./packages/chat",
          env: { PARLOR_TEST_INSTANCES: "one" },
        },
      },
    ],
  },
});
