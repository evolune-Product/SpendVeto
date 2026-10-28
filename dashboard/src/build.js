// Product vs public demo, decided at build time (`vite build --mode demo`).
// The demo has no server behind it and lives on spendveto.com itself, so the
// links that point at a local site (:8403) point at the public one instead.
export const DEMO = import.meta.env.MODE === "demo";
export const SITE_URL = DEMO ? "/" : "http://localhost:8403";
export const DOCS_URL = DEMO ? "/docs" : "http://localhost:8403/docs";
