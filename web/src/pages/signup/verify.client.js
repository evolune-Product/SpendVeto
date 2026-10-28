// The account-creation step is a React island (islands/Signup.jsx); this hydrates it.
import { hydrateIslands } from "../../islands/hydrate.jsx";
import { SignupVerify } from "../../islands/Signup.jsx";

hydrateIslands({ verify: SignupVerify });
