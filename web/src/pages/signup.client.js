// The Governance API signup form is a React island (islands/Signup.jsx); this hydrates it.
import { hydrateIslands } from "../islands/hydrate.jsx";
import { SignupForm } from "../islands/Signup.jsx";

hydrateIslands({ signup: SignupForm });
