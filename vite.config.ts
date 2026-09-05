import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      // Keep the project's explicit SSR server entry without depending on Lovable's config wrapper.
      server: { entry: "server" },
    }),
    // TanStack Start must run before the React plugin.
    viteReact(),
    // Nitro provides the Vercel-compatible server build for TanStack Start.
    nitro(),
  ],
});
