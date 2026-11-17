import { defineConfig } from "vite";

// Bundles src/index.ts together with its dependencies, alongside the
// unbundled tsc output in dist/ (which keeps dependencies external).
//
// - `vite build` (default mode) -> dist/bundled/: a single self-contained file,
//   with dynamically-imported codecs (e.g. zstd, blosc from numcodecs) inlined.
// - `vite build --mode dynamic` -> dist/bundled-dynamic/: dependencies are
//   bundled, but dynamically-imported codecs are emitted as separate chunks
//   that are only loaded when needed.
export default defineConfig(({ mode }) => {
  const isDynamic = mode === "dynamic";
  return {
    build: {
      outDir: isDynamic ? "dist/bundled-dynamic" : "dist/bundled",
      emptyOutDir: true,
      sourcemap: true,
      // No minification, so stack traces and debugging remain readable.
      minify: false,
      lib: {
        entry: "src/index.ts",
        formats: ["es"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        external: [
          // zarrita must stay external: we register custom codecs (snappy, brotli)
          // in zarrita's codec registry, which must be the same registry instance
          // that the consumer's zarrita uses when reading from the store.
          // (Consumers need zarrita anyway in order to read from the store.)
          "zarrita",
        ],
        output: {
          inlineDynamicImports: !isDynamic,
        },
      },
    },
  };
});
