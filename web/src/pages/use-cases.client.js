const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = `${(i % 3) * 70}ms`; io.observe(el); });
