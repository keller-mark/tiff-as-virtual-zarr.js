import { defineConfig } from 'vite';

export default defineConfig({
  base: '/tiff-as-virtual-zarr.js/',
  root: 'demo',
  build: {
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
});
