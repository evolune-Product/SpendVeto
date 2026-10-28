// The evaluator form is a React island (islands/RegionEvaluator.jsx); this hydrates it.
import { hydrateIslands } from "../islands/hydrate.jsx";
import { SepaEvaluator } from "../islands/RegionEvaluator.jsx";

hydrateIslands({ evaluator: SepaEvaluator });
