import { build } from "esbuild";

await build({
  entryPoints: ["src/index.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/function.js",
  target: "es2022",
  external: ["@shopify/shopify_function"],
});

console.log("Build complete: dist/function.js");
