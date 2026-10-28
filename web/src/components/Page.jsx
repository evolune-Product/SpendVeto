import Nav from "./Nav.jsx";
import Footer from "./Footer.jsx";

// The frame every page shares. `before` holds full-viewport layers that sit
// outside #canvas-frame (the landing page's noise + scroll-progress bar).
export default function Page({ children, note, home, cta, before }) {
  return (
    <>
      {before}
      <div id="canvas-frame">
        <Nav home={home} cta={cta} />
        {children}
        <Footer note={note} />
      </div>
    </>
  );
}
