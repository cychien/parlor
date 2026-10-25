import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "packages/scaffold/templates/default",
      "packages/scaffold/fixtures/with-auth",
      "examples/*",
      "website",
    ],
  },
});
