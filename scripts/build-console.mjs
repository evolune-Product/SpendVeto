// Builds the Console (dashboard/) into dashboard/dist/, which server/index.js
// serves at /. Two Vite builds: the client bundle, then an SSR bundle used once
// here to prerender the HTML shell — so GET / already carries all 14 page
// sections (verify asserts on them) and the browser hydrates instead of
// painting from nothing. The SSR bundle is deleted afterwards; dist/ holds
// only what gets served.
//
//   node scripts/build-console.mjs                       → dashboard/dist/
//   node scripts/build-console.mjs --demo --out site/console
//
// --demo is the public demo at spendveto.com/console/: same app, built with
// `--mode demo` (see dashboard/vite.config.js and dashboard/src/build.js).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const ROOT = fileURLToPath(new URL("../dashboard/", import.meta.url));
const CONFIG = join(ROOT, "vite.config.js");
const OUTLET = "<!--console-prerender-->";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const outFlag = args.indexOf("--out");
const outDir = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]) : join(ROOT, "dist");
// Inside dashboard/ so the SSR bundle's bare imports (react, react-dom/server)
// resolve against the repo's node_modules.
const ssrDir = join(ROOT, ".ssr");
const mode = demo ? "demo" : "production";

// The client build empties outDir. Refuse a directory that holds anything
// other than a previous Console build, so a mistyped --out can't wipe it.
if (existsSync(outDir) && readdirSync(outDir).length) {
  const prev = join(outDir, "index.html");
  if (!existsSync(prev) || !readFileSync(prev, "utf8").includes('data-page="overview"')) {
    console.error(`refusing to empty ${outDir}: it isn't a previous Console build`);
    process.exit(1);
  }
}

const quiet = { configFile: CONFIG, mode, logLevel: "warn" };
await build({ ...quiet, build: { outDir, emptyOutDir: true } });
try {
  const ssr = await build({ ...quiet, build: { ssr: "src/entry-server.jsx", outDir: ssrDir, emptyOutDir: true } });
  const entry = [ssr].flat()[0].output.find((o) => o.type === "chunk" && o.isEntry).fileName;
  const { render } = await import(pathToFileURL(join(ssrDir, entry)).href);

  const page = join(outDir, "index.html");
  const html = readFileSync(page, "utf8");
  if (!html.includes(OUTLET)) throw new Error(`dashboard/index.html lost its ${OUTLET} marker`);
  // A function, not a string: the page is full of "$" and replace() would
  // read "$'" / "$&" in it as patterns.
  writeFileSync(page, html.replace(OUTLET, () => render()));
} finally {
  rmSync(ssrDir, { recursive: true, force: true });
}
// stderr: `npm pack --json` runs this as `prepare`, and its stdout must stay pure JSON.
console.error(`Console${demo ? " demo" : ""} built → ${outDir}`);
