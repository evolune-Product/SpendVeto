// Serves the built marketing site (site/ — `npm run build:site`, which
// `npm run site` runs first) the way production does: clean URLs (/docs
// answers with docs.html) and a 301 from any old /x.html URL to /x.
import express from "express";
import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../site", import.meta.url));
const app = express();
app.use((req, res, next) => {
  if (!req.path.endsWith(".html")) return next();
  const clean = req.path.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1");
  res.redirect(301, clean + req.url.slice(req.path.length));
});
// Resolved here rather than with express.static's `extensions`: /guides is
// both guides.html and a guides/ folder, and static would redirect it to
// /guides/ before ever trying the .html file.
app.use((req, res, next) => {
  if (extname(req.path) || req.path.endsWith("/") && req.path !== "/") return next();
  const file = resolve(ROOT, req.path === "/" ? "index.html" : `.${req.path}.html`);
  if (file.startsWith(ROOT + sep) && existsSync(file)) return res.sendFile(file);
  next();
});
app.use(express.static(ROOT));

const PORT = process.env.SITE_PORT || 8403;
app.listen(PORT, () => {
  console.log(`SpendVeto site → http://localhost:${PORT}`);
  console.log(`(run \`npm run server\` too so the "Open the live dashboard" link works)`);
});
