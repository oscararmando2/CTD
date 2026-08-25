/* ============================================================
   CTD · Hero cinemático — una sola película (vanilla)
   Secuencia: camión → oscuro → carga → caja → bodega → logo →
   carretera, y CIERRE con las marcas sobre la carretera en loop.
   Todo en el mismo pin; el HUD sigue contando hasta 07 / 07.
   Carga progresiva: solo el clip 2 precarga; 4→5→6→7→8 y la
   carretera se descargan en cadena mientras se ve el anterior.
   ============================================================ */
(function () {
  var sec = document.getElementById('inicio');
  if (!sec || !sec.classList.contains('cine')) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  var clips = [].slice.call(sec.querySelectorAll('.cine-clip'));
  if (clips.length < 4) return;
  var black  = sec.querySelector('.cine-black');
  var copy   = sec.querySelector('.cine-copy');
  var prog   = sec.querySelector('.cine-prog');
  var cue    = sec.querySelector('.cine-cue');
  var idx    = sec.querySelector('.cine-hud-idx');
  var road   = sec.querySelector('.cine-road');
  var mscrim = sec.querySelector('.cine-marca-scrim');
  var marcas = [].slice.call(sec.querySelectorAll('.cine-marca'));

  var dur   = clips.map(function () { return 6; });
  var ready = clips.map(function () { return false; });

  clips.forEach(function (v, i) {
    var meta = function () { if (v.duration) dur[i] = v.duration; };
    var mark = function () { meta(); if (v.readyState >= 3) ready[i] = true; };
    v.addEventListener('loadedmetadata', meta);
    v.addEventListener('loadeddata', meta);
    v.addEventListener('canplay', mark);
    v.addEventListener('canplaythrough', function () { meta(); ready[i] = true; });
    if (v.readyState >= 3) ready[i] = true;
  });

  // Solo el clip 0 (video 2) precarga de inmediato (preload=auto).
  try { clips[0].load(); } catch (e) {}

  // Cadena de carga en segundo plano: clips 1..5 y, al final, la carretera.
  function chain(i) {
    if (i >= clips.length) { loadRoad(); return; }   // tras el último clip, precarga la carretera
    var v = clips[i];
    v.preload = 'auto';
    var advanced = false;
    var next = function () { if (advanced) return; advanced = true; chain(i + 1); };
    v.addEventListener('canplaythrough', next, { once: true });
    v.addEventListener('canplay', next, { once: true });
    v.addEventListener('loadeddata', next, { once: true });
    try { v.load(); } catch (e) {}
    setTimeout(next, 6000);
  }
  var chainStarted = false;
  function kickChain() { if (chainStarted) return; chainStarted = true; chain(1); }
  if (clips[0].readyState >= 2) kickChain();
  else clips[0].addEventListener('loadeddata', kickChain, { once: true });
  window.addEventListener('load', function () { setTimeout(kickChain, 800); });
  if ('requestIdleCallback' in window) requestIdleCallback(kickChain, { timeout: 2500 });

  // ---- Carretera en loop (fondo del cierre; corre sola, no ligada al scroll) ----
  var roadLoaded = false, roadPlaying = false;
  function loadRoad() {
    if (roadLoaded || !road) return; roadLoaded = true;
    var mobile = window.matchMedia('(max-width:768px)').matches;
    var src = road.getAttribute(mobile ? 'data-src-mobile' : 'data-src');
    if (src) { road.src = src; try { road.load(); } catch (e) {} }
  }
  function playRoad() {
    if (roadPlaying || !road) return; roadPlaying = true;
    var pr = road.play();
    if (pr && pr.catch) pr.catch(function () {
      var once = function () { road.play().catch(function () {}); window.removeEventListener('pointerdown', once); window.removeEventListener('touchstart', once); };
      window.addEventListener('pointerdown', once, { passive: true });
      window.addEventListener('touchstart', once, { passive: true });
    });
  }

  sec.classList.add('is-ready');

  var clamp  = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var smooth = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  function op(p, ia, ib, oa, ob) {
    return clamp(Math.min(smooth((p - ia) / (ib - ia)), 1 - smooth((p - oa) / (ob - oa))), 0, 1);
  }
  function local(p, a, b) { return clamp((p - a) / (b - a), 0, 1); }

  // La fase de clips ocupa la primera fracción del pin; el cierre de marcas, el resto.
  var CS = 0.684;                 // 780vh de clips / 1140vh totales
  var RIN0 = 0.685, RIN1 = 0.745; // fundido de la carretera sobre el clip 8

  // Reveal monotónico de los clips (en progreso de clips pc = p/CS)
  var IN = [[0.00, 0.03], [0.22, 0.27], [0.38, 0.42], [0.54, 0.58], [0.70, 0.74], [0.86, 0.90]];
  var SC = [[0.02, 0.18], [0.24, 0.38], [0.40, 0.54], [0.56, 0.70], [0.72, 0.86], [0.88, 1.00]];

  // Ventanas de las 3 marcas (en progreso global p): entra/sostiene/sale, con huecos
  var MW = [
    [0.705, 0.740, 0.770, 0.800],  // 07 · Titular
    [0.825, 0.860, 0.890, 0.915],  // La Finca
    [0.940, 0.970, 1.020, 1.030]   // Delicias Yeya (se sostiene hasta soltar el pin)
  ];

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

    var pc = clamp(p / CS, 0, 1);   // progreso dentro de la fase de clips

    if (copy) {
      var cf = 1 - smooth(pc / 0.14);
      copy.style.opacity = cf;
      copy.style.transform = 'translateY(' + ((1 - cf) * -26).toFixed(1) + 'px)';
      copy.style.pointerEvents = cf < 0.08 ? 'none' : '';
    }

    // Clips: reveal monotónico (el de encima aparece sobre el anterior, que queda a 1)
    var topi = 0;
    for (var i = 0; i < clips.length; i++) {
      var rv = smooth((pc - IN[i][0]) / (IN[i][1] - IN[i][0]));
      if (i > 0 && !ready[i]) rv = 0;
      clips[i].style.opacity = rv;
      if (rv > 0.02) topi = i;
    }
    if (ready[topi]) setCT(clips[topi], topi, local(pc, SC[topi][0], SC[topi][1]));

    // Negro de empalme 2→4
    var bl = op(pc, 0.165, 0.195, 0.235, 0.295);
    if (!ready[1] && pc > 0.18 && pc < 0.34) bl = 1;
    if (black) black.style.opacity = bl;

    // ---- Cierre de marcas ----
    // Carretera en loop: se carga al acercarse y se funde sobre el clip 8.
    if (p > CS - 0.18) loadRoad();
    var roadOp = smooth((p - RIN0) / (RIN1 - RIN0));
    if (road) road.style.opacity = roadOp;
    if (mscrim) mscrim.style.opacity = roadOp;
    if (roadOp > 0.2) playRoad();

    // Bloques de marca: entran, se sostienen y salen (misma curva; desplazamiento corto)
    for (var m = 0; m < marcas.length; m++) {
      var w = MW[m];
      var ein = smooth((p - w[0]) / (w[1] - w[0]));
      var eout = smooth((p - w[2]) / (w[3] - w[2]));
      var opa = clamp(Math.min(ein, 1 - eout), 0, 1);
      var ty = (1 - ein) * 22 - eout * 22;
      marcas[m].style.opacity = opa.toFixed(3);
      marcas[m].style.transform = 'translate(-50%,-50%) translateY(' + ty.toFixed(1) + 'px)';
    }

    // HUD: clips 0X / 07, cierre de marcas 07 / 07
    if (idx) idx.textContent = (p >= CS ? '07' : ('0' + (topi + 1))) + ' / 07';

    // Cue al final (invita a soltar el pin)
    if (cue) cue.style.opacity = smooth((p - 0.965) / 0.03).toFixed(2);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', apply);
  apply();
})();
