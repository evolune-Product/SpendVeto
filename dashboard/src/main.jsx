import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App.jsx";

// The built page arrives prerendered (scripts/build-console.mjs), so hydrate
// it; the Vite dev server serves the empty template, so render from scratch.
const root = document.getElementById("root");
if (root.hasChildNodes()) hydrateRoot(root, <App />);
else createRoot(root).render(<App />);
