import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const outfile = resolve(".mastra/output/server.mjs");
await mkdir(dirname(outfile), { recursive: true });
await build({
  bundle: true,
  entryPoints: ["src/server.ts"],
  format: "esm",
  outfile,
  packages: "external",
  platform: "node",
  target: "node22",
});
