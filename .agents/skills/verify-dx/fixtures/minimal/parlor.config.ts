import { defineConfig } from "@parlor/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  app: { id: "com.example.dxminimal", name: "DX Minimal" },
  vite: { plugins: [tailwindcss()] },
});
