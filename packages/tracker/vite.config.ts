/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      name: 'TipsyTrailsTracker',
      fileName: () => 'tracker.js',
    },
    rollupOptions: {
      external: [],
    },
  },
  test: {},
});
