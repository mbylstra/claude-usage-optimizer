import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Builds the extension's two pages — the popup and the detached run-log window —
 * and copies `public/`, which holds `manifest.json` and the toolbar icons, to
 * the root of `dist/`. The pages may share chunks; only the service worker
 * cannot.
 *
 * The MV3 service worker is built separately by `vite.config.serviceWorker.ts`
 * so that it lands in `dist/` as one self-contained file with no shared chunks.
 */
export default defineConfig({
  // Stamped at build time so a running build can be identified from the outside —
  // see `buildStamp.d.ts` for why that is worth a define.
  define: {
    BUILD_STAMP: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
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
        runLog: fileURLToPath(new URL('./run-log.html', import.meta.url)),
      },
    },
  },
  base: './',
});
