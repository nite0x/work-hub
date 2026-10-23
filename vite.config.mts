import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Library mode otherwise leaves React's Node environment checks in the IIFE.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./frontend", import.meta.url)) },
  },
  build: {
    outDir: "web/ui",
    emptyOutDir: true,
    lib: {
      entry: "frontend/main.tsx",
      name: "WorkHubComponents",
      formats: ["iife"],
      fileName: () => "ui.js",
      cssFileName: "ui",
    },
  },
})
