/* ============================================================
   CTD · Sección de marcas — video carretera en loop + reveal por scroll
   - El video se reproduce solo, en bucle (NO ligado al scroll).
   - El scroll fija la sección (sticky) y revela en secuencia:
       0) Titular   1) La Finca   2) Delicias Yeya
     Cada bloque entra, se sostiene y sale antes de que entre el siguiente.
   - Fuente móvil ligera, lazy-load, prefers-reduced-motion respetado.
   ============================================================ */
(function () {
  var sec = document.querySelector('.brands');
  if (!sec) return;
  // reduced-motion: no pin, no autoplay → CSS deja los bloques apilados y el póster fijo
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  var vid    = sec.querySelector('.brands-bg');
  var blocks = [].slice.call(sec.querySelectorAll('.brands-block'));
  var prog   = sec.querySelector('.brands-prog');
  if (blocks.length < 3) return;

  var clamp  = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // ---- Video de fondo: elegir fuente (móvil ligera) y reproducir en loop ----
  var started = false;
  function startVideo() {
    if (started || !vid) return; started = true;
    var mobile = window.matchMedia('(max-width:768px)').matches;
    var src = vid.getAttribute(mobile ? 'data-src-mobile' : 'data-src');
    if (src) {
      vid.src = src;
      vid.load();
      var go = function () {
        var pr = vid.play();
        if (pr && pr.catch) pr.catch(function () {
          // si el navegador bloquea el autoplay, arranca en el primer gesto
          var once = function () { vid.play().catch(function () {}); window.removeEventListener('pointerdown', once); window.removeEventListener('touchstart', once); };
          window.addEventListener('pointerdown', once, { passive: true });
          window.addEventListener('touchstart', once, { passive: true });
        });
      };
      vid.addEventListener('loadeddata', go, { once: true });
    }
  }
  // Cargar/arrancar cuando la sección se acerca (no pesa en el arranque del sitio)
  if ('IntersectionObserver' in window && vid) {
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { startVideo(); io.disconnect(); } });
    }, { rootMargin: '80% 0px' });
    io.observe(sec);
  } else {
    startVideo();
  }

  sec.classList.add('is-ready');

  // ---- Coreografía de los 3 bloques (ventanas sobre el progreso 0..1) ----
  // enterA→enterB: entra (opacidad 0→1, sube desde +22px)
  // outA→outB: sale (opacidad 1→0, sigue subiendo a -22px)
  // Huecos entre ventanas = "sale antes de que entre el siguiente".
  var W = [
    [0.04, 0.13, 0.25, 0.33],  // 0 · Titular
    [0.40, 0.49, 0.60, 0.68],  // 1 · La Finca
    [0.73, 0.82, 0.94, 1.00]   // 2 · Delicias Yeya (se sostiene hasta soltar el pin)
  ];

  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }

  function apply() {
    ticking = false;
    var r = sec.getBoundingClientRect();
    var h = sec.offsetHeight - window.innerHeight;
    var p = h <= 0 ? 0 : clamp(-r.top / h, 0, 1);
    if (prog) prog.style.width = (p * 100) + '%';

    for (var i = 0; i < blocks.length; i++) {
      var w = W[i];
      var ein = smooth((p - w[0]) / (w[1] - w[0]));   // 0..1 entrada
      var eout = smooth((p - w[2]) / (w[3] - w[2]));  // 0..1 salida
      var opa = clamp(Math.min(ein, 1 - eout), 0, 1);
      var ty = (1 - ein) * 22 - eout * 22;            // +22 → 0 → -22 (desplazamiento corto)
      blocks[i].style.opacity = opa.toFixed(3);
      blocks[i].style.transform = 'translate(-50%,-50%) translateY(' + ty.toFixed(1) + 'px)';
      blocks[i].style.pointerEvents = opa < 0.08 ? 'none' : '';
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', apply);
  apply();
})();
