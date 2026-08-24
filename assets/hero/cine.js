/* ============================================================
   CTD · Hero cinemático — scroll scrub + crossfades (vanilla)
   Carga progresiva: solo el clip 2 precarga; 4→5→6 en cadena
   (cada uno mientras se ve el anterior). Gates para que la carga
   nunca se note. Un solo recorrido: camión → oscuro → carga → caja → bodega.
   ============================================================ */
(function () {
  var sec = document.getElementById('inicio');
  if (!sec || !sec.classList.contains('cine')) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  var clips = [].slice.call(sec.querySelectorAll('.cine-clip'));
  if (clips.length < 4) return;
  var black = sec.querySelector('.cine-black');
  var copy  = sec.querySelector('.cine-copy');
  var prog  = sec.querySelector('.cine-prog');
  var cue   = sec.querySelector('.cine-cue');
  var idx   = sec.querySelector('.cine-hud-idx');

  var dur   = [6, 6, 6, 6];
  var ready = [false, false, false, false];

  clips.forEach(function (v, i) {
    var meta = function () { if (v.duration) dur[i] = v.duration; };
    // "listo" = puede reproducirse de corrido (canplay/readyState>=3), no
    // solo el primer frame: así el seek del scrub es suave y no se nota la carga.
    var mark = function () { meta(); if (v.readyState >= 3) ready[i] = true; };
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('loadeddata', meta);
    v.addEventListener('canplay', mark);
    v.addEventListener('canplaythrough', function () { meta(); ready[i] = true; });
    if (v.readyState >= 3) ready[i] = true;
  });

  // Solo el clip 0 (video 2) precarga de inmediato (está en preload=auto).
  try { clips[0].load(); } catch (e) {}

  // Cadena de carga en segundo plano: 1 → 2 → 3.
  // Cada uno empieza cuando el anterior ya puede reproducirse, así el
  // siguiente se descarga mientras el usuario mira el actual.
  function chain(i) {
    if (i >= clips.length) return;
    var v = clips[i];
    v.preload = 'auto';
    var advanced = false;
    var next = function () { if (advanced) return; advanced = true; chain(i + 1); };
    v.addEventListener('canplaythrough', next, { once: true });
    v.addEventListener('canplay', next, { once: true });
    v.addEventListener('loadeddata', next, { once: true });
    try { v.load(); } catch (e) {}
    setTimeout(next, 6000); // no atorar la cadena si un clip tarda
  }
  var chainStarted = false;
  function kickChain() { if (chainStarted) return; chainStarted = true; chain(1); }
  if (clips[0].readyState >= 2) kickChain();
  else clips[0].addEventListener('loadeddata', kickChain, { once: true });
  window.addEventListener('load', function () { setTimeout(kickChain, 800); });
  if ('requestIdleCallback' in window) requestIdleCallback(kickChain, { timeout: 2500 });

  sec.classList.add('is-ready');

  var clamp  = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  function op(p, ia, ib, oa, ob) {
    return clamp(Math.min(smooth((p - ia) / (ib - ia)), 1 - smooth((p - oa) / (ob - oa))), 0, 1);
  }
  function local(p, a, b) { return clamp((p - a) / (b - a), 0, 1); }

  // Reveal (fade-in) monotónico: cada clip aparece ENCIMA del anterior, que se
  // queda debajo a opacidad 1. Así nunca se ve la imagen base del camión entre
  // transiciones (solo al inicio, como hero).
  var IN = [[0.00, 0.03], [0.35, 0.44], [0.585, 0.64], [0.80, 0.855]];
  var SC = [[0.02, 0.30], [0.37, 0.585], [0.60, 0.80], [0.83, 1.00]];

  function setCT(v, i, lp) {
    var t = clamp(lp, 0, 1) * (dur[i] - 0.06);
    if (isFinite(t) && Math.abs(v.currentTime - t) > 0.033) { try { v.currentTime = t; } catch (e) {} }
  }

  // Priming para seek en iOS: play+pause en el primer gesto.
  var primed = false;
  function prime() {
    if (primed) return; primed = true;
    clips.forEach(function (v) {
      var pr = v.play(); if (pr && pr.then) pr.then(function () { v.pause(); }).catch(function () {});
      else { try { v.pause(); } catch (e) {} }
    });
  }
  ['scroll', 'pointerdown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, prime, { once: true, passive: true });
  });

  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }

  function apply() {
    ticking = false;
    var r = sec.getBoundingClientRect();
    var h = sec.offsetHeight - window.innerHeight;
    var p = h <= 0 ? 0 : clamp(-r.top / h, 0, 1);
    if (prog) prog.style.width = (p * 100) + '%';

    if (copy) {
      var cf = 1 - smooth(p / 0.14);
      copy.style.opacity = cf;
      copy.style.transform = 'translateY(' + ((1 - cf) * -26).toFixed(1) + 'px)';
      copy.style.pointerEvents = cf < 0.08 ? 'none' : '';
    }

    // Reveal monotónico (sin fade-out): el clip de encima aparece sobre el de
    // abajo, que se queda a opacidad 1 → el camión base no se asoma en las
    // transiciones. Gate: si un clip no está listo, no se revela (se queda el anterior).
    var rev = [
      smooth((p - IN[0][0]) / (IN[0][1] - IN[0][0])),
      smooth((p - IN[1][0]) / (IN[1][1] - IN[1][0])),
      smooth((p - IN[2][0]) / (IN[2][1] - IN[2][0])),
      smooth((p - IN[3][0]) / (IN[3][1] - IN[3][0]))
    ];
    var topi = 0;
    for (var i = 0; i < 4; i++) {
      if (i > 0 && !ready[i]) rev[i] = 0;
      clips[i].style.opacity = rev[i];
      if (rev[i] > 0.02) topi = i;
    }
    if (ready[topi]) setCT(clips[topi], topi, local(p, SC[topi][0], SC[topi][1]));

    // Refuerzo de negro en el empalme 2→4 (o sostén si v4 aún no está listo)
    var bl = op(p, 0.29, 0.32, 0.35, 0.40);
    if (!ready[1] && p > 0.30 && p < 0.52) bl = 1;
    if (black) black.style.opacity = bl;
    if (idx) idx.textContent = ('0' + (topi + 1)) + ' / 04';
    if (cue) cue.style.opacity = smooth((p - 0.9) / 0.07).toFixed(2);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', apply);
  apply();
})();
