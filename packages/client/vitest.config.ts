import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    environment: "happy-dom",
  },
});
