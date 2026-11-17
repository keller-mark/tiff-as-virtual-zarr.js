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
        output: {
          inlineDynamicImports: !isDynamic,
        },
      },
    },
  };
});
