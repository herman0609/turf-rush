import { defineConfig } from 'vite';

const target = process.env.TURF_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target },
      '/healthz': { target },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});
