import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await build({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    outfile: path.resolve(distDir, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    sourcemap: true,
    logLevel: "info"
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
