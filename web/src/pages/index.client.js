import * as THREE from "three";

// ---------- demo video: swap the poster for the player on first click ----------
document.getElementById("demo-video").addEventListener("click", function onPlay() {
  const btn = this;
  const video = document.createElement("video");
  video.src = "/assets/demo.mp4";
  video.controls = true;
  video.controlsList = "nodownload";
  video.oncontextmenu = () => false;
  video.autoplay = true;
  video.playsInline = true;
  video.className = "video-frame";
  btn.replaceWith(video);
  video.play();
});

// ---------- hero: a stream of payments meeting the gate ----------
const canvas = document.getElementById("bg");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
} catch {
  canvas.style.display = "none";
}

if (renderer) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x070a08, 26, 46);
  const camera = new THREE.PerspectiveCamera(50, 2, 0.1, 120);
  camera.position.set(0, 0, 21);

  const N = 2400;
  const BOUND_X = 36, GATE_X = 0, BLOCK_RATE = 0.13;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const decided = new Uint8Array(N);
  const target = new Float32Array(N * 3);

  const BASE = [0.36, 0.42, 0.38];
  const GREEN = [0.28, 0.84, 0.55];
  const COPPER = [0.88, 0.63, 0.36];

  function spawn(i, initial) {
    const i3 = i * 3;
    positions[i3] = initial ? (Math.random() * 2 - 1) * BOUND_X : -BOUND_X + Math.random() * 4;
    positions[i3 + 1] = (Math.random() * 2 - 1) * 8.5;
    positions[i3 + 2] = (Math.random() * 2 - 1) * 5 - 1.5;
    vel[i3] = 0.045 + Math.random() * 0.085;
    vel[i3 + 1] = (Math.random() - 0.5) * 0.004;
    vel[i3 + 2] = 0;
    decided[i] = initial && positions[i3] > GATE_X ? 1 : 0;
    const shade = 0.75 + Math.random() * 0.5;
    const c = decided[i] ? GREEN : BASE;
    for (let k = 0; k < 3; k++) {
      colors[i3 + k] = c[k] * shade;
      target[i3 + k] = c[k] * shade;
    }
  }
  for (let i = 0; i < N; i++) spawn(i, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.11, vertexColors: true, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  scene.add(new THREE.Points(geo, mat));

  // The gate: a thin luminous plane, soft aura, and breathing rings.
  const gateCore = new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, 19),
    new THREE.MeshBasicMaterial({ color: 0x46d68c, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending })
  );
  const gateAura = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 19),
    new THREE.MeshBasicMaterial({ color: 0x1f7a52, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending })
  );
  const gateRing = new THREE.Mesh(
    new THREE.TorusGeometry(4.6, 0.015, 8, 120),
    new THREE.MeshBasicMaterial({ color: 0x46d68c, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending })
  );
  const gateRingOuter = new THREE.Mesh(
    new THREE.TorusGeometry(6.1, 0.008, 8, 120),
    new THREE.MeshBasicMaterial({ color: 0x46d68c, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending })
  );
  scene.add(gateCore, gateAura, gateRing, gateRingOuter);

  // Structural depth: a vast, slow wireframe icosahedron — the vault.
  const vault = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(13, 1)),
    new THREE.LineBasicMaterial({ color: 0x2a4a38, transparent: true, opacity: 0.14 })
  );
  vault.position.set(0, 0, -9);
  scene.add(vault);

  // Far dust for parallax depth.
  const DUST = 700;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    dustPos[i * 3] = (Math.random() * 2 - 1) * 55;
    dustPos[i * 3 + 1] = (Math.random() * 2 - 1) * 30;
    dustPos[i * 3 + 2] = -14 - Math.random() * 20;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x46785c, size: 0.06, transparent: true, opacity: 0.5, depthWrite: false })));

  let mx = 0, my = 0;
  addEventListener("pointermove", (e) => {
    mx = (e.clientX / innerWidth) * 2 - 1;
    my = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  let t = 0;
  function tick() {
    t += 0.016;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      positions[i3] += vel[i3];
      positions[i3 + 1] += vel[i3 + 1] + Math.sin(t * 0.8 + i) * 0.0012;
      if (!decided[i] && positions[i3] >= GATE_X) {
        decided[i] = 1;
        const blocked = Math.random() < BLOCK_RATE;
        const c = blocked ? COPPER : GREEN;
        const shade = 0.8 + Math.random() * 0.45;
        for (let k = 0; k < 3; k++) target[i3 + k] = c[k] * shade;
        if (blocked) {
          vel[i3] *= -0.62;
          vel[i3 + 1] += (positions[i3 + 1] >= 0 ? 1 : -1) * (0.02 + Math.random() * 0.03);
        } else {
          vel[i3] *= 1.4;
        }
      }
      colors[i3] += (target[i3] - colors[i3]) * 0.08;
      colors[i3 + 1] += (target[i3 + 1] - colors[i3 + 1]) * 0.08;
      colors[i3 + 2] += (target[i3 + 2] - colors[i3 + 2]) * 0.08;
      if (positions[i3] > BOUND_X || positions[i3] < -BOUND_X || Math.abs(positions[i3 + 1]) > 13) spawn(i, false);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;

    gateCore.material.opacity = 0.42 + Math.sin(t * 1.6) * 0.1;
    gateRing.rotation.z = t * 0.12;
    gateRing.material.opacity = 0.28 + Math.sin(t * 1.1) * 0.1;
    gateRingOuter.rotation.z = -t * 0.07;
    gateRing.scale.setScalar(1 + Math.sin(t * 0.9) * 0.015);
    vault.rotation.y = t * 0.03;
    vault.rotation.x = Math.sin(t * 0.11) * 0.12;
    camera.position.x += (mx * 1.7 - camera.position.x) * 0.03;
    camera.position.y += (-my * 1.1 - camera.position.y) * 0.03;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    if (!reduced) requestAnimationFrame(tick);
  }
  tick();
}

// ---------- ticker loop ----------
const track = document.getElementById("ticker-track");
// Two copies back to back make the loop seamless; the space between them is
// the same gap that separates every other item.
track.innerHTML += " " + track.innerHTML;

// ---------- scroll reveals ----------
const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("in")),
  { threshold: 0.12 }
);
document.querySelectorAll(".reveal").forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 70}ms`;
  io.observe(el);
});

// ---------- cursor glow ----------
const glow = document.createElement("div");
glow.id = "cursor-glow";
glow.style.opacity = "0";
document.body.appendChild(glow);
addEventListener("pointermove", (e) => {
  glow.style.opacity = "1";
  glow.style.left = e.clientX + "px";
  glow.style.top = e.clientY + "px";
}, { passive: true });

// ---------- decrypt effect on the market stats ----------
const CHARS = "01$#%&+ABCDEF";
function scramble(el) {
  const finalText = el.dataset.final ?? (el.dataset.final = el.textContent);
  let frame = 0;
  const total = 26;
  (function step() {
    frame++;
    el.textContent = [...finalText]
      .map((ch, i) => (ch === " " ? " " : i < (frame / total) * finalText.length ? ch : CHARS[(Math.random() * CHARS.length) | 0]))
      .join("");
    if (frame < total) requestAnimationFrame(step);
    else el.textContent = finalText;
  })();
}
const statIO = new IntersectionObserver(
  (entries) =>
    entries.forEach((e) => {
      if (e.isIntersecting) {
        scramble(e.target);
        statIO.unobserve(e.target);
      }
    }),
  { threshold: 0.6 }
);
document.querySelectorAll(".n-val").forEach((el) => statIO.observe(el));

// ---------- scroll progress ----------
const bar = document.getElementById("scroll-progress");
addEventListener("scroll", () => {
  const h = document.documentElement;
  bar.style.transform = `scaleX(${(h.scrollTop / (h.scrollHeight - h.clientHeight)).toFixed(4)})`;
}, { passive: true });

// ---------- live stats from a running SpendVeto server (graceful if absent) ----------
// The console API only ever exists on the machine running `npm run server`.
// A PUBLIC page reaching for localhost is indistinguishable from malware
// probing your machine — Chrome's Local Network Access permission now prompts
// every visitor with "wants to access other apps and services on this device".
// So only ask when this page is itself served locally; the public build takes
// the fallback path that was already written for a server being absent.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const IS_LOCAL = LOCAL_HOSTS.includes(location.hostname);

(async () => {
  try {
    if (!IS_LOCAL) throw new Error("public build — no local server to ask");
    const s = await fetch("http://localhost:8402/api/stats", { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    document.getElementById("live-stats").innerHTML =
      `LIVE · governed <b>$${s.paid.usd}</b> · blocked <b>$${s.blocked.usd}</b> across ${s.blocked.count + s.paid.count} decisions`;
    document.getElementById("g-paid").textContent = `$${s.paid.usd}`;
    document.getElementById("g-blocked").textContent = `$${s.blocked.usd}`;
    document.getElementById("g-frozen").textContent = s.frozenWallets;
  } catch {
    // No local server — the public case. Read the figures the verify suite
    // itself published (site/assets/verify-stats.json, written on every passing
    // run) rather than hard-coding them, which is how this panel drifted out of
    // date three separate times.
    try {
      const v = await fetch("/assets/verify-stats.json", { cache: "no-cache" }).then((r) => r.json());
      document.getElementById("g-paid").textContent = `$${Number(v.paid.usd).toFixed(3)}`;
      document.getElementById("g-blocked").textContent = `$${Number(v.blocked.usd).toFixed(3)}`;
      document.getElementById("g-frozen").textContent = v.frozenWallets;
      document.querySelectorAll("#proof .gstat .k").forEach((k) => {
        k.textContent = k.textContent.replace(" (live from your local server)", " (latest verification run)");
      });
    } catch {
      // Rather than invent a number, show nothing.
      document.querySelectorAll("#proof .gstat .n").forEach((n) => { n.textContent = "—"; });
    }
  }
})();
