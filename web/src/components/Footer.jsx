// Every page links every other section of the site from here; the per-page
// line next to the wordmark is the only part that varies.
const LINKS = [
  ["/console/", "Console demo"],
  ["/playground", "Playground"],
  ["/use-cases", "Use cases"],
  ["/ai-spend", "AI spend"],
  ["/guides", "Guides"],
  ["/network", "Network"],
  ["/upi", "India · UPI"],
  ["/eu", "EU · SCA"],
  ["/uk", "UK · Faster Payments"],
  ["/br", "Brazil · Pix"],
  ["/us", "US · ACH"],
  ["/pricing", "Pricing"],
  ["/docs", "Docs"],
  ["/about", "About"],
  ["/security", "Security"],
  ["/contact", "Contact"],
  ["/pitch", "Pitch"],
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/signin", "Sign in"],
  ["/signup", "Get started"],
];

export default function Footer({ note }) {
  return (
    <footer>
      <span className="wordmark">SPENDVETO<span className="tick">_</span></span>
      {note && <span>{note}</span>}
      <div className="backers">
        <a className="inception" href="https://www.nvidia.com/en-us/startups/" target="_blank" rel="noopener"><img src="/assets/nvidia-inception-badge.png" alt="NVIDIA Inception Program member badge" width="91" height="36" loading="lazy" /><span>Built by Evolune EdgeTech LLP, a member of NVIDIA Inception.</span></a>
        <a href="https://www.producthunt.com/products/spendveto?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-spendveto" target="_blank" rel="noopener noreferrer"><img src="/assets/producthunt-featured.svg" alt="SpendVeto on Product Hunt" width="167" height="36" loading="lazy" /></a>
      </div>
      <div className="links">
        {LINKS.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
      </div>
      <p className="tm">© 2026 NVIDIA, the NVIDIA logo, and NVIDIA Inception are trademarks and/or registered trademarks of NVIDIA Corporation in the U.S. and other countries.</p>
    </footer>
  );
}
