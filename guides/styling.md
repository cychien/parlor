# Styling

New apps use Tailwind CSS v4. `src/app.css` imports it, and `parlor.config.ts` adds its Vite plugin:

```ts
import { defineConfig } from "@parlor/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  app: { id: "com.example.myapp", name: "My App" },
  vite: { plugins: [tailwindcss()] },
});
```

## The vite field

There is no `vite.config.ts` in a Parlor app: the CLI owns the Vite config for the web, desktop and mobile builds. The `vite` field of `parlor.config.ts` is merged into it, so any Vite plugin or option works the same on every target.

- Your plugins run after Parlor's.
- Objects merge, and Parlor's own values win: `root`, `base`, `configFile`, `build.outDir`, `build.emptyOutDir`, `server.port` and `server.strictPort` are ignored with a warning. Set the port with `web.port` instead.
- A `vite.config.ts` in the project is never read; `parlor dev` warns when it finds one.

## Without Tailwind

Remove `@tailwindcss/vite` from the `vite` field and `@import "tailwindcss"` from `src/app.css`, then use any CSS you like: plain CSS files, CSS modules, or another Vite plugin. The framework's chat primitives in `@parlor/client/react` ship no styles.
