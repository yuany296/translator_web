import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/popup",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/popup",
    emptyOutDir: true
  }
});
