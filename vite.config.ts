import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA build. Output goes to dist/client, which wrangler.jsonc serves via the
// `assets` binding. In dev, /api is proxied to the local `wrangler dev` Worker.
export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
