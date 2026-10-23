import { defineConfig } from "@parlor/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  app: {
    id: "com.example.parlorapp",
    name: "Parlor App",
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
