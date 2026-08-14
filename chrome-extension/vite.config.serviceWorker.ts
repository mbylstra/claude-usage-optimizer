import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Second build pass: bundles the MV3 service worker into a single
 * `dist/serviceWorker.js` with no shared chunks, which keeps the ES-module
 * service worker free of relative imports that Chrome would have to resolve.
 *
 * Runs with `emptyOutDir: false` so it does not wipe the popup build.
 */
export default defineConfig({
  // Stamped at build time so a running build can be identified from the outside —
  // see `buildStamp.d.ts` for why that is worth a define.
  define: {
    BUILD_STAMP: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: fileURLToPath(new URL('./extension/serviceWorker.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'serviceWorker.js',
    },
    rollupOptions: {
      // One file, no shared chunks for Chrome to resolve at worker start-up.
      output: { codeSplitting: false },
    },
  },
});
