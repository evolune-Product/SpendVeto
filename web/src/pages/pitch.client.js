const slides = [...document.querySelectorAll(".slide")];
const dots = document.getElementById("dots");
slides.forEach((s, i) => {
const a = document.createElement("a");
a.href = `#${s.id}`;
dots.appendChild(a);
});
const dotEls = [...dots.children];
const spy = new IntersectionObserver(
(es) => es.forEach((e) => {
  if (e.isIntersecting) dotEls.forEach((d, i) => d.classList.toggle("on", slides[i] === e.target));
}),
{ threshold: 0.55 }
);
slides.forEach((s) => spy.observe(s));

const io = new IntersectionObserver(
(es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
{ threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el, i) => {
el.style.transitionDelay = `${(i % 4) * 80}ms`;
io.observe(el);
});

addEventListener("keydown", (e) => {
const idx = slides.findIndex((s) => s.getBoundingClientRect().top > -innerHeight / 2);
if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); slides[Math.min(idx + (slides[idx]?.getBoundingClientRect().top < innerHeight / 2 ? 1 : 0), slides.length - 1)]?.scrollIntoView({ behavior: "smooth" }); }
if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); slides[Math.max(idx - 1, 0)]?.scrollIntoView({ behavior: "smooth" }); }
});
