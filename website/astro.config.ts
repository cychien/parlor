import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

import { typecheckedSamples } from "./src/samples.ts";

export default defineConfig({
  site: process.env.PARLOR_DOCS_SITE ?? "https://cychien.github.io",
  base: "/parlor",
  integrations: [
    starlight({
      title: "Parlor",
      description:
        "A TypeScript framework for web apps that agents can operate as fully as people do.",
      sidebar: [
        { label: "Start here", items: ["getting-started"] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
      customCss: ["./src/styles/docs.css"],
      plugins: [starlightLinksValidator()],
      expressiveCode: { plugins: [typecheckedSamples()] },
    }),
  ],
});
