// Build-time only: scripts/build-console.mjs renders the Console's empty shell
// (no polled data yet — exactly what the client's first render produces) into
// dist/index.html, so GET / answers with every page section already there.
import { renderToString } from "react-dom/server";
import App from "./App.jsx";

export const render = () => renderToString(<App />);
