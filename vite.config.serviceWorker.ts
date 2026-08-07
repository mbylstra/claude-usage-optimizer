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
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    lib: {
      entry: fileURLToPath(new URL('./src/extension/serviceWorker.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'serviceWorker.js',
    },
    rollupOptions: {
      // One file, no shared chunks for Chrome to resolve at worker start-up.
      output: { codeSplitting: false },
    },
  },
});
