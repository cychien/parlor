import { defineProject } from "vitest/config";

export default defineProject({
  test: { include: ["actions/**/*.spec.ts", "src/**/*.spec.ts"], testTimeout: 30_000 },
});
