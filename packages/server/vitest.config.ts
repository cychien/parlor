import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    include: ["src/**/*.spec.ts"],
    typecheck: {
      enabled: true,
      include: ["src/**/*.spec-d.ts"],
      tsconfig: "tsconfig.spec.json",
    },
  },
});
