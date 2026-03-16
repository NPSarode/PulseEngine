import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/hub": {
        target: "http://processor:5050",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
