/* ============================================================
   CTD · Hero cinemático — scroll scrub + crossfades (vanilla)
   Un solo recorrido continuo: camión → oscuro → carga → caja → bodega.
   ============================================================ */
(function () {
  var sec = document.getElementById('inicio');
  if (!sec || !sec.classList.contains('cine')) return;

  // Reduced motion: hero estático (imagen 1 + texto), sin pin ni scrub.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  var clips = [].slice.call(sec.querySelectorAll('.cine-clip'));
  if (clips.length < 4) return;
  var black = sec.querySelector('.cine-black');
  var copy  = sec.querySelector('.cine-copy');
  var prog  = sec.querySelector('.cine-prog');
  var cue   = sec.querySelector('.cine-cue');
  var idx   = sec.querySelector('.cine-hud-idx');

  var dur = [6, 6, 6, 6];
  clips.forEach(function (v, i) {
    v.addEventListener('loadedmetadata', function () { if (v.duration) dur[i] = v.duration; });
    try { v.load(); } catch (e) {}
  });

  // Habilita el pin (altura alta). Sin esto queda como hero normal.
  sec.classList.add('is-ready');

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  // trapecio de opacidad: sube en [ia,ib], baja en [oa,ob]
  function op(p, ia, ib, oa, ob) {
    var up = smooth((p - ia) / (ib - ia));
    var down = 1 - smooth((p - oa) / (ob - oa));
    return clamp(Math.min(up, down), 0, 1);
  }
  function local(p, a, b) { return clamp((p - a) / (b - a), 0, 1); }

  // Ventanas (opacidad in/out) y (scrub start/end) por clip, en p[0..1]
  var OP = [
    [0.00, 0.03, 0.28, 0.33],
    [0.35, 0.42, 0.56, 0.605],
    [0.565, 0.61, 0.78, 0.82],
    [0.785, 0.83, 1.02, 1.03]
  ];
  var SC = [[0.02, 0.30], [0.37, 0.58], [0.60, 0.80], [0.83, 1.00]];

  function setCT(v, i, lp) {
    var t = clamp(lp, 0, 1) * (dur[i] - 0.06);
    if (isFinite(t) && Math.abs(v.currentTime - t) > 0.033) {
      try { v.currentTime = t; } catch (e) {}
    }
  }

  // Priming: en el primer gesto, play+pause para habilitar seek en móvil.
  var primed = false;
  function prime() {
    if (primed) return; primed = true;
    clips.forEach(function (v) {
      var pr = v.play();
      if (pr && pr.then) pr.then(function () { v.pause(); }).catch(function () {});
      else { try { v.pause(); } catch (e) {} }
    });
  }
  window.addEventListener('scroll', prime, { once: true, passive: true });
  window.addEventListener('pointerdown', prime, { once: true, passive: true });
  window.addEventListener('touchstart', prime, { once: true, passive: true });

  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }

  function apply() {
    ticking = false;
    var r = sec.getBoundingClientRect();
    var h = sec.offsetHeight - window.innerHeight;
    var p = h <= 0 ? 0 : clamp(-r.top / h, 0, 1);

    if (prog) prog.style.width = (p * 100) + '%';

    // Copy: se va en el primer ~14% del recorrido
    if (copy) {
      var cf = 1 - smooth(p / 0.14);
      copy.style.opacity = cf;
      copy.style.transform = 'translateY(' + ((1 - cf) * -26).toFixed(1) + 'px)';
      copy.style.pointerEvents = cf < 0.08 ? 'none' : '';
    }

    // Clips: opacidad + scrub (solo se hace seek al visible)
    var top = 0;
    for (var i = 0; i < 4; i++) {
      var o = op(p, OP[i][0], OP[i][1], OP[i][2], OP[i][3]);
      clips[i].style.opacity = o;
      if (o > 0.02) { setCT(clips[i], i, local(p, SC[i][0], SC[i][1])); if (o >= 0.5) top = i; }
    }
    // Puente negro entre clip0 (termina en negro) y clip1 (arranca desde negro)
    if (black) black.style.opacity = op(p, 0.275, 0.315, 0.355, 0.40);

    if (idx) idx.textContent = ('0' + (top + 1)) + ' / 04';
    if (cue) cue.style.opacity = smooth((p - 0.9) / 0.07).toFixed(2);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', apply);
  apply();
})();
