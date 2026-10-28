import { createContext } from "react";

// The path of the page being prerendered ("/docs"), so shared
// components can mark the current page without reading `location`.
export const RouteContext = createContext("/");
