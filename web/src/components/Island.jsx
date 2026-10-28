import { renderToString } from "react-dom/server";

// An interactive widget on an otherwise static page. The page itself is
// rendered with renderToStaticMarkup (no React in the browser); an island is
// rendered with renderToString instead — hydratable markup — and marked with
// its registry name, so the page's .client.js can hydrate just this subtree
// (islands/hydrate.jsx). Only pages with islands download React.
//
// dangerouslySetInnerHTML carries React's own server output, never user text.
// display: contents keeps the wrapper out of the page's grid/flex layout.
export default function Island({ name, component: Component, props = {} }) {
  return (
    <div
      data-island={name}
      data-props={JSON.stringify(props)}
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: renderToString(<Component {...props} />) }}
    />
  );
}
