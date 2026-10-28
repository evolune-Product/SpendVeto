// Vite config for the Console. Built by scripts/build-console.mjs (client
// bundle + a prerender of the HTML shell), not by `vite build` alone: the
// prerender is what puts all 14 data-page sections into the served HTML.
//
// `--mode demo` is the public demo at spendveto.com/console/ — the only
// differences from the product live here (head tags, demo files) and behind
// `import.meta.env.MODE === "demo"` in src/build.js (banner, links).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// The demo has no server: demo-api.js answers fetch() from snapshot.json. It is
// a classic script, so it runs before the (deferred) module entry fetches
// anything. A default-order transformIndexHtml hook runs after Vite has
// bundled the page, so the tag is emitted as written, not bundled.
function consoleDemo() {
  let ssr = false;
  return {
    name: "spendveto-console-demo",
    configResolved(c) { ssr = Boolean(c.build.ssr); },
    transformIndexHtml(html) {
      return {
        html: html.replace("<title>SpendVeto Console</title>", "<title>SpendVeto Console Demo</title>"),
        tags: [
          { tag: "meta", attrs: { name: "robots", content: "noindex" }, injectTo: "head" },
          { tag: "script", attrs: { src: "./demo-api.js" }, injectTo: "head" },
        ],
      };
    },
    generateBundle() {
      if (ssr) return;
      for (const f of ["demo-api.js", "snapshot.json"]) this.emitFile({ type: "asset", fileName: f, source: readFileSync(here(`./demo/${f}`)) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: here("."),
  // Relative, so one build works at / (the server) and at /console/ (the demo).
  base: "./",
  plugins: [react(), mode === "demo" && consoleDemo()],
  build: { outDir: here("./dist"), emptyOutDir: true },
  // `npx vite dashboard` for UI work: the API stays on the real server.
  server: { proxy: { "/api": "http://localhost:8402" } },
}));
