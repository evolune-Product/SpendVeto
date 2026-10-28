// The controls and governed console are a React island (islands/Playground.jsx); this hydrates it.
import { hydrateIslands } from "../islands/hydrate.jsx";
import Playground from "../islands/Playground.jsx";

hydrateIslands({ playground: Playground });
