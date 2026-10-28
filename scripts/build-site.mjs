// Builds the marketing site: web/ (React + Vite) → site/ (static HTML).
//
//   1. SSR build of web/src/entry-server.jsx — every page component, plus the
//      list of CSS files each page imports (read from the module graph).
//   2. Client build — each stylesheet, and each page's <page>.client.js if
//      it has one. web/public/ is copied as-is.
//   3. Prerender — each page rendered to static HTML with its own head,
//      stylesheets and script. No React runtime reaches the browser.
//
// The output is plain files, so site/ still deploys to any static host.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "site");
const TMP = join(WEB, ".build");
const ORIGIN = "https://spendveto.com";
const posix = (p) => p.split("\\").join("/");

rmSync(TMP, { recursive: true, force: true });

// --- 1. SSR build --------------------------------------------------------
const cssByPage = {};
await build({
  root: WEB,
  configFile: false,
  logLevel: "warn",
  publicDir: false,
  plugins: [
    react(),
    {
      name: "collect-page-css",
      // Walk each page's imports in source order, so pages.css still lands
      // before the page's own stylesheet, as it did in the old <head>.
      buildEnd() {
        for (const id of this.getModuleIds()) {
          const m = posix(id).match(/\/web\/src\/pages\/(.+)\.jsx$/);
          if (!m) continue;
          const seen = new Set(), css = [];
          const walk = (mid) => {
            if (seen.has(mid)) return;
            seen.add(mid);
            if (/\.css$/.test(mid)) return void css.push(mid);
            if (mid.includes("node_modules")) return;
            for (const dep of this.getModuleInfo(mid)?.importedIds || []) walk(dep);
          };
          walk(id);
          cssByPage[m[1]] = css;
        }
      },
    },
  ],
  build: { ssr: "src/entry-server.jsx", outDir: join(TMP, "ssr"), emptyOutDir: true, minify: false },
});
const { pages, render } = await import(pathToFileURL(join(TMP, "ssr", "entry-server.js")).href);

// --- 2. Client build -----------------------------------------------------
// Every stylesheet is its own entry, so the manifest maps source → output
// and each page links them in its own import order. (Bundled together per
// page, Vite orders an entry's CSS its own way — pages.css landed after the
// page's overrides and won.) Pages with behaviour get their .client.js.
const input = {};
for (const file of new Set(Object.values(cssByPage).flat())) input[`css/${posix(relative(join(WEB, "src"), file)).replace(/\.css$/, "")}`] = file;
for (const page of pages) if (page.client) input[page.name] = join(WEB, "src/pages", `${page.name}.client.js`);
await build({
  root: WEB,
  configFile: false,
  logLevel: "warn",
  publicDir: join(WEB, "public"),
  // Islands (web/src/islands) are JSX; plain .client.js scripts pass through.
  plugins: [react()],
  build: {
    outDir: OUT,
    emptyOutDir: true,
    // Hashed build files go under /static/ so they can't collide with the
    // hand-named files in public/assets/ (the evaluators verify checks).
    assetsDir: "static",
    manifest: true,
    modulePreload: { polyfill: false },
    // The landing page's three.js scene is one ~530 kB chunk (131 kB gzipped),
    // tree-shaken from the 750 kB of vendored three.js it replaced.
    chunkSizeWarningLimit: 600,
    rollupOptions: { input },
  },
});

// --- 3. Prerender ---------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(OUT, ".vite", "manifest.json"), "utf8"));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function assetsFor(page) {
  const css = (cssByPage[page.name] || []).map((file) => `/${manifest[posix(relative(WEB, file))].file}`);
  if (!page.client) return { css, js: null, preload: [] };
  const entry = manifest[posix(relative(WEB, join(WEB, "src/pages", `${page.name}.client.js`)))];
  const preload = new Set();
  const walk = (chunk) => {
    for (const key of chunk.imports || []) {
      if (preload.has(`/${manifest[key].file}`)) continue;
      preload.add(`/${manifest[key].file}`);
      walk(manifest[key]);
    }
  };
  walk(entry);
  return { css, js: `/${entry.file}`, preload: [...preload] };
}

function headHtml(h, assets) {
  const url = `${ORIGIN}${h.path}`;
  const ogTitle = h.ogTitle ?? h.title, ogDescription = h.ogDescription ?? h.description;
  const ogImage = h.ogImage ?? `${ORIGIN}/assets/generated/og-default.png`;
  const tags = [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<meta name="color-scheme" content="dark" />`,
    `<title>${esc(h.title)}</title>`,
    `<meta name="description" content="${esc(h.description)}" />`,
    h.keywords && `<meta name="keywords" content="${esc(h.keywords)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta name="robots" content="${esc(h.robots ?? "index, follow, max-image-preview:large, max-snippet:-1")}" />`,
    `<meta property="og:type" content="${esc(h.ogType ?? "website")}" />`,
    `<meta property="og:site_name" content="SpendVeto" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:title" content="${esc(ogTitle)}" />`,
    `<meta property="og:description" content="${esc(ogDescription)}" />`,
    `<meta property="og:image" content="${esc(ogImage)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(h.twitterTitle ?? ogTitle)}" />`,
    `<meta name="twitter:description" content="${esc(h.twitterDescription ?? ogDescription)}" />`,
    `<meta name="twitter:image" content="${esc(ogImage)}" />`,
    `<link rel="icon" href="/assets/favicon.svg" />`,
    ...assets.css.map((href) => `<link rel="stylesheet" href="${href}" />`),
    ...assets.preload.map((href) => `<link rel="modulepreload" href="${href}" />`),
    // `<\/` keeps a "</script>" inside a JSON string from closing the tag.
    ...(h.jsonLd || []).map((ld) => `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, "<\\/")}</script>`),
  ];
  return tags.filter(Boolean).join("\n");
}

for (const page of pages) {
  const assets = assetsFor(page);
  // React emits <link rel="preload"> for eager images ahead of the markup;
  // they belong in <head>, where the browser sees them first.
  let body = render(page), preloads = "";
  body = body.replace(/^(?:<link rel="preload"[^>]*\/>)+/, (m) => ((preloads = m.replace(/\/></g, "/>\n<")), ""));
  const html = [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    headHtml(page.head, assets),
    preloads,
    `</head>`,
    `<body>`,
    body,
    page.client ? `<script type="module" src="${assets.js}"></script>` : "",
    `</body>`,
    `</html>`,
    "",
  ].filter((l) => l !== "").join("\n");
  const file = join(OUT, `${page.name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

// Pages are served at clean URLs (/docs, /guides/x) from their .html files.
// Every page shipped as /x.html before 2026-10-27, so those URLs answer 301
// to the clean one — links and search results already out there keep working.
// _redirects is read by Cloudflare static assets and Netlify; Nginx carries
// the same rule itself (see the Contabo deployment guide).
writeFileSync(join(OUT, "_redirects"), pages.map((p) => `/${p.name}.html ${p.head.path} 301`).join("\n") + "\n");

rmSync(join(OUT, ".vite"), { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });

// The public Console demo at /console/ is the real Console, built in demo mode.
// --skip-console: rebuild just the pages while iterating on them.
if (!process.argv.includes("--skip-console")) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "build-console.mjs"), "--demo", "--out", join(OUT, "console")], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("console demo build failed");
}

console.log(`site/ built — ${pages.length} pages`);
