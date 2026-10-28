import { useContext } from "react";
import { RouteContext } from "./route.js";

// One nav for every page — before this was a component, 31 hand-copied navs
// had drifted into 17 different link sets.
const LINKS = [
  ["/playground", "Playground"],
  ["/pricing", "Pricing"],
  ["/docs", "Docs"],
  ["/about", "About"],
];
const REGIONS = ["India", "EU", "UK", "Brazil", "US"];
const REGION_PAGES = ["/upi", "/eu", "/uk", "/br", "/us"];

export const Logo = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#46d68c" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10 4v16" /><path d="M14 4v16" /><path d="M4 4h6" /><path d="M14 6h6" /></svg>
);

// home: the landing page scrolls to its own top instead of reloading itself.
// cta="signin": the get-started page links onward to sign-in, not to itself.
export default function Nav({ home = false, cta }) {
  const path = useContext(RouteContext);
  const current = (href) => (href === path ? "page" : undefined);
  return (
    <nav>
      <a className="wordmark" href={home ? "#top" : "/"} style={home ? { display: "inline-flex", alignItems: "center", gap: "0.5rem" } : undefined}>
        <Logo />
        SPENDVETO<span className="tick">_</span>
      </a>
      <div className="nav-links">
        <a href={LINKS[0][0]} aria-current={current(LINKS[0][0])}>{LINKS[0][1]}</a>
        <a className="nav-rotator" href="/upi" aria-current={REGION_PAGES.includes(path) ? "page" : undefined}>
          Regions · <span className="rot">{REGIONS.map((r) => <em key={r}>{r}</em>)}</span>
        </a>
        {LINKS.slice(1).map(([href, label]) => <a key={href} href={href} aria-current={current(href)}>{label}</a>)}
        {cta === "signin"
          ? <a className="nav-cta" href="/signin">Sign in</a>
          : <a className="nav-cta" href="/signup">Get started</a>}
      </div>
    </nav>
  );
}
