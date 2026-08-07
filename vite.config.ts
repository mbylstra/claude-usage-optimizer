import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Builds the popup (HTML + React bundle) and copies `public/` — which holds
 * `manifest.json` and the toolbar icons — to the root of `dist/`.
 *
 * The MV3 service worker is built separately by `vite.config.serviceWorker.ts`
 * so that it lands in `dist/` as one self-contained file with no shared chunks.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome extension pages load from a `chrome-extension://` origin, so
    // relative asset URLs are the only ones that resolve.
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL('./popup.html', import.meta.url)),
      },
    },
  },
  base: './',
});
