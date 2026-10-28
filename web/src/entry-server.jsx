import { renderToStaticMarkup } from "react-dom/server";
import { RouteContext } from "./components/route.js";

// Every file under pages/ is a page: pages/guides/x.jsx is served at /guides/x
// (written to site/guides/x.html; hosts map the clean URL onto the file).
const modules = import.meta.glob("./pages/**/*.jsx", { eager: true });

export const pages = Object.entries(modules).map(([file, mod]) => {
  const name = file.slice("./pages/".length, -".jsx".length);
  if (!mod.head?.title || !mod.head?.description || !mod.head?.path) throw new Error(`${file}: head needs title, description and path`);
  const url = name === "index" ? "/" : `/${name}`;
  if (mod.head.path !== url) throw new Error(`${file}: head.path is "${mod.head.path}" but the page is served at "${url}"`);
  return { name, file: `src/pages/${name}.jsx`, head: mod.head, client: Boolean(mod.client), Component: mod.default };
});

// Static markup, not hydratable markup: pages ship no React runtime. Their
// behaviour is plain DOM code in <page>.client.js.
export function render(page) {
  return renderToStaticMarkup(
    <RouteContext value={page.head.path}>
      <page.Component />
    </RouteContext>,
  );
}
