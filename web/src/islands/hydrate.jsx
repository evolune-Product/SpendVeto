import { hydrateRoot } from "react-dom/client";

// Hydrates each [data-island] the server rendered (components/Island.jsx) with
// the component registered under its name, and the same props.
export function hydrateIslands(registry) {
  for (const el of document.querySelectorAll("[data-island]")) {
    const Component = registry[el.dataset.island];
    if (!Component) throw new Error(`no island registered as "${el.dataset.island}"`);
    hydrateRoot(el, <Component {...JSON.parse(el.dataset.props || "{}")} />);
  }
}
