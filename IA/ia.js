/* CTD · IA de Especiales
 * - Acceso: Oscar o Luis con su propia contraseña (Firebase Auth usuario/contraseña, plan
 *   gratis). La primera vez cada quien crea la suya; la sesión queda abierta en el dispositivo.
 * - Datos: hay que conectar InSitu (o arrastrar el Excel) en cada dispositivo.
 * - InSitu Sales API (CORS abierto): productos, facturas con detalle (ventas) e inventario.
 *   Solo se guarda el token en este dispositivo; la contraseña nunca se guarda.
 * - Historial de propuestas compartido en Realtime Database (proyecto ctd-ia, nodo `propuestas`).
 */
(function () {
  'use strict';

  /* ================= CONFIG ================= */
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBhJuY0Wdh_UeZL0KHNn5WofWYPhQiVTuU',
    authDomain: 'ctd-ia.firebaseapp.com',
    projectId: 'ctd-ia',
    databaseURL: 'https://ctd-ia-default-rtdb.firebaseio.com',
    storageBucket: 'ctd-ia.firebasestorage.app',
    messagingSenderId: '914488691883',
    appId: '1:914488691883:web:57d809a1e899c6b0be3bee',
  };
  const INSITU = 'https://app.b2bmobilesales.com/api/v1';
  const PEOPLE = ['Oscar', 'Luis', 'Diego', 'Jonathan', 'Rocio'];
  // Usuarios con una sola sección: Jonathan (bodega) → Recibo; Rocío → Costeo
  const ONLY = { Jonathan: ['rec', 'fech', 'inv', 'ord'], Rocio: ['cos', 'cred', 'cat', 'fech', 'inv'] };
  // Secciones que un usuario solo puede ver, sin cambiar nada (Rocío ve las fechas pero no las mueve)
  const READ_ONLY = { Rocio: ['fech'] };
  const soloVer = (v) => (READ_ONLY[S.who] || []).includes(v);
  const LABEL = { Rocio: 'Rocío' }; // cómo se ve el nombre (el correo interno va sin acento)
  const label = (n) => LABEL[n] || n;
  // Firebase Auth pide un correo: cada nombre usa uno interno (no recibe mensajes)
  const emailOf = (name) => name.toLowerCase() + '@ctd-ia.firebaseapp.com';
  const nameOf = (email) => PEOPLE.find((p) => emailOf(p) === String(email || '').toLowerCase()) || null;

  const EXCLUDE_CATS = ['Spoilage', 'Shipping', 'TEST'];
  const MODES = { equilibrado: [6, 12], agresivo: [12, 22], cuidar: [3, 7] };
  const STALE_MS = 3 * 36e5; // si los datos tienen más de 3 h, se actualizan solos al abrir
  const K_SALES = 'ctdIA.sales';
  const K_VIEW = 'ctdIA.view', K_ORD = 'ctdIA.orderDraft', K_ORDSET = 'ctdIA.orderSettings';
  const WHATSAPP_LUIS = '13146095131'; // las órdenes siempre se mandan a Luis
  // Revisión con Claude: función en el Vercel del catálogo (ahí vive ANTHROPIC_API_KEY)
  const REVIEW_URL = 'https://catalogo-mexiquense.vercel.app/api/orden';
  const K_DATA = 'ctdIA.data', K_SET = 'ctdIA.settings', K_HIST = 'ctdIA.hist', K_TOKEN = 'ctdIA.insitu', K_WHO = 'ctdIA.who';

  // Motivos (insights) que salen de las ventas reales
  const WHY = {
    dormido: { icon: 'moon', label: 'Sin venta', w: 3.2, dBoost: [1.35, 1.8] },
    lento: { icon: 'hourglass', label: 'Rotación lenta', w: 2.6, dBoost: [1.15, 1.5] },
    bajando: { icon: 'down', label: 'Ventas a la baja', w: 2.2, dBoost: [1.0, 1.3] },
    gancho: { icon: 'flame', label: 'Más vendido', w: 1.6, dBoost: [0.45, 0.8] },
    normal: { icon: 'shuffle', label: 'Al azar', w: 0.5, dBoost: [1, 1] },
    caduca: { icon: 'alert', label: 'Por caducar', w: 4, dBoost: [1.4, 1.9] }, // fechas de Recibo/Fechas: no alcanza a venderse
  };
  const STRATS = {
    mixto: ['caduca', 'dormido', 'lento', 'bajando', 'gancho', 'normal'],
    mover: ['caduca', 'dormido', 'lento'],
    bajando: ['bajando'],
    gancho: ['gancho'],
    azar: null,
  };

  /* ================= HELPERS ================= */
  // Productos de crédito: el nombre empieza con "CR-". No salen en especiales, sugerencias ni catálogo.
  const isCredito = (p) => /^\s*CR\s*-/i.test((p && p.name) || '');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  // Iconos de línea (estilo Lucide), sin emojis
  const ICONS = {
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    hourglass: '<path d="M5 22h14M5 2h14"/><path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22"/><path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
    down: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
    pin: '<path d="M12 17v5"/><path d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    qb: '<circle cx="12" cy="12" r="10"/><path d="M9 8v8M9 8h2.5a2.5 2.5 0 0 1 0 5H9M15 16V8M15 16h-2.5a2.5 2.5 0 0 1 0-5H15"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };
  const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const fillIcons = (root = document) => $$('i[data-icon]', root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); el.removeAttribute('data-icon'); });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const r2 = (n) => Math.round(n * 100) / 100;
  const rand = (a, b) => a + Math.random() * (b - a);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const nfmt = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US');
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const DAY = 864e5;
  // SKU tal cual está en InSitu: "CTD-1261" y "1261" son productos DISTINTOS (no se mezclan)
  const ctdDe = (...vals) => {
    for (const v of vals) {
      const s = String(v || '').trim();
      const c = s.match(/^CTD\s*-?\s*(\d{1,6})$/i); if (c) return 'CTD-' + c[1];
      if (/^\d{2,6}$/.test(s)) return s;
    }
    return '';
  };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseYmd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmtD = (s) => { if (!s) return '—'; const d = parseYmd(s); return `${d.getDate()} ${MES[d.getMonth()]}`; };
  const fmtTs = (ts) => { const d = new Date(ts); return `${d.getDate()} ${MES[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function nextWeek() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const add = ((8 - t.getDay()) % 7) || 7; // próximo lunes
    const mon = new Date(t); mon.setDate(t.getDate() + add);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return [ymd(mon), ymd(sun)];
  }
  const cajas = (n) => `${nfmt(n)} ${Math.abs(n - 1) < 1e-9 ? 'caja' : 'cajas'}`;
  function hace(days) {
    if (days < 45) return `${days} días`;
    const m = Math.round(days / 30);
    return m >= 12 ? 'más de un año' : `${m} meses`;
  }

  // Precios "psicológicos": terminan en .99 / .49 (o .x9 abajo de $10)
  function psychDown(x) {
    if (x >= 10) { const f = Math.floor(x); return Math.max(...[f - 0.01, f + 0.49, f + 0.99].filter((v) => v <= x + 1e-9)); }
    return Math.max(0.09, Math.floor(x * 10 + 1e-9) / 10 - 0.01);
  }
  function psychUp(x) {
    if (x >= 10) { const f = Math.floor(x); return [f - 0.01, f + 0.49, f + 0.99, f + 1.49].find((v) => v >= x - 1e-9); }
    let v = Math.ceil(x * 10 - 1e-9) / 10 - 0.01;
    if (v < x - 1e-9) v += 0.1;
    return r2(v);
  }

  /* ================= ESTADO ================= */
  const [defFrom, defTo] = nextWeek();
  const S = {
    who: '',
    products: [],
    meta: null,
    cards: [],
    hist: [],
    set: Object.assign(
      { count: 8, mode: 'equilibrado', strat: 'mixto', dMin: 6, dMax: 12, floor: 5, vendor: '', brand: '', combo: true, cats: null },
      store.get(K_SET, {}),
      { from: defFrom, to: defTo }
    ),
  };
  const saveSettings = () => { const { from, to, ...rest } = S.set; store.set(K_SET, rest); };
  const hasSales = () => !!(S.meta && S.meta.sales);

  /* ================= ACCESO ================= */
  let auth = null, db = null, unHist = null;
  const G = { name: store.get(K_WHO, ''), create: false };
  const gateMsg = (t, kind) => { const m = $('#gateMsg'); m.textContent = t || ''; m.className = 'gate-msg' + (kind ? ' ' + kind : ''); };
  const AUTH_ERR = {
    'auth/wrong-password': 'Contraseña incorrecta.',
    'auth/invalid-credential': 'Contraseña incorrecta (o todavía no la creas).',
    'auth/invalid-login-credentials': 'Contraseña incorrecta (o todavía no la creas).',
    'auth/user-not-found': 'Todavía no creas tu contraseña.',
    'auth/email-already-in-use': 'Ya hay contraseña para este nombre. Entra con ella.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/operation-not-allowed': 'Falta activar "Correo/contraseña" en Firebase Authentication.',
    'auth/admin-restricted-operation': 'Ya no se pueden crear cuentas nuevas.',
    'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
  };
  const errText = (e) => AUTH_ERR[e && e.code] || 'No se pudo. ' + ((e && e.message) || '');

  function renderGate() {
    $('#whoPick').innerHTML = PEOPLE.map((p) => `<button type="button" data-v="${p}" class="${G.name === p ? 'on' : ''}">${label(p)}<small>${G.name === p ? (G.create ? 'crear contraseña' : 'entrar') : '&nbsp;'}</small></button>`).join('');
    $('#passForm').hidden = !G.name;
    $('#pass2Input').hidden = !G.create;
    $('#pass2Input').required = G.create;
    $('#passInput').autocomplete = G.create ? 'new-password' : 'current-password';
    $('#passInput').placeholder = G.create ? 'Crea tu contraseña (mín. 6)' : 'Tu contraseña';
    $('#passLbl').textContent = G.create ? `Crear contraseña de ${label(G.name)}` : `Contraseña de ${label(G.name)}`;
    $('#passBtn').textContent = G.create ? 'Crear y entrar' : 'Entrar';
    $('#modeBtn').textContent = G.create ? 'Ya tengo contraseña' : '¿Primera vez? Crear contraseña';
  }
  // ¿Este nombre ya creó su contraseña? (doc público usuarios/{nombre})
  async function knownUser(name) {
    try {
      const d = await Promise.race([db.ref('usuarios/' + name).get(), new Promise((_, r) => setTimeout(() => r(new Error('t')), 4000))]);
      return d.exists();
    } catch (e) { return null; }
  }
  $('#whoPick').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    G.name = b.dataset.v; store.set(K_WHO, G.name);
    gateMsg('');
    const k = await knownUser(G.name);
    G.create = k === false;
    renderGate();
    $('#passInput').value = ''; $('#pass2Input').value = '';
    $('#passInput').focus();
  });
  $('#modeBtn').addEventListener('click', () => { G.create = !G.create; gateMsg(''); renderGate(); });
  $('#passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#passInput').value;
    if (G.create && pw !== $('#pass2Input').value) { gateMsg('Las contraseñas no coinciden.', 'err'); return; }
    const btn = $('#passBtn');
    btn.disabled = true;
    gateMsg(G.create ? 'Creando…' : 'Entrando…');
    try {
      if (G.create) {
        await auth.createUserWithEmailAndPassword(emailOf(G.name), pw);
        try { await db.ref('usuarios/' + G.name).set({ creada: Date.now() }); } catch (err) { console.warn(err); }
      } else {
        await auth.signInWithEmailAndPassword(emailOf(G.name), pw);
      }
      $('#passInput').value = ''; $('#pass2Input').value = '';
      gateMsg('');
    } catch (err) {
      gateMsg(errText(err), 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    if (unHist) { unHist(); unHist = null; }
    if (unOrd) { unOrd(); unOrd = null; }
    if (auth) await auth.signOut();
    // Página limpia para el siguiente usuario (no quedan datos en memoria del anterior, ej. el catálogo sin ventas de Rocío)
    setTimeout(() => location.reload(), 50);
  });

  function showGate() {
    $('#dock').hidden = true;
    $('#cosDock').hidden = true;
    $('#ordDock').hidden = true;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    renderGate();
    if (G.name) knownUser(G.name).then((k) => { if (k === false) { G.create = true; renderGate(); } });
  }
  function enterApp(name) {
    S.who = name;
    $('#whoami').innerHTML = 'Hola, <b>' + esc(label(name)) + '</b>';
    $('#gate').hidden = true;
    $('#app').hidden = false;
    // Usuarios de una sola sección (Jonathan → Recibo, Rocío → Costeo): sin conectar InSitu
    const only = onlyView();
    $$('#viewTabs button').forEach((b) => { b.hidden = !!only && !only.includes(b.dataset.v); });
    $('#histBtn').hidden = !!only;
    if (only) {
      if (!only.includes(S.view)) S.view = only[0];
      $('#dropzone').hidden = true;
      $('#workspace').hidden = false;
      if (only.includes('cos') && !S.products.length) {
        // Productos (sin InSitu): copia del catálogo que se guarda al sincronizar; el costo viene de QuickBooks
        cosCall('catalogo').then((d) => {
          S.catAt = d.at || null;
          S.products = (d.items || []).map((x) => ({ id: String(x.id), name: x.name, upc: x.upc || '', ean: x.ean || '', photo: x.photo || '', price: x.price || 0, cost: 0, pack: x.pack || '', cat: x.cat || '', brand: x.brand || '', stock: x.stock ?? null, fromCat: true }));
          if (S.view === 'cat') renderCatalogo();
        }).catch(() => {});
      }
      if (only.includes('ord') && !S.products.length) {
        // Órdenes sin InSitu: la copia con ventas, existencia y proveedores que sube Oscar/Luis/Diego al sincronizar
        cosCall('ordenes_data').then((d) => {
          S.products = (d.items || []).map((x) => ({ ...x, id: String(x.id), fromCat: true }));
          S.ordAt = d.at || null;
          if (S.view === 'ord') applyView();
          if (S.view === 'inv') renderInventario(false);
        }).catch((e) => toast('Órdenes: ' + e.message));
        listenOrders();
      }
      applyView();
      return;
    }
    listenHist();
    listenOrders();
    // Si quedó en memoria el catálogo de un usuario de una sola sección (sin ventas ni proveedores), se carga el completo
    if (S.products.some((p) => p.fromCat)) { S.products = []; S.sales = null; S.meta = null; }
    if (S.products.length) return;
    const data = store.get(K_DATA, null);
    if (data && Array.isArray(data.items) && data.items.length) {
      S.products = applyVendors(data.items);
      S.sales = store.get(K_SALES, null);
      S.meta = data.meta;
      showWorkspace();
      autoSync();
    } else {
      showConnect();
    }
  }

  // Actualización automática (todo: productos, 12 meses de ventas e inventario)
  let syncing = false;
  function autoSync() {
    if (syncing || !Insitu.token() || !S.meta || S.meta.source !== 'InSitu') return;
    if (Date.now() - (S.meta.at || 0) < STALE_MS) return;
    syncInsitu({ silent: true }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.who) autoSync(); });
  setInterval(() => { if (!syncing) renderAge(); }, 60000);

  /* ---- Proveedores directos: lo que está en el catálogo de CORDIALSA se pide a CORDIALSA USA
   * (antes se compraba por Cortes, Kalil, Castillo o El Mexiquense). Por UPC del catálogo o por marca. ---- */
  const DIRECT = { name: 'CORDIALSA USA', ups: null, noChk: null };
  const CORDIALSA_BRANDS = /(^|\s)(pz|pozuelo|chiky|festival|ducales|saltin|colcafe|sello rojo|copelia|nucita|granuts|cremino|chocolisto|doria|crem helado|chata|mexico lindo|club extra|canasta|yupi|zuko|amor salsa|bon frozen|yipy)\b|^(dux|ldm|tosh|jet|jumbo|rica)\b|^corona\b.*\b(choc|cocoa|chocolate)/;
  const upcCoreD = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
  function isCordialsa(p) {
    if (DIRECT.ups) {
      const x = upcCoreD(p.upc);
      if (x.length >= 10 && (DIRECT.ups.has(x) || DIRECT.ups.has(x.slice(0, -1)) || DIRECT.noChk.has(x) || DIRECT.noChk.has(x.slice(0, -1)))) return true;
    }
    return CORDIALSA_BRANDS.test(normTxt(p.name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim());
  }
  function applyVendors(items) {
    (items || []).forEach((p) => {
      if (!isCordialsa(p)) return;
      if (p.buy && p.buy.vendor !== DIRECT.name) p.buy.antes = p.buy.antes || p.buy.vendor;
      p.vendor = DIRECT.name;
      if (p.buy) p.buy.vendor = DIRECT.name;
    });
    return items;
  }
  fetch('cordialsa.json').then((r) => r.json()).then((d) => {
    DIRECT.ups = new Set(d.upcs); DIRECT.noChk = new Set(d.upcs.map((u) => u.slice(0, -1)));
    if (S.products.length) { applyVendors(S.products); if (S.view === 'ord' && !$('#workspace').hidden) { if (!O.lines.length && !O.touched) suggestOrder(); else renderOrders(); } }
  }).catch(() => {});

  /* ================= INSITU ================= */
  const Insitu = {
    token: () => (store.get(K_TOKEN, null) || {}).token || '',
    async login(email, password) {
      const r = await fetch(INSITU + '/users/company/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      const token = String(j.token || (j.data && j.data.token) || (j.user && j.user.token) || '').replace(/^Bearer\s+/i, '');
      if (!r.ok || !token || j.success === false) throw new Error(j.message || j.error || 'Correo o contraseña incorrectos');
      store.set(K_TOKEN, { token, email, at: Date.now(), scheme: 'Bearer ' });
      return token;
    },
    async get(path, params, retried) {
      const saved = store.get(K_TOKEN, null) || {};
      const q = new URLSearchParams(params || {}).toString();
      const r = await fetch(`${INSITU}${path}${q ? '?' + q : ''}`, { headers: { Authorization: (saved.scheme ?? 'Bearer ') + this.token() } });
      if (r.status === 401 || r.status === 403) {
        const body = (await r.text().catch(() => '')).slice(0, 160);
        console.warn('InSitu', r.status, path, body);
        // Algunos servidores esperan el token sin "Bearer ": se prueba una vez
        if (!retried && r.status === 401) {
          store.set(K_TOKEN, { ...saved, scheme: saved.scheme === '' ? 'Bearer ' : '' });
          return this.get(path, params, true);
        }
        store.set(K_TOKEN, { ...saved, scheme: 'Bearer ' });
        const e = new Error(r.status === 403
          ? `InSitu no le da permiso de API a este usuario (403 en ${path}). ${body}`
          : `InSitu rechazó la sesión (401 en ${path}). ${body}`);
        e.auth = true;
        throw e;
      }
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 4000)); return this.get(path, params, retried); }
      if (!r.ok) throw new Error(`InSitu respondió ${r.status} en ${path}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
      return r.json();
    },
    // Recorre todas las páginas; `key` = arreglo en la respuesta (products / invoices / warehouse_stocks)
    async all(path, key, params, onPage) {
      const LIM = 500;
      const out = [];
      for (let off = 0; ; off += LIM) {
        const j = await this.get(path, { ...params, limit: LIM, offset: off });
        const arr = j[key] || j.data || [];
        out.push(...arr);
        if (onPage) onPage(out.length, j.total_count || j.count);
        if (arr.length < LIM) break;
      }
      return out;
    },
  };

  const connectMsg = (t, err) => { const m = $('#connectMsg'); m.textContent = t || ''; m.classList.toggle('err', !!err); };

  $('#connectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#connectBtn');
    btn.disabled = true;
    connectMsg('Conectando con InSitu…');
    try {
      await Insitu.login($('#insEmail').value.trim(), $('#insPass').value);
      $('#insPass').value = '';
      await syncInsitu();
    } catch (err) {
      connectMsg(err.message || 'No se pudo conectar', true);
    } finally {
      btn.disabled = false;
    }
  });

  async function syncInsitu(opts) {
    const silent = !!(opts && opts.silent);
    if (syncing) return;
    syncing = true;
    const setSync = (t) => { const el = $('#syncInfo'); if (el) { el.textContent = t; el.classList.toggle('busy', !!t); } };
    const say = (t) => { if (!silent) connectMsg(t); setSync(t ? '⟳ ' + t : ''); };
    try {
      say('Bajando productos…');
      const prods = await Insitu.all('/products', 'products', {}, (n) => say(`Bajando productos… ${n}`));

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const from = new Date(today); from.setFullYear(from.getFullYear() - 1);
      say('Bajando ventas de 12 meses…');
      const invs = await Insitu.all('/invoices', 'invoices', {
        fromDate: ymd(from) + ' 00:00:00', toDate: ymd(today) + ' 23:59:59', order: JSON.stringify([['id', 'ASC']]),
      }, (n, t) => say(`Bajando ventas de 12 meses… ${n}${t ? ' de ' + t : ''} facturas`));

      say('Bajando inventario…');
      let stocks = null;
      try { stocks = await Insitu.all('/inventory_stock', 'warehouse_stocks', {}); }
      catch (e) { if (e.auth) throw e; stocks = null; } // sin inventario, seguimos con ventas

      say('Bajando compras (recepciones)…');
      let recs = null;
      try { recs = await Insitu.all('/item_receipt', 'item_receipt', {}, (n) => say(`Bajando compras… ${n} recepciones`)); }
      catch (e) { if (e.auth) throw e; recs = null; } // sin compras, las órdenes usan valores por defecto

      const { items, withDetail } = buildDataset(prods, invs, stocks, today, recs);
      S.sales = computeSales(invs, today, items);
      store.set(K_SALES, S.sales);
      if (!items.length) throw new Error('InSitu no regresó productos con precio y costo.');
      S.products = applyVendors(items);
      S.meta = {
        source: 'InSitu', at: Date.now(), sales: withDetail > 0, stock: !!stocks,
        invoices: invs.length, from: ymd(from), receipts: recs ? recs.length : 0,
      };
      if (!store.set(K_DATA, { meta: S.meta, items })) toast('Aviso: no se pudo guardar en este dispositivo.');
      syncing = false;
      if (silent && !$('#workspace').hidden) {
        stockTrusted = null;
        if (S.view === 'ord') { if (!O.touched) suggestOrder(); else renderOrders(); }
        refreshCards();
        buildFilters();
        renderDataInfo();
        render();
        toast('Datos actualizados de InSitu');
      } else {
        S.set.cats = null;
        connectMsg('');
        showWorkspace();
        if (!withDetail && invs.length) toast('Las facturas llegaron sin detalle de productos: no hay datos de venta.');
        else toast(`${items.length} productos · ${invs.length} facturas analizadas`);
      }
    } catch (err) {
      syncing = false;
      if (err.auth) { store.del(K_TOKEN); showConnect(); }
      console.warn(err);
      connectMsg(err.message || 'Falló la descarga', true);
      setSync('');
      if (!$('#workspace').hidden) { renderAge(); toast(err.message || 'Falló la descarga'); }
      throw err;
    }
  }

  // Las tarjetas en pantalla guardan una foto del producto: al actualizar, se les ponen
  // las ventas/stock nuevos (los precios de la propuesta no se tocan)
  function refreshCards() {
    const byId = {};
    S.products.forEach((p) => { byId[p.id] = p; });
    S.cards.forEach((c) => {
      c.items.forEach((it) => {
        const p = byId[it.id];
        if (p) Object.assign(it, { why: p.why || 'normal', st: p.st || null, stock: p.stock ?? null, cover: p.cover ?? null, photo: p.photo || it.photo });
      });
      c.tag = tagFor(c);
    });
  }

  function buildDataset(prods, invs, stocks, today, recs) {
    // Ventas por código de producto
    const T = today.getTime();
    const sales = {};
    let withDetail = 0;
    for (const inv of invs) {
      if (inv.cancelled === true || inv.cancelled === 1 || /cancel|void|anulad/i.test(inv.status || '')) continue;
      const t = Date.parse(String(inv.invoice_date || inv.invoice_ship_date || '').replace(' ', 'T'));
      if (!isFinite(t)) continue;
      const age = Math.floor((T - t) / DAY);
      const lines = inv.invoiceDetailList || inv.invoice_details || [];
      if (lines.length) withDetail++;
      const client = inv.client_nit || inv.account_number || inv.client_branch_code || inv.client_branch_name || '';
      for (const l of lines) {
        const code = String(l.product_code ?? '').trim();
        const q = Number(l.quantity) || 0;
        if (!code || q <= 0) continue;
        const s = (sales[code] = sales[code] || { last: 0, u30: 0, u90: 0, uPrev90: 0, u365: 0, rev90: 0, clients: new Set(), m: new Array(12).fill(0), d: {} });
        if (t > s.last) s.last = t;
        if (age <= 200) { const dk = ymd(new Date(t)); s.d[dk] = r2((s.d[dk] || 0) + q); } // ventas por día (para medir especiales)
        s.u365 += q;
        if (age <= 30) s.u30 += q;
        if (age <= 90) { s.u90 += q; s.rev90 += Number(l.invoice_detail_net_value) || q * (Number(l.product_price) || 0); if (client) s.clients.add(client); }
        else if (age <= 180) s.uPrev90 += q;
        const mi = Math.min(11, Math.max(0, Math.floor(age / 30.44)));
        s.m[11 - mi] += q; // m[11] = últimos 30 días
      }
    }
    // Inventario por product_id
    const stockBy = {};
    (stocks || []).forEach((w) => { stockBy[w.product_id] = (stockBy[w.product_id] || 0) + (Number(w.stock) || 0); });

    const items = [];
    for (const p of prods) {
      if (p.hidden || p.disabled) continue;
      const code = String(p.code ?? '').trim();
      const name = String(p.name || '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const s = sales[code];
      items.push({
        id: code || String(p.id),
        pid: p.id,
        name,
        key: name.replace(/^CR-\s*/i, '').toLowerCase(),
        cat: String(p.line_name || p.group_name || 'Otros').trim(),
        brand: String(p.brand_name || '').trim(),
        upc: String(p.barcode || '').trim(),
        ean: String(p.ean || '').trim(), // muchos traen aquí el UPC real (ej. Refreshing: código 1168, EAN 810118991103)
        price: Number(p.default_price) || 0,
        cost: Number(p.default_cost) || 0,
        photo: String(p.photourl || '').trim(),
        pack: packLabel(p.units),
        units: String(p.units || '').trim(), // unidad tal cual en InSitu (Case12, Case24…)
        vendor: '',
        st: s ? {
          last: s.last ? ymd(new Date(s.last)) : null,
          days: s.last ? Math.floor((T - s.last) / DAY) : null,
          u30: r2(s.u30), u90: r2(s.u90), uPrev90: r2(s.uPrev90), u365: r2(s.u365), rev90: r2(s.rev90),
          clients: s.clients.size, m: s.m.map(r2), d: s.d,
        } : { last: null, days: null, u30: 0, u90: 0, uPrev90: 0, u365: 0, rev90: 0, clients: 0, m: new Array(12).fill(0), d: {} },
        stock: stocks ? r2(stockBy[p.id] || 0) : null,
      });
    }
    classify(items);
    if (recs) attachBuys(items, recs);
    return { items, withDetail };
  }

  // Compras (recepciones de InSitu) → proveedor, cada cuánto se compra, cantidad típica y último costo
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function attachBuys(items, recs) {
    const byCode = {}, vendorDates = {};
    for (const ir of recs) {
      if (ir.cancelled === true || ir.cancelled === 1) continue;
      const d = String(ir.trn_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const v = String(ir.vendor_name || '').trim() || 'Sin proveedor';
      for (const l of ir.lines || []) {
        const code = String(l.product_code ?? '').trim();
        const q = Number(l.quantity) || 0;
        if (!code || q <= 0) continue;
        (byCode[code] = byCode[code] || []).push({ d, q, v, c: Number(l.product_cost) || 0 });
        (vendorDates[v] = vendorDates[v] || new Set()).add(d);
      }
    }
    const gapsOf = (dates) => { const g = []; for (let i = 1; i < dates.length; i++) g.push(Math.round((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / DAY)); return g.filter((x) => x > 0); };
    const vendorCycle = {};
    Object.entries(vendorDates).forEach(([v, s]) => { vendorCycle[v] = median(gapsOf([...s].sort())); });
    for (const p of items) {
      const arr = byCode[p.id];
      if (!arr) continue;
      arr.sort((a, b) => a.d.localeCompare(b.d));
      const last = arr[arr.length - 1];
      const perDate = {};
      arr.forEach((x) => { perDate[x.d] = (perDate[x.d] || 0) + x.q; });
      const dates = Object.keys(perDate).sort();
      const own = median(gapsOf(dates));
      p.buy = {
        vendor: last.v, last: last.d, lastQty: r2(perDate[last.d]), lastCost: r2(last.c), n: dates.length,
        cycle: own || vendorCycle[last.v] || null, cycleOwn: !!own, typQty: r2(median(Object.values(perDate))),
      };
      if (!p.vendor) p.vendor = last.v;
    }
  }

  // Asigna a cada producto su motivo principal (why) + texto explicativo
  function classify(items) {
    if (!items.some((p) => p.st)) return;
    const sold = items.filter((p) => p.st && p.st.u90 > 0).map((p) => p.st.u90).sort((a, b) => b - a);
    const topCut = sold.length ? sold[Math.max(0, Math.floor(sold.length * 0.1) - 1)] : Infinity;
    for (const p of items) {
      const st = p.st;
      if (!st) { p.why = 'normal'; continue; }
      const hasStock = p.stock == null ? true : p.stock > 0;
      const weekly = st.u90 / 13;
      const cover = p.stock != null && weekly > 0 ? p.stock / weekly : null;
      if (hasStock && st.days != null && st.days >= 60) p.why = 'dormido';
      else if (hasStock && st.days == null && p.stock > 0) p.why = 'dormido';
      else if (cover != null && cover >= 12) p.why = 'lento';
      else if (st.uPrev90 >= 3 && st.u90 < st.uPrev90 * 0.6) p.why = 'bajando';
      else if (st.u90 > 0 && st.u90 >= topCut && (cover == null || cover >= 3)) p.why = 'gancho'; // sin stock no hay gancho
      else p.why = 'normal';
      p.cover = cover != null ? Math.round(cover) : null;
    }
  }

  // Frase de "por qué" + acción sugerida, con los números reales
  function reasonText(it, off) {
    const st = it.st;
    if (!st) return '';
    const d = Math.round(off * 100);
    const stk = it.stock != null ? ` y quedan ${cajas(it.stock)} en bodega` : '';
    switch (it.why) {
      case 'caduca': {
        const e = it.exp;
        return e ? `Vencen ~${cajas(e.quedan)} el ${fmtLong(e.d)} (en ${e.dias} días) y se venden ~${nfmt(e.rate)} por semana: sobran ~${cajas(e.sobran)}. Especial de -${d}% para sacarlo a tiempo.`
          : `Está por caducar. Especial de -${d}% para sacarlo a tiempo.`;
      }
      case 'dormido':
        return st.days == null
          ? `No se ha vendido en 12 meses${stk}. Especial de -${d}% para sacarlo antes de que se haga viejo.`
          : `Tiene ${hace(st.days)} sin venderse (última venta ${fmtD(st.last)})${stk}. Especial de -${d}% para moverlo.`;
      case 'lento':
        return `Se venden ${nfmt(st.u90 / 13)} cajas por semana y hay ${cajas(it.stock)}: inventario para ~${it.cover} semanas. Un -${d}% acelera la rotación.`;
      case 'bajando':
        return `Bajó ${Math.round((1 - st.u90 / st.uPrev90) * 100)}% vs los 3 meses anteriores (${cajas(st.uPrev90)} → ${cajas(st.u90)}). Un -${d}% para recuperarlo.`;
      case 'gancho':
        return `De tus más vendidos: ${cajas(st.u90)} en 90 días con ${st.clients} clientes. ${d <= 10 ? `Descuento chico (-${d}%)` : `Un -${d}%`} como gancho para jalar pedidos.`;
      default:
        return st.u90 > 0 ? `Vende ${cajas(st.u90)} en 90 días. Especial de -${d}% para darle movimiento.` : '';
    }
  }

  /* ================= EXCEL (respaldo sin InSitu) ================= */
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });

  async function loadFile(file) {
    connectMsg('Leyendo ' + file.name + '…');
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });
      const items = parseRows(rows);
      if (!items.length) throw new Error('No encontré productos con precio y costo. ¿Es el export de InSitu?');
      S.products = applyVendors(items);
      S.meta = { source: file.name, at: Date.now(), sales: false };
      if (!store.set(K_DATA, { meta: S.meta, items })) toast('Aviso: no se pudo guardar en este dispositivo.');
      S.set.cats = null;
      connectMsg('');
      showWorkspace();
      toast(items.length + ' productos cargados (sin datos de venta)');
    } catch (e) {
      connectMsg(e.message || 'No se pudo leer el archivo.', true);
    }
  }

  function packLabel(v) {
    const s = String(v ?? '').trim();
    const m = s.match(/^case\s*(\d+)$/i);
    if (m) return 'Caja ' + m[1];
    if (/count in each/i.test(s)) return 'Pieza';
    if (/^\d+$/.test(s)) return Number(s) > 1 ? 'Caja ' + s : 'Pieza';
    return s;
  }

  function parseRows(rows) {
    const hi = rows.findIndex((r) => r && r.includes('Name') && r.includes('Default_price'));
    if (hi < 0) return [];
    const H = rows[hi];
    const col = (n) => H.indexOf(n);
    const c = {
      code: col('Code'), name: col('Name'), cat: col('Category_Name'), brand: col('Brand_Name'),
      bc: col('Barcode'), bc2: col('Barcode2'), price: col('Default_price'), cost: col('Default_Cost'),
      photo: col('PhotoURL'), hidden: col('Hidden'), pack: col('Unit of Measurement'), vendor: col('Preferred_vendor'),
    };
    const g = (r, i) => (i >= 0 ? r[i] : null);
    const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
    const out = [];
    for (const r of rows.slice(hi + 1)) {
      if (!r || !g(r, c.name)) continue;
      if (Number(g(r, c.hidden)) === 1) continue;
      const bc2 = String(g(r, c.bc2) ?? '').trim();
      const bc = String(g(r, c.bc) ?? '').trim();
      const name = String(g(r, c.name)).replace(/\s+/g, ' ').trim();
      out.push({
        id: String(g(r, c.code) ?? uid()),
        name,
        key: name.replace(/^CR-\s*/i, '').toLowerCase(),
        cat: String(g(r, c.cat) || 'Otros').trim(),
        brand: String(g(r, c.brand) || '').trim(),
        upc: /^\d{8,}$/.test(bc2) ? bc2 : bc,
        price: num(g(r, c.price)),
        cost: num(g(r, c.cost)),
        photo: String(g(r, c.photo) || '').trim(),
        pack: packLabel(g(r, c.pack)),
        vendor: String(g(r, c.vendor) || '').trim(),
        why: 'normal',
      });
    }
    return out;
  }

  /* ================= PANTALLAS ================= */
  function showConnect() {
    $('#dock').hidden = true;
    $('#cosDock').hidden = true;
    $('#ordDock').hidden = true;
    $('#dropzone').hidden = false;
    $('#workspace').hidden = true;
  }

  function showWorkspace() {
    stockTrusted = null;
    if (!R.lotes) loadLotes().then(() => { if (S.cards.length) render(); });
    pushCatalog(); pushOrdenes();
    shareInsituSession();
    $('#dropzone').hidden = true;
    $('#workspace').hidden = false;
    buildFilters();
    syncControls();
    renderDataInfo();
    render();
    applyView();
  }

  function renderDataInfo() {
    const m = S.meta || {};
    const conn = !!Insitu.token();
    $('#dataInfo').innerHTML =
      `<span id="ageInfo" class="age"></span> · <b>${S.products.length}</b> productos · ${esc(m.source || '')}` +
      (m.sales ? ` · ventas desde ${fmtD(m.from)} (${m.invoices} facturas)${m.stock ? ' + inventario' : ''}` : ' · sin datos de venta') +
      ` · ${conn ? '<button id="resync" class="btn-link" type="button">actualizar de InSitu</button> · ' : ''}` +
      `<button id="changeSrc" class="btn-link" type="button">${conn ? 'desconectar InSitu' : 'conectar InSitu'}</button> · ` +
      `<button id="qbOpen" class="btn-link" type="button">QuickBooks</button> <span id="syncInfo"></span>`;
    $('#qbOpen').addEventListener('click', () => openQb([]));
    renderAge();
    const rs = $('#resync');
    if (rs) rs.addEventListener('click', () => { syncInsitu({ silent: true }).catch(() => {}); });
    $('#changeSrc').addEventListener('click', () => {
      if (conn) {
        if (!confirm('¿Desconectar InSitu en este dispositivo? Tendrás que volver a entrar con tu usuario de InSitu para actualizar datos.')) return;
        store.del(K_TOKEN); toast('InSitu desconectado en este dispositivo'); renderDataInfo();
      }
      else showConnect();
    });
  }

  function renderAge() {
    const el = $('#ageInfo');
    if (!el || !S.meta || !S.meta.at) return;
    const min = Math.floor((Date.now() - S.meta.at) / 60000);
    const t = min < 1 ? 'hace un momento' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h` : `hace ${Math.floor(min / 1440)} días`;
    const fresh = S.meta.source === 'InSitu' && Date.now() - S.meta.at < STALE_MS;
    el.className = 'age' + (fresh ? ' ok' : ' old');
    el.textContent = (fresh ? '● Datos al día · ' : '● ') + 'actualizado ' + t;
  }

  /* ================= CONTROLES ================= */
  // Con inventario de InSitu, nunca se propone algo sin stock (salvo que casi todo venga en 0,
  // señal de que el inventario no se lleva en InSitu y no hay que confiar en él)
  let stockTrusted = null;
  function trustStock() {
    if (stockTrusted !== null) return stockTrusted;
    const withStock = S.products.filter((p) => p.stock != null);
    stockTrusted = withStock.length > 0 && withStock.filter((p) => p.stock > 0).length / withStock.length >= 0.1;
    return stockTrusted;
  }
  function eligibleBase() {
    const noStockOut = trustStock();
    // Sin productos de crédito (CR-): no se ponen en especial
    return S.products.filter((p) => p.price > 0 && p.cost > 0 && p.cost < p.price && p.photo && !EXCLUDE_CATS.includes(p.cat) && !isCredito(p) &&
      !(noStockOut && p.stock != null && p.stock <= 0));
  }

  function buildFilters() {
    const base = eligibleBase();
    const cats = {};
    base.forEach((p) => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
    const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
    if (!Array.isArray(S.set.cats) || !S.set.cats.some((c) => cats[c])) S.set.cats = catNames.slice();
    $('#catChips').innerHTML = catNames
      .map((c) => `<button type="button" class="chip${S.set.cats.includes(c) ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}<small>${cats[c]}</small></button>`)
      .join('');

    const opts = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const vendors = opts(base.map((p) => p.vendor));
    $('#vendorCtrl').hidden = !vendors.length;
    $('#fVendor').innerHTML = '<option value="">Todos</option>' + vendors.map((v) => `<option>${esc(v)}</option>`).join('');
    $('#fBrand').innerHTML = '<option value="">Todas</option>' + opts(base.map((p) => p.brand)).map((v) => `<option>${esc(v)}</option>`).join('');
    $('#fVendor').value = S.set.vendor;
    $('#fBrand').value = S.set.brand;
    if ($('#fVendor').value !== S.set.vendor) S.set.vendor = '';
    if ($('#fBrand').value !== S.set.brand) S.set.brand = '';

    // Estrategias: solo con datos de venta
    const counts = {};
    base.forEach((p) => { counts[p.why || 'normal'] = (counts[p.why || 'normal'] || 0) + 1; });
    $('#stratCtrl').hidden = !hasSales();
    if (!hasSales()) S.set.strat = 'azar';
    else if (S.set.strat === 'azar' && !store.get(K_SET, {}).strat) S.set.strat = 'mixto';
    const n = (k) => STRATS[k] ? STRATS[k].filter((w) => w !== 'normal').reduce((a, w) => a + (counts[w] || 0), 0) : base.length;
    $$('#segStrat button').forEach((b) => {
      const k = b.dataset.v;
      b.querySelector('small') && b.querySelector('small').remove();
      if (k !== 'mixto' && k !== 'azar') b.insertAdjacentHTML('beforeend', `<small>${n(k)}</small>`);
    });
  }

  function syncControls() {
    $$('#segCount button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === S.set.count));
    $$('#segMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.set.mode));
    $$('#segStrat button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.set.strat));
    $('#dMin').value = S.set.dMin;
    $('#dMax').value = S.set.dMax;
    $('#floor').value = S.set.floor;
    $('#dFrom').value = S.set.from;
    $('#dTo').value = S.set.to;
    $('#fCombo').checked = !!S.set.combo;
    updateSetBadge();
  }

  $('#segCount').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.set.count = Number(b.dataset.v); saveSettings(); syncControls();
  });
  $('#segMode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.set.mode = b.dataset.v;
    [S.set.dMin, S.set.dMax] = MODES[S.set.mode];
    saveSettings(); syncControls();
  });
  $('#segStrat').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.set.strat = b.dataset.v; saveSettings(); syncControls();
  });
  const numIn = (id, key) => $(id).addEventListener('change', (e) => {
    let v = parseFloat(e.target.value);
    if (!isFinite(v) || v < 0) v = 0;
    S.set[key] = v;
    if (S.set.dMin > S.set.dMax) [S.set.dMin, S.set.dMax] = [S.set.dMax, S.set.dMin];
    saveSettings(); syncControls();
    if (key === 'floor') render();
  });
  numIn('#dMin', 'dMin'); numIn('#dMax', 'dMax'); numIn('#floor', 'floor');
  ['#dFrom', '#dTo'].forEach((id) => $(id).addEventListener('change', () => {
    S.set.from = $('#dFrom').value; S.set.to = $('#dTo').value;
    S.cards.forEach((c) => { if (!c.customDates) { c.from = S.set.from; c.to = S.set.to; } });
    render();
  }));
  $('#fVendor').addEventListener('change', (e) => { S.set.vendor = e.target.value; saveSettings(); updateSetBadge(); });
  $('#fBrand').addEventListener('change', (e) => { S.set.brand = e.target.value; saveSettings(); updateSetBadge(); });
  $('#fCombo').addEventListener('change', (e) => { S.set.combo = e.target.checked; saveSettings(); updateSetBadge(); });
  $('#catChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const c = b.dataset.cat;
    S.set.cats = S.set.cats.includes(c) ? S.set.cats.filter((x) => x !== c) : [...S.set.cats, c];
    b.classList.toggle('on');
    saveSettings(); updateSetBadge();
  });
  $('#catAll').addEventListener('click', () => { S.set.cats = $$('#catChips .chip').map((b) => b.dataset.cat); $$('#catChips .chip').forEach((b) => b.classList.add('on')); saveSettings(); updateSetBadge(); });
  $('#catNone').addEventListener('click', () => { S.set.cats = []; $$('#catChips .chip').forEach((b) => b.classList.remove('on')); saveSettings(); updateSetBadge(); });

  /* ================= MOTOR DE ESPECIALES ================= */
  const floorF = () => Math.min(0.9, S.set.floor / 100);
  const minPrice = (C) => C / (1 - floorF()); // precio más bajo que respeta el margen mínimo

  // Precio especial para regular P y costo C. `why` ajusta qué tan fuerte es el descuento.
  function specialPrice(P, C, why) {
    const [a, b] = (hasSales() && WHY[why] ? WHY[why].dBoost : [1, 1]);
    const d = (rand(S.set.dMin, S.set.dMax) * rand(a, b)) / 100;
    let s = psychDown(P * (1 - Math.min(0.6, d)));
    const floorP = minPrice(C);
    if (s < floorP) s = psychUp(floorP);
    s = r2(s);
    if (s >= P || (P - s) / P < 0.02) return null;
    return s;
  }

  function pool() {
    const cats = S.set.cats || [];
    const whys = hasSales() ? STRATS[S.set.strat] : null;
    return eligibleBase().filter((p) =>
      cats.includes(p.cat) && (!S.set.vendor || p.vendor === S.set.vendor) && (!S.set.brand || p.brand === S.set.brand) &&
      (!whys || whys.includes(whyEff(p) || 'normal')));
  }

  // Barajado ponderado: pesa el motivo (si hay ventas) y el margen (más espacio para descontar)
  function weight(p) {
    const m = (p.price - p.cost) / p.price;
    const w = hasSales() && S.set.strat !== 'azar' ? (WHY[whyEff(p)] || WHY.normal).w : 1;
    return w * (0.4 + m);
  }
  function weightedShuffle(arr) {
    return arr
      .map((p) => ({ p, k: Math.pow(Math.random(), 1 / weight(p)) }))
      .sort((a, b) => b.k - a.k)
      .map((x) => x.p);
  }

  const snap = (p) => ({
    id: p.id, name: p.name, key: p.key, brand: p.brand, cat: p.cat, upc: p.upc, photo: p.photo, pack: p.pack, vendor: p.vendor,
    price: p.price, cost: p.cost,
    why: p.why || 'normal', st: p.st || null, stock: p.stock ?? null, cover: p.cover ?? null,
  });

  function makeCard(items, P, C, s) {
    const c = { uid: uid(), kind: items.length > 1 ? 'combo' : 'single', items: items.map(snap), P: r2(P), C: r2(C), S: s, from: S.set.from, to: S.set.to, pinned: false, open: false, customDates: false, nx: null };
    // Los más vendidos (gancho) salen como "Compra N, llévate 1 gratis": sube el pedido y no baja el precio de lista
    if (hasSales() && c.kind === 'single' && items[0].why === 'gancho') setNx(c, nxFor(c));
    c.tag = tagFor(c);
    return c;
  }

  /* ---- "Compra N, llévate 1 gratis" ----
   * El cliente paga N cajas y se lleva N+1: precio efectivo por caja = P·N/(N+1).
   * Se usa ese precio efectivo para margen y ganancia (respeta el margen mínimo). */
  const nxPrice = (P, n) => r2((P * n) / (n + 1));
  function nxFor(c) {
    const off = Math.max(0.01, (c.P - c.S) / c.P);
    const COMMON = [1, 2, 3, 4, 5, 6, 8, 10, 12]; // promociones que se usan en la calle (2x1, 5+1, 10+1…)
    const ideal = 1 / off - 1;
    const ok = COMMON.filter((n) => nxPrice(c.P, n) >= minPrice(c.C));
    if (!ok.length) return null;
    return ok.reduce((best, n) => (Math.abs(n - ideal) < Math.abs(best - ideal) ? n : best), ok[0]);
  }
  function setNx(c, n) {
    if (!n) { c.nx = null; return false; }
    if (c.nx == null) c.Sdirect = c.S;
    c.nx = n;
    c.S = nxPrice(c.P, n);
    return true;
  }
  function unsetNx(c) {
    c.S = c.Sdirect != null ? c.Sdirect : c.S;
    c.nx = null;
  }

  function tagFor(c) {
    const off = (c.P - c.S) / c.P, m0 = (c.P - c.C) / c.P;
    if (c.kind === 'combo') return ['combo', 'Combo'];
    if (c.kind === 'group') return ['combo', 'Mismo precio'];
    if (c.nx) return ['nx', `${c.nx} + 1 gratis`];
    const why = c.items[0].why;
    if (why === 'caduca') return ['relampago', 'Por caducar'];
    if (hasSales() && why && why !== 'normal') {
      if (why === 'dormido') return ['liquidacion', 'Liquidación'];
      if (why === 'gancho') return ['gancho', 'Gancho'];
      if (why === 'lento') return ['relampago', 'A mover'];
      if (why === 'bajando') return ['semana', 'Recuperar'];
    }
    if (off >= 0.15) return ['relampago', 'Oferta relámpago'];
    if (/vida|produce|fruta|verdura/i.test(c.items[0].cat)) return ['temporada', 'De temporada'];
    if (m0 >= 0.4) return ['liquidacion', 'Liquidación'];
    return ['semana', 'Especial de la semana'];
  }

  function pickSingles(k, used, list) {
    const byCat = {};
    weightedShuffle(list).forEach((p) => { (byCat[p.cat] = byCat[p.cat] || []).push(p); });
    // Orden de categorías al azar, con más peso a las que tienen más productos
    const cats = Object.keys(byCat)
      .map((c) => ({ c, k: Math.pow(Math.random(), 1 / Math.sqrt(byCat[c].length)) }))
      .sort((a, b) => b.k - a.k)
      .map((x) => x.c);
    if (!cats.length) return [];
    let cap = S.set.count <= 4 ? 1 : S.set.count <= 8 ? 2 : 3;
    cap = Math.max(cap, Math.ceil(k / cats.length));
    const taken = {}, out = [];
    let progress = true;
    while (out.length < k && progress) {
      progress = false;
      for (const cat of cats) {
        if (out.length >= k) break;
        if ((taken[cat] || 0) >= cap) continue;
        const q = byCat[cat];
        while (q.length) {
          const p = q.shift();
          if (used.has(p.key)) continue;
          const why = whyEff(p);
          const s = specialPrice(p.price, p.cost, why);
          if (s == null) continue;
          used.add(p.key);
          const c = makeCard([p], p.price, p.cost, s);
          if (why === 'caduca') { c.items[0].why = 'caduca'; c.items[0].exp = S.risk[skuKey(p.id)]; if (c.nx) unsetNx(c); c.tag = tagFor(c); }
          out.push(c);
          taken[cat] = (taken[cat] || 0) + 1;
          progress = true;
          break;
        }
      }
    }
    return out;
  }

  function pickCombo(used, list) {
    const byBrand = {};
    list.forEach((p) => { if (p.brand && !used.has(p.key)) (byBrand[p.brand] = byBrand[p.brand] || []).push(p); });
    const brands = Object.keys(byBrand).filter((b) => new Set(byBrand[b].map((p) => p.key)).size >= 2).sort(() => Math.random() - 0.5);
    for (const b of brands) {
      const [a, ...rest] = weightedShuffle(byBrand[b]);
      const bb = rest.find((p) => p.key !== a.key);
      if (!bb) continue;
      const P = a.price + bb.price, C = a.cost + bb.cost;
      const s = specialPrice(P, C, 'normal');
      if (s == null) continue;
      used.add(a.key); used.add(bb.key);
      return makeCard([a, bb], P, C, s);
    }
    return null;
  }

  function generate() {
    if (!S.set.cats || !S.set.cats.length) { toast('Elige al menos una categoría'); return; }
    S.risk = R.lotes ? riskMap() : {}; // lo que no alcanza a venderse antes de su fecha sube de prioridad
    const n = S.set.count;
    const list = pool();
    const keep = S.cards.filter((c) => c.pinned);
    const used = new Set(keep.flatMap((c) => c.items.map((i) => i.key)));
    const need = Math.max(0, n - keep.length);
    if (!need) { toast('Todas están fijadas'); return; }
    const fresh = [];
    if (S.set.combo && need >= 2 && !keep.some((c) => c.kind === 'combo')) {
      const cb = pickCombo(used, list);
      if (cb) fresh.push(cb);
    }
    fresh.push(...pickSingles(need - fresh.length, used, list));
    fresh.sort(() => Math.random() - 0.5);

    // Las fijadas se quedan en su lugar; lo demás se rellena
    const next = [];
    let q = 0;
    for (const c of S.cards) {
      if (next.length >= n) break;
      if (c.pinned) next.push(c);
      else if (q < fresh.length) next.push(fresh[q++]);
    }
    while (next.length < n && q < fresh.length) next.push(fresh[q++]);
    S.cards = next;
    if (fresh.length < need) toast(`Solo encontré ${fresh.length} con esos filtros`);
    render(true);
  }
  $('#genBtn').addEventListener('click', generate);

  function swapCard(u) {
    const i = S.cards.findIndex((c) => c.uid === u);
    if (i < 0) return;
    const old = S.cards[i];
    const used = new Set(S.cards.flatMap((c) => c.items.map((x) => x.key)));
    const list = pool();
    let nc = old.kind === 'combo' ? pickCombo(used, list) : null;
    if (!nc) {
      // Priorizar la misma categoría para no desbalancear
      const same = list.filter((p) => p.cat === old.items[0].cat);
      nc = pickSingles(1, used, same.length ? same : list)[0] || pickSingles(1, used, list)[0];
    }
    if (!nc) { toast('No hay más opciones con estos filtros'); return; }
    if (old.customDates) { nc.from = old.from; nc.to = old.to; nc.customDates = true; }
    S.cards[i] = nc;
    render(false, nc.uid);
  }

  /* ---- Agregar un producto a mano (buscador de Especiales) ----
   * Se arma igual que las generadas (precio especial sugerido, margen, ventas, motivo) y queda
   * fijada para que no se pierda al volver a generar. */
  const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  $('#espSearch').addEventListener('input', (e) => {
    const q = normTxt(e.target.value.trim());
    const box = $('#espResults');
    if (q.length < 2) { box.hidden = true; return; }
    const words = q.split(/\s+/);
    const inCards = new Set(S.cards.flatMap((c) => c.items.map((i) => String(i.id))));
    const res = S.products.filter((p) => { const t = normTxt(`${p.name} ${p.brand} ${p.id} ${p.upc}`); return !isCredito(p) && words.every((w) => t.includes(w)); }).slice(0, 12);
    box.innerHTML = res.length ? res.map((p) => {
      const ok = p.price > 0 && p.cost > 0 && p.cost < p.price;
      const why = p.why && p.why !== 'normal' && WHY[p.why] ? ' · ' + WHY[p.why].label : '';
      return `<button type="button" role="option" data-add="${esc(p.id)}"${ok && !inCards.has(String(p.id)) ? '' : ' disabled'}>${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>SKU ${esc(p.id)} · ${money(p.price)}${p.stock != null ? ' · stock ' + nfmt(p.stock) : ''}${why}${inCards.has(String(p.id)) ? ' · ya está' : ok ? '' : ' · sin precio o costo'}</small></span></button>`;
    }).join('') : '<p class="data-info" style="padding:10px">Sin resultados</p>';
    box.hidden = false;
  });
  $('#espResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]'); if (!b || b.disabled) return;
    const p = S.products.find((x) => String(x.id) === b.dataset.add); if (!p) return;
    const s = specialPrice(p.price, p.cost, p.why) || r2(Math.max(psychUp(minPrice(p.cost)), p.price * 0.97));
    const c = makeCard([p], p.price, p.cost, Math.min(s, p.price));
    c.pinned = true; c.manual = true;
    S.cards.unshift(c);
    $('#espSearch').value = ''; $('#espResults').hidden = true;
    render(true);
    toast('Agregado: ' + p.name + ' · queda fijado');
    window.scrollTo({ top: $('#grid').offsetTop - 80, behavior: 'smooth' });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.esp-search')) $('#espResults').hidden = true; });

  /* ---- Especiales vigentes (activos o programados en QuickBooks) ---- */
  let vigData = [];
  // Convierte los vigentes en tarjetas para la hoja de clientes (PDF / imagen)
  function vigToCards() {
    const one = (e) => {
      const p = S.products.find((x) => String(x.id) === String(e.sku)) || {};
      const P = r2(e.original != null ? e.original : e.regular || p.price || e.special);
      return { uid: uid(), kind: 'single', nx: null, P, C: 0, S: r2(e.special), from: e.from, to: e.to, e,
        items: [{ id: String(e.sku || ''), name: e.name || e.qbName, brand: p.brand || '', cat: p.cat || '', photo: p.photo || '', pack: p.pack || '', upc: p.upc || '', price: P, cost: p.cost || 0 }] };
    };
    const asGroup = (list, title, shortTxt) => {
      const cs = list.map(one), e0 = list[0];
      const c = { uid: uid(), kind: 'group', nx: null, S: r2(e0.special), from: e0.from, to: e0.to, items: cs.map((x) => x.items[0]) };
      c.P = r2(avgOf(c.items.map((i) => i.price))); c.C = 0;
      c.title = title || groupTitle(c.items);
      if (shortTxt) c.shortTxt = shortTxt;
      return c;
    };
    const out = [], used = new Set();
    const k3 = (sku, f, to) => `${sku}|${f}|${to}`;
    const byKey = new Map(vigData.map((e) => [k3(String(e.sku), e.from, e.to), e]));
    // 1) Los grupos tal como se armaron en una propuesta guardada (mismo nombre y nombres cortos)
    (S.hist || []).forEach((h) => (h.cards || []).forEach((c) => {
      if (c.kind !== 'group') return;
      const es = c.items.map((i) => byKey.get(k3(String(i.id), c.from, c.to)));
      const ok = es.filter((x) => x && !used.has(x));
      if (ok.length < 2 || ok.length < es.length * 0.6) return;
      ok.forEach((x) => used.add(x));
      out.push(asGroup(ok, c.title, c.shortEdited ? c.shortTxt : null));
    }));
    // 2) Programados como grupo desde la IA, o (los de antes) misma marca + mismo precio + mismas fechas
    const brandKey = (e) => {
      const p = S.products.find((x) => String(x.id) === String(e.sku));
      const b = normTxt(p && p.brand).replace(/[^a-z]/g, '').replace(/s$/, '');
      return b || normTxt(e.name || e.qbName).split(/\s+/)[0] || '';
    };
    const groups = new Map();
    vigData.filter((e) => !used.has(e)).forEach((e) => {
      const k = e.grupo ? 'g:' + e.grupo : `a:${r2(e.special)}|${e.from}|${e.to}|${brandKey(e)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(e);
    });
    groups.forEach((list) => {
      if (list.length < 2) { out.push(one(list[0])); return; }
      out.push(asGroup(list, list[0].grupoTitulo, list[0].grupoCorto));
    });
    return out;
  }
  $('#vigPdf').addEventListener('click', () => {
    if (!vigData.length) return;
    sheetCards = vigToCards(); sheetCat = null; sheetReport = null; sheetTheme = null; buildSheet(); openModal('#clientModal'); fitPages();
  });
  let qbAll = [];
  // Una propuesta guardada ya está "hecha" si todos sus productos quedaron en QuickBooks con sus fechas
  function propEnQb(h) {
    if (!qbAll.length) return false;
    const skus = h.cards.flatMap((c) => c.items.map((i) => ({ id: String(i.id), from: c.from, to: c.to })));
    return skus.length > 0 && skus.every((x) => qbAll.some((e) => String(e.sku) === x.id && e.from === x.from && e.to === x.to && e.status !== 'cancelado'));
  }
  async function loadVigentes() {
    const sec = $('#vigentes');
    try {
      const d = await qbCall('list');
      qbAll = d.list || [];
      const today = d.today || ymd(new Date());
      const vig = (d.list || []).filter((e) => ['activo', 'programado'].includes(e.status) && e.to >= today)
        .sort((a, b) => (a.status === b.status ? a.from.localeCompare(b.from) : a.status === 'activo' ? -1 : 1));
      sec.hidden = !vig.length;
      vigData = vig;
      $('#vigList').innerHTML = vig.map((e) => {
        const p = S.products.find((x) => String(x.id) === String(e.sku)) || {};
        const off = e.original ? (e.original - e.special) / e.original : e.regular ? (e.regular - e.special) / e.regular : null;
        return `<div class="vig-c st-${esc(e.status)}">
          <div class="vig-ph">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy">` : ''}</div>
          <div class="vig-b"><span class="qb-pill">${e.status === 'activo' ? 'Activo' : 'Programado'}</span>
            <b>${esc(e.name || e.qbName)}</b>
            <span class="vig-p"><strong>${money(e.special)}</strong>${e.original != null || e.regular ? ` <s>${money(e.original ?? e.regular)}</s>` : ''}${off != null ? ` · -${Math.round(off * 100)}%` : ''}</span>
            <small>${fmtD(e.from)} – ${fmtD(e.to)} · ${esc(e.by || '')}</small></div>
        </div>`;
      }).join('');
      $('#vigCount').textContent = vig.length;
      renderResultados(today);
    } catch (e) { sec.hidden = true; }
  }

  /* ---- Resultados de los especiales: cuánto se vendió durante el especial vs lo normal
   * (promedio de las 8 semanas anteriores, con las ventas por día de InSitu) ---- */
  let resSel = null, RES = null;
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  function sumDias(dd, a, b) { let q = 0; Object.entries(dd || {}).forEach(([k, v]) => { if (k >= a && k <= b) q += v; }); return q; }
  function resultadosDe(list, today) {
    const rows = [];
    list.forEach((e) => {
      const p = S.products.find((x) => String(x.id) === String(e.sku));
      if (!p || !p.st || !p.st.d) return;
      const fin = e.to < today ? e.to : addDays(today, -1); // hasta ayer si sigue vigente
      if (fin < e.from) return;
      const dias = Math.round((parseYmd(fin) - parseYmd(e.from)) / 864e5) + 1;
      const durante = sumDias(p.st.d, e.from, fin);
      const base8 = sumDias(p.st.d, addDays(e.from, -56), addDays(e.from, -1)) / 8; // cajas por semana antes
      const esperado = (base8 / 7) * dias;
      const lift = esperado > 0 ? durante / esperado - 1 : durante > 0 ? null : 0;
      rows.push({ e, p, durante: r2(durante), esperado: r2(esperado), extra: r2(durante - esperado), lift, venta: r2(durante * e.special), dias });
    });
    return rows;
  }
  function renderResultados(today) {
    const sec = $('#resultados'); if (!sec) return;
    if (onlyView()) { sec.hidden = true; return; }
    if (!S.products.some((p) => p.st && p.st.d)) {
      // Datos bajados antes de que existiera esta medición: falta traer las ventas por día
      const hay = qbAll.some((e) => ['activo', 'terminado'].includes(e.status));
      sec.hidden = !hay;
      if (hay) sec.innerHTML = `<div class="vig-h"><p class="lbl">Resultados de especiales</p></div><p class="status">Para calcular cómo le fue a cada especial hay que volver a bajar las ventas: toca <button id="resSync" class="btn-link" type="button">actualizar de InSitu</button>.</p>`;
      const b = $('#resSync');
      if (b) b.addEventListener('click', () => { if (Insitu.token() && !syncing) syncInsitu({ silent: false }).catch(() => {}); });
      return;
    }
    // Periodos (desde–hasta) que ya empezaron, de los últimos 90 días
    const per = {};
    qbAll.filter((e) => ['activo', 'terminado', 'omitido'].includes(e.status) && e.from <= today && e.to >= addDays(today, -90))
      .forEach((e) => { (per[`${e.from}|${e.to}`] = per[`${e.from}|${e.to}`] || []).push(e); });
    const keys = Object.keys(per).sort().reverse();
    if (!keys.length) { sec.hidden = true; return; }
    if (!resSel || !per[resSel]) resSel = keys.find((k) => k.split('|')[1] < today) || keys[0]; // el último que ya terminó
    const [from, to] = resSel.split('|'), enCurso = to >= today;
    const rows = resultadosDe(per[resSel], today).sort((a, b) => (b.lift ?? 9) - (a.lift ?? 9));
    const tot = rows.reduce((a, r) => a + r.durante, 0), esp = rows.reduce((a, r) => a + r.esperado, 0);
    const liftT = esp > 0 ? tot / esp - 1 : null, venta = rows.reduce((a, r) => a + r.venta, 0);
    const subio = rows.filter((r) => r.lift == null || r.lift > 0.2).length;
    const tag = (r) => (r.lift == null ? '<span class="pill ok">se movió (antes no se vendía)</span>' : r.lift > 0.2 ? `<span class="pill ok">funcionó · +${Math.round(r.lift * 100)}%</span>`
      : r.lift >= -0.1 ? `<span class="pill">igual que siempre${r.lift ? ` · ${r.lift > 0 ? '+' : ''}${Math.round(r.lift * 100)}%` : ''}</span>` : `<span class="pill bad">bajó · ${Math.round(r.lift * 100)}%</span>`);
    sec.hidden = false;
    RES = { per, keys, today };
    sec.innerHTML = `
      <div class="vig-h"><p class="lbl">Resultados de especiales${enCurso ? ' <small>(en curso, hasta ayer)</small>' : ''}</p>
        <div class="res-dl"><button type="button" class="btn btn-ghost btn-sm" data-resdl="pdf">${icon('download')}PDF</button><button type="button" class="btn btn-ghost btn-sm" data-resdl="xls">${icon('download')}Excel</button>${keys.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-resdl="todos">${icon('download')}Excel todos</button>` : ''}</div></div>
      ${keys.length > 1 ? `<div class="pills res-per">${keys.slice(0, 6).map((k) => { const [a, b] = k.split('|'); return `<button type="button" data-res="${k}" class="${k === resSel ? 'on' : ''}">${fmtD(a)} – ${fmtD(b)}</button>`; }).join('')}</div>` : ''}
      <div class="res-kpis">
        <div class="fs"><span class="lbl">Cajas vendidas</span><b>${nfmt(tot)}</b><small>normal ~${nfmt(r2(esp))}</small></div>
        <div class="fs ${liftT == null ? '' : liftT > 0.2 ? 'good' : liftT < -0.1 ? 'hot' : ''}"><span class="lbl">Contra lo normal</span><b>${liftT == null ? '—' : `${liftT >= 0 ? '+' : ''}${Math.round(liftT * 100)}%`}</b><small>${nfmt(r2(tot - esp))} cajas ${tot >= esp ? 'extra' : 'menos'}</small></div>
        <div class="fs"><span class="lbl">Funcionaron</span><b>${subio} de ${rows.length}</b><small>subieron más de 20%</small></div>
        <div class="fs"><span class="lbl">Venta en especial</span><b>${money(venta)}</b><small>${fmtD(from)} – ${fmtD(to)}</small></div>
      </div>
      <div class="res-list">${rows.map((r) => `<div class="res-r">
        <div class="vig-ph">${r.p.photo ? `<img src="${esc(r.p.photo)}" alt="" loading="lazy">` : ''}</div>
        <div class="res-m"><b>${esc(r.p.name)}</b><small>Vendiste ${nfmt(r.durante)} ${r.durante === 1 ? 'caja' : 'cajas'} en ${r.dias} ${r.dias === 1 ? 'día' : 'días'} · normal ~${nfmt(r.esperado)} · a ${money(r.e.special)}</small></div>
        ${tag(r)}</div>`).join('')}</div>`;
  }
  // ---- Descargar el informe de resultados (PDF / Excel del periodo, o Excel de todos los periodos) ----
  const resultTxt = (r) => (r.lift == null ? 'Se movió (antes no se vendía)' : r.lift > 0.2 ? 'Funcionó' : r.lift >= -0.1 ? 'Igual que siempre' : 'Bajó');
  const resFilas = (key) => resultadosDe(RES.per[key], RES.today).sort((a, b) => (b.lift ?? 9) - (a.lift ?? 9)).map((r) => ({
    Periodo: `${fmtD(r.e.from)} – ${fmtD(r.e.to)}`, Producto: r.p.name, 'Precio especial': r.e.special, 'Precio normal': r.e.original ?? r.e.regular ?? '', Días: r.dias,
    'Cajas vendidas': r.durante, 'Normal (esperado)': r.esperado, 'Cajas extra': r.extra, 'Contra lo normal %': r.lift == null ? '' : Math.round(r.lift * 100), 'Venta en especial': r.venta, Resultado: resultTxt(r) }));
  async function descargarResultados(tipo) {
    if (!RES) return;
    const d = new Date(), stamp = `${d.getDate()}${MES[d.getMonth()]}${d.getFullYear()}`;
    if (tipo === 'xls' || tipo === 'todos') {
      if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      const wb = XLSX.utils.book_new();
      const keys = tipo === 'todos' ? RES.keys : [resSel];
      keys.forEach((k) => { const [a, b] = k.split('|'); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resFilas(k)), `${fmtD(a)} a ${fmtD(b)}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31)); });
      XLSX.writeFile(wb, `Resultados-especiales-${tipo === 'todos' ? 'todos' : resSel.replace('|', '_a_')}-${stamp}.xlsx`);
      return;
    }
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const [a, b] = resSel.split('|');
    const filas = resFilas(resSel);
    const tot = filas.reduce((x, r) => x + r['Cajas vendidas'], 0), esp = filas.reduce((x, r) => x + r['Normal (esperado)'], 0), venta = filas.reduce((x, r) => x + r['Venta en especial'], 0);
    const fun = filas.filter((r) => r.Resultado === 'Funcionó' || r.Resultado.startsWith('Se movió')).length;
    const liftT = esp > 0 ? tot / esp - 1 : null;
    const VERDE = [46, 139, 61], ROJO = [216, 51, 27], ORO = [242, 163, 30], NEGRO = [15, 13, 10], GRIS = [110, 104, 94];
    // Banda de encabezado
    doc.setFillColor(...NEGRO); doc.rect(0, 0, W, 92, 'F');
    const logo = await logoData(); if (logo) { doc.setFillColor(255, 255, 255); doc.roundedRect(36, 18, 96, 56, 8, 8, 'F'); doc.addImage(logo, 'PNG', 44, 24, 80, 43); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...ORO); doc.text('Resultados de especiales', W - 40, 46, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(246, 242, 233); doc.text(`${fmtLong(a)} – ${fmtLong(b)}`, W - 40, 66, { align: 'right' });
    // Recuadros de resumen
    const kpis = [
      ['CAJAS VENDIDAS', nfmt(tot), `normal ~${nfmt(r2(esp))}`, [46, 64, 120]],
      ['CONTRA LO NORMAL', liftT == null ? '—' : `${liftT >= 0 ? '+' : ''}${Math.round(liftT * 100)}%`, `${nfmt(r2(tot - esp))} cajas ${tot >= esp ? 'extra' : 'menos'}`, liftT == null ? GRIS : liftT > 0.2 ? VERDE : liftT < -0.1 ? ROJO : GRIS],
      ['FUNCIONARON', `${fun} de ${filas.length}`, 'subieron más de 20%', [190, 110, 20]],
      ['VENTA EN ESPECIAL', money(venta), `${fmtD(a)} – ${fmtD(b)}`, NEGRO],
    ];
    const bw = (W - 80 - 3 * 10) / 4;
    kpis.forEach(([lbl, val, sub, col], i) => {
      const x = 40 + i * (bw + 10);
      doc.setFillColor(...col); doc.roundedRect(x, 108, bw, 62, 8, 8, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text(lbl, x + 10, 124);
      doc.setFontSize(17); doc.text(String(val), x + 10, 146);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(sub, x + 10, 160);
    });
    const colorDe = (res) => (res === 'Funcionó' || res.startsWith('Se movió') ? VERDE : res === 'Bajó' ? ROJO : GRIS);
    doc.autoTable({
      startY: 186, margin: { left: 40, right: 40 },
      head: [['Producto', 'Precio esp.', 'Cajas', 'Normal', '% vs normal', 'Venta', 'Resultado']],
      body: filas.map((r) => [r.Producto, money(r['Precio especial']), nfmt(r['Cajas vendidas']), nfmt(r['Normal (esperado)']), r['Contra lo normal %'] === '' ? 'nuevo' : `${r['Contra lo normal %'] > 0 ? '+' : ''}${r['Contra lo normal %']}%`, money(r['Venta en especial']), r.Resultado]),
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5, textColor: [20, 18, 12], lineColor: [230, 224, 212], lineWidth: 0.5 },
      headStyles: { fillColor: NEGRO, textColor: ORO, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [250, 247, 240] },
      columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', fontStyle: 'bold' }, 5: { halign: 'right' }, 6: { halign: 'center', fontStyle: 'bold' } },
      didParseCell: (h) => {
        if (h.section !== 'body') return;
        const res = filas[h.row.index].Resultado, col = colorDe(res);
        if (h.column.index === 4) h.cell.styles.textColor = col;
        if (h.column.index === 6) { h.cell.styles.fillColor = col; h.cell.styles.textColor = [255, 255, 255]; }
      },
    });
    // Pie
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(...GRIS); doc.text(`Central Trade Distribution · Sistema Inteligente · página ${i} de ${pages}`, W / 2, doc.internal.pageSize.getHeight() - 20, { align: 'center' }); }
    download(doc.output('blob'), `Resultados-especiales-${a}_a_${b}.pdf`);
  }
  $('#resultados').addEventListener('click', (e) => {
    const dl = e.target.closest('[data-resdl]'); if (dl) { descargarResultados(dl.dataset.resdl).catch((err) => toast('No se pudo: ' + err.message)); return; }
    const b = e.target.closest('[data-res]'); if (!b) return; resSel = b.dataset.res; renderResultados(ymd(new Date()));
  });

  /* ---- Grupo con el mismo precio: varios productos (ej. veladoras) con un solo precio especial c/u.
   * En QuickBooks cada producto lleva ese precio durante la vigencia. ---- */
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  function groupTitle(items) {
    const ws = items.map((i) => new Set(normTxt(i.name).replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2)));
    const common = [...ws[0]].filter((w) => ws.every((s) => s.has(w)));
    const t = common.slice(0, 3).join(' ');
    return t ? t.replace(/\b\w/g, (m) => m.toUpperCase()) : (items[0].brand || 'Grupo') + ' y más';
  }
  // Nombres cortos de cada producto del grupo: se quita lo que todos comparten (VELADORA, FESTIVAL…),
  // tamaños y empaques. "VELADORA SAN JUDAS 12/1" → "San Judas"
  const SHORT_STOP = new Set(['oz', 'fl', 'lb', 'lbs', 'ml', 'lt', 'lts', 'gr', 'grs', 'kg', 'ct', 'cs', 'pk', 'pz', 'pcs', 'pc', 'bag', 'pack', 'pck', 'caja', 'case', 'ow', 'bs', 'bolsa', 'und', 'unds', 'x', 'jar', 'tin', 'box', 'display', 'disp', 'shipper', 'cookie', 'cookies', 'galleta', 'galletas', 'gta', 'bs', 'mto', 'fda', 'flavor', 'sabor', 'pieces', 'piezas']);
  // Sabores en inglés → español (como se dicen en la tienda)
  const SABOR = { lemon: 'Limón', lime: 'Limón', strawberry: 'Fresa', vanilla: 'Vainilla', vanila: 'Vainilla', coconut: 'Coco', orange: 'Naranja', pineapple: 'Piña', grape: 'Uva', apple: 'Manzana', peach: 'Durazno', cherry: 'Cereza', guava: 'Guayaba', tamarind: 'Tamarindo', watermelon: 'Sandía', blackberry: 'Mora', cinnamon: 'Canela', honey: 'Miel', milk: 'Leche', caramel: 'Cajeta', passionfruit: 'Maracuyá', soursop: 'Guanábana', 'banana': 'Plátano', white: 'Blanca', red: 'Roja', green: 'Verde', hot: 'Picante', spicy: 'Picante' };
  const CONECT = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'con', 'del', 'en']);
  function shortNames(items) {
    const toks = items.map((i) => String(i.name).replace(/[\/,.()]+/g, ' ').split(/\s+/).filter(Boolean));
    const key = (w) => normTxt(w);
    const common = new Set(toks[0].map(key).filter((w) => !CONECT.has(w) && toks.every((ts) => ts.some((x) => key(x) === w))));
    return toks.map((ts) => {
      let k = ts.filter((w) => !common.has(key(w)) && !/\d/.test(w) && !SHORT_STOP.has(key(w)));
      while (k.length && CONECT.has(key(k[0]))) k.shift();
      while (k.length && CONECT.has(key(k[k.length - 1]))) k.pop();
      if (!k.length) k = ts.filter((w) => !/\d/.test(w)).slice(0, 2);
      return k.slice(0, 4).map((w) => SABOR[key(w)] || w).join(' ').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()).replace(/\b(De|La|El|Los|Las|Y|Con|Del|En)\b/g, (m) => m.toLowerCase());
    });
  }
  const groupShort = (c) => (c.shortTxt != null && c.shortTxt.trim() ? c.shortTxt.trim() : shortNames(c.items).join(' · '));
  function recalcGroup(c) {
    c.P = r2(avgOf(c.items.map((i) => i.price)));
    c.C = r2(avgOf(c.items.map((i) => i.cost)));
    c.tag = tagFor(c);
  }
  // Margen más bajo del grupo (el que manda para el aviso del mínimo)
  // Descuento que se anuncia en un grupo: el mayor entre sus productos (nunca negativo)
  const groupOff = (c) => Math.max(0, ...c.items.map((i) => (i.price - c.S) / i.price));
  const groupMinMargin = (c) => Math.min(...c.items.map((i) => (c.S - i.cost) / c.S));
  function addToCard(c, p) {
    if (c.items.some((i) => String(i.id) === String(p.id))) { toast('Ya está en este especial'); return false; }
    if (c.kind === 'single') {
      if (c.nx) unsetNx(c);
      const it0 = c.items[0], src = S.products.find((x) => String(x.id) === String(it0.id));
      if (!(it0.price > 0)) it0.price = src ? src.price : c.P;
      if (!(it0.cost > 0)) it0.cost = src ? src.cost : c.C;
      c.kind = 'group';
      c.titleAuto = true;
    }
    c.items.push(snap(p));
    if (c.shortTxt && !c.shortEdited) c.shortTxt = null;
    if (c.titleAuto) c.title = groupTitle(c.items);
    recalcGroup(c);
    c.pinned = true;
    if (p.price <= c.S) toast(`Ojo: ${p.name} normalmente cuesta ${money(p.price)}, igual o menos que el especial (${money(c.S)})`);
    return true;
  }
  function removeFromCard(c, id) {
    c.items = c.items.filter((i) => String(i.id) !== String(id));
    if (c.items.length === 1) {
      const it = c.items[0];
      c.kind = 'single'; c.P = r2(it.price); c.C = r2(it.cost); delete c.title; delete c.titleAuto;
      if (c.S > c.P) c.S = c.P;
      c.tag = tagFor(c);
    } else {
      if (c.titleAuto) c.title = groupTitle(c.items);
      recalcGroup(c);
    }
  }

  /* ================= RENDER ================= */
  const stats = (c) => {
    const m0 = (c.P - c.C) / c.P, m1 = (c.S - c.C) / c.S;
    return { m0, m1, off: (c.P - c.S) / c.P, save: c.P - c.S, g0: c.P - c.C, g1: c.S - c.C };
  };

  function photoHTML(c) {
    const img = (i) => i.photo
      ? `<img src="${esc(i.photo)}" alt="${esc(i.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'noimg',textContent:'sin foto'}))">`
      : '<span class="noimg">sin foto</span>';
    const its = c.kind === 'group' ? c.items.slice(0, 4) : c.items;
    return `<div class="ph${c.kind === 'combo' || c.kind === 'group' ? ' combo' : ''}${c.kind === 'group' ? ' grp' + (its.length > 2 ? ' g4' : '') : ''}">${its.map(img).join('')}<div class="ph-ov"></div></div>`;
  }
  function overlayHTML(c) {
    const st = stats(c);
    const off = c.kind === 'group' ? groupOff(c) : st.off;
    return `<span class="tag t-${c.tag[0]}">${esc(c.tag[1])}</span><span class="off">-${Math.round(off * 100)}%</span>`;
  }

  // Mini gráfica de 12 meses (cajas vendidas por mes)
  function sparkHTML(m) {
    const max = Math.max(...m, 0);
    if (!max) return '<div class="spark empty-spark">sin ventas en 12 meses</div>';
    const bars = m.map((v, i) => `<i style="height:${Math.max(v ? 8 : 2, (v / max) * 100)}%" class="${i === 11 ? 'now' : ''}${!v ? ' zero' : ''}" title="${nfmt(v)}"></i>`).join('');
    return `<div class="spark" title="Cajas vendidas por mes (últimos 12)">${bars}</div>`;
  }

  // Aviso si no alcanza el inventario para aguantar una promo (menos de 3 semanas de venta)
  function stockWarn(it) {
    if (it.stock == null || !it.st) return '';
    const weekly = it.st.u90 / 13;
    if (it.stock <= 0) return `<p class="why-warn">${icon('alert')}<span>Sin stock. Resurte antes de lanzarla.</span></p>`;
    if (weekly > 0 && it.stock / weekly < 3) {
      const w = it.stock / weekly;
      return `<p class="why-warn">${icon('alert')}<span>Solo quedan ${cajas(it.stock)} (~${w < 1 ? 'menos de 1 semana' : Math.round(w) + (Math.round(w) === 1 ? ' semana' : ' semanas')} de venta). Resurte antes de lanzarla.</span></p>`;
    }
    return '';
  }

  function salesHTML(c, off) {
    if (c.kind === 'combo' || c.kind === 'group' || !c.items[0].st) return '';
    const it = c.items[0], st = it.st, w = WHY[it.why] || WHY.normal;
    if (it.why === 'normal' && !st.u365) return '';
    const txt = reasonText(it, off);
    return `
      <div class="why why-${esc(it.why)}">
        <div class="why-h"><span>${icon(w.icon)}${esc(w.label)}</span><span class="why-last">${st.last ? 'última venta ' + fmtD(st.last) : 'sin ventas 12m'}</span></div>
        ${txt ? `<p class="why-t">${esc(txt)}</p>` : ''}
        ${stockWarn(it)}
        ${sparkHTML(st.m)}
        <div class="why-k">
          <span><b>${nfmt(st.u30)}</b> 30d</span><span><b>${nfmt(st.u90)}</b> 90d</span><span><b>${nfmt(st.u365)}</b> 12m</span>
          ${it.stock != null ? `<span><b>${nfmt(it.stock)}</b> stock</span>` : `<span><b>${st.clients}</b> clientes</span>`}
        </div>
      </div>`;
  }

  // Caducidad más próxima (de Recibo) en la tarjeta del especial
  function expHTML(c) {
    if (!R.lotes) return '';
    const e = c.items.map((i) => nextExpiry(i.id)).filter(Boolean).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
    if (!e || e.dias > 180) return '';
    return `<div class="exp${e.dias <= 60 || e.riesgo ? ' hot' : ''}">Vence ${esc(fmtLong(e.d))}${e.quedan != null ? ` · ~${nfmt(e.quedan)} cajas` : ''}</div>`;
  }
  function groupViewHTML(c) {
    const fl = floorF();
    const ps = c.items.map((i) => i.price);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    return `
      <div>
        <div class="brand">Mismo precio · ${c.items.length} productos</div>
        <h3 class="name">${esc(c.title || groupTitle(c.items))}</h3>
        <div class="meta g-short">${esc(groupShort(c))}</div>
        ${expHTML(c)}
      </div>
      <div class="prices">
        <span class="p-new">${money(c.S)}<small class="cu"> c/u</small></span>
        <span class="p-old">${lo === hi ? money(lo) : money(lo) + '–' + money(hi)}</span>
      </div>
      <ul class="grp-list">${c.items.map((i) => {
        const m = (c.S - i.cost) / c.S, off = (i.price - c.S) / i.price;
        const up = off <= 0;
        return `<li${up ? ' class="g-up"' : ''}>${i.photo ? `<img src="${esc(i.photo)}" alt="" loading="lazy" onerror="this.remove()">` : '<span class="g-ph"></span>'}
          <span class="g-n">${esc(i.name)}<small>antes ${money(i.price)} · ${up ? '<b class="warn">no baja: no se programa</b>' : '-' + Math.round(off * 100) + '%'} · margen <b class="${m < fl - 1e-9 ? 'warn' : ''}">${pct(m, 0)}</b>${i.stock != null ? ' · stock ' + nfmt(i.stock) : ''}</small></span>
          <button type="button" class="g-x" data-act="rm" data-id="${esc(i.id)}" aria-label="Quitar ${esc(i.name)}" title="Quitar">×</button></li>`;
      }).join('')}</ul>`;
  }
  function viewHTML(c) {
    if (c.kind === 'group') return groupViewHTML(c);
    const st = stats(c), fl = floorF();
    const name = c.items.map((i) => i.name).join(' + ');
    const brand = [...new Set(c.items.map((i) => i.brand).filter(Boolean))].join(' · ') || c.items[0].cat;
    const meta = c.kind === 'combo'
      ? `${c.items.length} productos · ${esc(c.items[0].cat)}`
      : [c.items[0].pack, c.items[0].upc && 'UPC ' + c.items[0].upc, c.items[0].cat].filter(Boolean).map(esc).join(' · ');
    const w0 = Math.max(0, Math.min(100, st.m0 * 100 / 0.6)), w1 = Math.max(0, Math.min(100, st.m1 * 100 / 0.6));
    const flx = Math.min(100, fl * 100 / 0.6);
    const low = st.m1 < fl - 1e-9;
    return `
      <div>
        <div class="brand">${esc(brand)}</div>
        <h3 class="name">${esc(name)}</h3>
        <div class="meta">${meta}</div>
        ${expHTML(c)}
      </div>
      ${c.nx ? `<div class="prices nx">
        <span class="p-nx">Compra ${c.nx}<small>llévate 1 gratis</small></span>
        <span class="p-eq">Paga ${money(c.P * c.nx)} por ${c.nx + 1} cajas · equivale a <b>${money(c.S)}</b> c/u (-${pct(st.off)})</span>
      </div>` : `<div class="prices">
        <span class="p-new">${money(c.S)}</span>
        <span class="p-old">${money(c.P)}</span>
        <span class="p-save">Ahorra ${money(st.save)}</span>
      </div>`}
      ${salesHTML(c, st.off)}
      <table class="ab">
        <thead><tr><th></th><th>Antes</th><th>Especial</th></tr></thead>
        <tbody>
          <tr><td>${c.nx ? 'Precio efectivo' : 'Precio'}</td><td>${money(c.P)}</td><td class="hi">${money(c.S)}</td></tr>
          <tr><td>Costo</td><td>${money(c.C)}</td><td>${money(c.C)}</td></tr>
          <tr><td>Margen</td><td>${pct(st.m0)}</td><td class="hi${low ? ' warn' : ''}">${pct(st.m1)}</td></tr>
          <tr><td>Ganancia / caja</td><td>${money(st.g0)}</td><td class="hi${low ? ' warn' : ''}">${money(st.g1)}</td></tr>
        </tbody>
      </table>
      <div>
        <div class="mbar" title="Margen antes vs especial">
          <i class="b0" style="width:${w0}%"></i><i class="b1${st.m1 < 0.1 ? ' low' : ''}" style="width:${w1}%"></i>
          <span class="fl" style="left:${flx}%" title="Margen mínimo ${pct(fl)}"></span>
        </div>
        <div class="mbar-l"><span>margen ${pct(st.m0, 0)} → ${pct(st.m1, 0)}</span><span>piso ${pct(fl, 0)}</span></div>
      </div>
      <div class="dates">${icon('calendar')}Vigencia <b>${fmtD(c.from)} – ${fmtD(c.to)}</b></div>`;
  }

  function adjHTML(c) {
    if (c.kind === 'group') {
      const low = groupMinMargin(c) < floorF() - 1e-9;
      return `
      <div class="adj"${c.open ? '' : ' hidden'}>
        <div class="adj-row"><label>Nombre</label><input type="text" data-f="title" maxlength="60" value="${esc(c.title || '')}"></div>
        <div class="adj-row"><label>En el PDF</label><input type="text" data-f="short" maxlength="220" value="${esc(groupShort(c))}"></div>
        <div class="adj-row"><label>Precio c/u $</label><input type="number" data-f="price" step="0.01" min="0" value="${c.S.toFixed(2)}"></div>
        <div class="adj-row"><label>Desde</label><input type="date" data-f="from" value="${esc(c.from)}"></div>
        <div class="adj-row"><label>Hasta</label><input type="date" data-f="to" value="${esc(c.to)}"></div>
        <p class="adj-warn" data-v="warn"${low ? '' : ' hidden'}>Algún producto queda abajo del margen mínimo (${pct(floorF(), 0)}).</p>
        ${c.items.some((i) => i.price <= c.S) ? '<p class="adj-warn">Algún producto normalmente cuesta igual o menos que este precio: en QuickBooks no se le cambia.</p>' : ''}
        <span data-v="off" hidden></span>
      </div>`;
    }
    const st = stats(c);
    const maxOff = Math.max(0, Math.floor(((c.P - minPrice(c.C)) / c.P) * 200) / 2);
    return `
      <div class="adj"${c.open ? '' : ' hidden'}>
        ${c.nx ? `<div class="adj-row"><label>Compra</label>
          <input type="number" data-f="nx" inputmode="numeric" min="1" max="24" step="1" value="${c.nx}">
          <span class="val" data-v="off">${pct(st.off)}</span></div>` : `<div class="adj-row"><label>Descuento</label>
          <input type="range" data-f="off" min="0" max="${maxOff}" step="0.5" value="${Math.min(maxOff, r2(st.off * 100))}">
          <span class="val" data-v="off">${pct(st.off)}</span></div>
        <div class="adj-row"><label>Especial $</label><input type="number" data-f="price" step="0.01" min="0" value="${c.S.toFixed(2)}"></div>`}
        <div class="adj-row"><label>Desde</label><input type="date" data-f="from" value="${esc(c.from)}"></div>
        <div class="adj-row"><label>Hasta</label><input type="date" data-f="to" value="${esc(c.to)}"></div>
        <p class="adj-warn" data-v="warn"${st.m1 < floorF() - 1e-9 ? '' : ' hidden'}>Abajo del margen mínimo (${pct(floorF(), 0)}).</p>
      </div>`;
  }

  function cardHTML(c, i) {
    return `
      <article class="card${c.pinned ? ' pinned' : ''}" data-uid="${c.uid}" style="animation-delay:${Math.min(i, 12) * 45}ms">
        ${photoHTML(c)}
        <button class="pin${c.pinned ? ' on' : ''}" data-act="pin" type="button" title="${c.pinned ? 'Soltar' : 'Fijar'}" aria-label="Fijar" aria-pressed="${c.pinned}">${icon('pin')}</button>
        <div class="cb">
          <div class="view">${viewHTML(c)}</div>
          ${adjHTML(c)}
          <div class="acts">
            <button data-act="swap" type="button">${icon('refresh')}Cambiar</button>
            <button data-act="adj" type="button">${icon(c.open ? 'check' : 'pencil')}${c.open ? 'Listo' : 'Ajustar'}</button>
            ${c.kind === 'single' ? `<button data-act="fmt" type="button">${icon('gift')}${c.nx ? 'Precio directo' : 'Compra N + 1'}</button>` : ''}
            ${c.kind !== 'combo' ? `<button data-act="add" type="button">${icon('plus')}Agregar producto</button>` : ''}
            ${c.kind !== 'combo' ? `<button data-act="qb" type="button">${icon('qb')}QuickBooks</button>` : ''}
          </div>
          <div class="grp-add" hidden>
            <input type="search" data-f="gq" placeholder="Buscar producto para el mismo precio" autocomplete="off">
            <div class="grp-res ord-results" role="listbox"></div>
          </div>
        </div>
      </article>`;
  }

  function paintCard(el, c) {
    el.querySelector('.ph-ov').innerHTML = overlayHTML(c);
    el.querySelector('.view').innerHTML = viewHTML(c);
  }

  function render(stagger, swappedUid) {
    const grid = $('#grid');
    if (!S.cards.length) {
      grid.innerHTML = `<div class="empty"><p class="hud">Listo</p>Dale <b>Generar</b> abajo para armar ${S.set.count} especiales con tus datos.</div>`;
      $('#summary').hidden = true;
      $('#saveBtn').disabled = true;
      $('#clientBtn').disabled = true;
      return;
    }
    if (swappedUid) {
      const i = S.cards.findIndex((c) => c.uid === swappedUid);
      const old = grid.children[i];
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(S.cards[i], 0);
      const el = tmp.firstElementChild;
      el.classList.add('swap');
      old.replaceWith(el);
      paintCard(el, S.cards[i]);
    } else {
      grid.innerHTML = S.cards.map((c, i) => cardHTML(c, stagger ? i : 0)).join('');
      $$('.card', grid).forEach((el, i) => paintCard(el, S.cards[i]));
      if (!stagger) $$('.card', grid).forEach((el) => (el.style.animation = 'none'));
    }
    renderSummary();
    $('#saveBtn').disabled = false;
    $('#clientBtn').disabled = false;
  }

  function renderSummary() {
    const n = S.cards.length;
    const all = S.cards.map(stats);
    const avg = (f) => all.reduce((a, s) => a + f(s), 0) / n;
    const cats = {};
    S.cards.forEach((c) => {
      const w = c.items[0].why;
      const k = c.kind === 'combo' ? 'Combo' : c.kind === 'group' ? 'Mismo precio' : c.items[0].st && w !== 'normal' ? WHY[w].label : c.items[0].cat;
      const col = { dormido: 'var(--morado)', lento: 'var(--oro)', bajando: '#ff7a66', gancho: 'var(--verde-2)' }[c.kind === 'combo' ? '' : w] || (c.kind === 'combo' ? 'var(--oro)' : '');
      cats[k] = cats[k] || { n: 0, col };
      cats[k].n++;
    });
    $('#summary').hidden = false;
    $('#qbAllWrap').hidden = !n;
    $('#summary').innerHTML = `
      <div class="kpi"><span class="lbl">Especiales</span><div class="kpi-v">${n}</div></div>
      <div class="kpi"><span class="lbl">Margen prom.</span><div class="kpi-v">${pct(avg((s) => s.m0), 0)}<span class="arrow">→</span><span class="down">${pct(avg((s) => s.m1), 0)}</span></div></div>
      <div class="kpi"><span class="lbl">Ahorro cliente</span><div class="kpi-v">${pct(avg((s) => s.off))}</div></div>
      <div class="kpi"><span class="lbl">Ganancia / caja</span><div class="kpi-v">${money(avg((s) => s.g1))}</div></div>
      <div class="kpi kpi-mix"><span class="lbl">Mezcla</span><div class="mix">${Object.entries(cats).map(([k, v]) => `<span${v.col ? ` style="--c:${v.col}"` : ''}>${esc(k)} <b>${v.n}</b></span>`).join('')}</div></div>`;
  }

  $('#qbAllBtn').addEventListener('click', () => { if (S.cards.length) openQb(S.cards); });

  // Acciones de tarjeta
  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const el = b.closest('.card');
    const c = S.cards.find((x) => x.uid === el.dataset.uid); if (!c) return;
    const act = b.dataset.act;
    if (act === 'pin') {
      c.pinned = !c.pinned;
      el.classList.toggle('pinned', c.pinned);
      b.classList.toggle('on', c.pinned);
      b.setAttribute('aria-pressed', c.pinned);
    } else if (act === 'swap') {
      if (c.pinned) { toast('Está fijada: suéltala para cambiarla'); return; }
      swapCard(c.uid);
    } else if (act === 'qb') {
      openQb([c]);
    } else if (act === 'fmt') {
      if (c.nx) unsetNx(c);
      else if (!setNx(c, nxFor(c))) { toast('Con el margen mínimo no alcanza para regalar una caja'); return; }
      c.tag = tagFor(c);
      render(false, c.uid);
    } else if (act === 'add') {
      const box = el.querySelector('.grp-add');
      box.hidden = !box.hidden;
      if (!box.hidden) box.querySelector('input').focus();
      return;
    } else if (act === 'pick') {
      const p = S.products.find((x) => String(x.id) === b.dataset.id); if (!p) return;
      if (addToCard(c, p)) { render(false, c.uid); toast('Agregado al mismo precio: ' + p.name); }
      return;
    } else if (act === 'rm') {
      removeFromCard(c, b.dataset.id);
      render(false, c.uid);
      return;
    } else if (act === 'adj') {
      c.open = !c.open;
      el.querySelector('.adj').hidden = !c.open;
      b.innerHTML = icon(c.open ? 'check' : 'pencil') + (c.open ? 'Listo' : 'Ajustar');
    }
  });

  $('#grid').addEventListener('input', (e) => {
    const inp = e.target.closest('[data-f]'); if (!inp) return;
    const el = inp.closest('.card');
    const c = S.cards.find((x) => x.uid === el.dataset.uid); if (!c) return;
    const f = inp.dataset.f;
    if (f === 'gq') {
      const q = normTxt(inp.value.trim()), res = el.querySelector('.grp-res');
      if (q.length < 2) { res.innerHTML = ''; return; }
      const words = q.split(/\s+/), inCard = new Set(c.items.map((i) => String(i.id)));
      const list = S.products.filter((p) => { const tx = normTxt(`${p.name} ${p.brand} ${p.id} ${p.upc}`); return !isCredito(p) && words.every((w) => tx.includes(w)); }).slice(0, 10);
      res.innerHTML = list.length ? list.map((p) => {
        const ok = p.price > 0 && p.cost > 0 && !inCard.has(String(p.id));
        return `<button type="button" data-act="pick" data-id="${esc(p.id)}"${ok ? '' : ' disabled'}>${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>${money(p.price)}${p.stock != null ? ' · stock ' + nfmt(p.stock) : ''}${inCard.has(String(p.id)) ? ' · ya está' : !(p.price > 0 && p.cost > 0) ? ' · sin precio o costo' : ''}</small></span></button>`;
      }).join('') : '<p class="data-info" style="padding:10px">Sin resultados</p>';
      return;
    }
    if (f === 'short') { c.shortTxt = inp.value.slice(0, 220); c.shortEdited = true; const m = el.querySelector('.view .g-short'); if (m) m.textContent = groupShort(c); return; }
    if (f === 'title') { c.title = inp.value.slice(0, 60); c.titleAuto = false; el.querySelector('.view .name').textContent = c.title; return; }
    if (c.kind === 'group' && f === 'price') {
      const v = parseFloat(inp.value); if (!(v > 0)) return;
      c.S = r2(v);
      c.tag = tagFor(c);
      el.querySelector('[data-v="warn"]').hidden = !(groupMinMargin(c) < floorF() - 1e-9);
      paintCard(el, c); renderSummary();
      return;
    }
    if (f === 'off') {
      c.S = r2(Math.max(psychUp(minPrice(c.C)), psychDown(c.P * (1 - parseFloat(inp.value) / 100))));
      if (c.S > c.P) c.S = c.P;
      el.querySelector('[data-f="price"]').value = c.S.toFixed(2);
    } else if (f === 'price') {
      const v = parseFloat(inp.value);
      if (!(v > 0)) return;
      c.S = r2(v);
      const st = stats(c);
      const r = el.querySelector('[data-f="off"]');
      r.value = Math.min(parseFloat(r.max), Math.max(0, st.off * 100));
    } else if (f === 'nx') {
      const n = Math.round(parseFloat(inp.value));
      if (!(n >= 1 && n <= 24)) return;
      setNx(c, n);
    } else if (f === 'from' || f === 'to') {
      c[f] = inp.value;
      c.customDates = true;
    }
    c.tag = tagFor(c);
    const st = stats(c);
    el.querySelector('[data-v="off"]').textContent = pct(st.off);
    el.querySelector('[data-v="warn"]').hidden = !(st.m1 < floorF() - 1e-9);
    paintCard(el, c);
    renderSummary();
  });

  /* ================= AJUSTES (drawer) ================= */
  const openSettings = () => { $('#settings').hidden = false; setTimeout(() => $('#settings [data-close]').focus(), 50); };
  const closeSettings = () => { $('#settings').hidden = true; $('#settingsBtn').focus(); };
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings' || e.target.closest('[data-close]')) closeSettings(); });
  $('#applyBtn').addEventListener('click', () => { closeSettings(); generate(); });
  // Punto en "Ajustes" cuando algo no está en su valor normal
  function updateSetBadge() {
    const s = S.set, allCats = $$('#catChips .chip').length;
    const custom = s.count !== 8 || s.mode !== 'equilibrado' || s.floor !== 5 || s.vendor || s.brand || !s.combo ||
      (Array.isArray(s.cats) && allCats && s.cats.length !== allCats);
    $('#setBadge').hidden = !custom;
  }

  /* ================= HISTORIAL (Firestore compartido) ================= */
  // Si la base no responde, no dejamos el botón colgado: cortamos a los 10 s.
  const withTimeout = (pr) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error('sin respuesta de la base compartida')), 10000))]);
  const Cloud = {
    async add(p) {
      if (!db) { const h = store.get(K_HIST, []); h.unshift(p); store.set(K_HIST, h.slice(0, 60)); S.hist = h; return; }
      const { id, ...rest } = p;
      await withTimeout(db.ref('propuestas/' + id).set(rest));
    },
    async del(id) {
      if (!db) { S.hist = store.get(K_HIST, []).filter((x) => x.id !== id); store.set(K_HIST, S.hist); return; }
      await withTimeout(db.ref('propuestas/' + id).remove());
    },
  };
  function initFirebase() {
    if (typeof firebase === 'undefined') { const b = $('#boot'); if (b) b.remove(); $('#gate').hidden = false; gateMsg('No cargó Firebase. Revisa tu internet y recarga.', 'err'); return; }
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.database();
    // La sesión queda guardada en el dispositivo (LOCAL): no vuelve a pedir contraseña hasta "Salir"
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    // Que el celular no borre la sesión guardada para ahorrar espacio
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* */ }
    // Mientras se revisa si ya había sesión se ve "Cargando…" (no la contraseña)
    const bootOff = () => { const b = $('#boot'); if (b) b.remove(); };
    setTimeout(() => { if ($('#boot')) { bootOff(); if ($('#app').hidden) showGate(); } }, 8000);
    auth.onAuthStateChanged(async (u) => {
      bootOff();
      const name = u && nameOf(u.email);
      if (name) { enterApp(name); return; }
      if (u) { await auth.signOut(); gateMsg('Esta cuenta no tiene acceso.', 'err'); }
      showGate();
    });
  }
  function listenHist() {
    try {
      if (unHist) unHist();
      const ref = db.ref('propuestas').orderByChild('ts').limitToLast(60);
      const onVal = ref.on('value',
        (snap) => {
          const arr = [];
          snap.forEach((c) => { arr.push({ id: c.key, ...c.val() }); });
          S.hist = arr.reverse();
          $('#histCount').textContent = S.hist.length ? S.hist.length : '';
          if (!$('#histModal').hidden) renderHist();
        },
        (err) => { console.warn('Historial', err); $('#histNote').textContent = 'No se pudo leer el historial compartido (' + (err.code || err.message) + ').'; }
      );
      unHist = () => ref.off('value', onVal);
    } catch (e) {
      console.warn('Historial', e);
    }
  }

  const openModal = (id) => { $(id).hidden = false; };
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $$('.modal').forEach((m) => (m.hidden = true)); if (!$('#settings').hidden) closeSettings(); } });

  $('#saveBtn').addEventListener('click', async () => {
    if (!S.cards.length) return;
    const btn = $('#saveBtn');
    btn.disabled = true;
    const all = S.cards.map(stats);
    try {
      await Cloud.add({
        id: Date.now().toString(36) + uid(), ts: Date.now(), by: S.who,
        from: S.set.from, to: S.set.to,
        m1: all.reduce((a, s) => a + s.m1, 0) / all.length,
        cards: S.cards.map(({ open, ...c }) => JSON.parse(JSON.stringify(c))),
      });
      toast('Propuesta guardada 💾 — ya la ve ' + PEOPLE.filter((p) => p !== S.who).join(', '));
    } catch (e) {
      toast('No se pudo guardar (' + (e.code || e.message) + ')');
    } finally {
      btn.disabled = false;
    }
  });

  function renderHist() {
    const hist = S.hist || [];
    $('#histList').innerHTML = hist.length ? hist.map((h) => {
      const thumbs = h.cards.slice(0, 5).map((c) => `<img src="${esc(c.items[0].photo)}" alt="">`).join('');
      const done = propEnQb(h);
      return `<div class="hist-item hist-prop${done ? ' done' : ''}" data-id="${esc(h.id)}">
        <div class="hi-top">
          <div class="hi-thumbs">${thumbs}</div>
          <div class="hi-txt"><b>${h.cards.length} especiales · ${fmtD(h.from)} – ${fmtD(h.to)}</b>
            ${fmtTs(h.ts)} · ${esc(h.by || '')} · margen ${pct(h.m1 || 0)}</div>
        </div>
        <div class="hi-acts">
          ${done ? '<span class="st sent">En QuickBooks ✓</span><button class="btn btn-ghost btn-sm" data-h="ver" type="button">Ver PDF</button><button class="btn-link sm" data-h="open" type="button">Copiar</button>'
            : '<button class="btn btn-oro btn-sm" data-h="open" type="button">Abrir</button>'}
          <button class="icon-btn" data-h="del" type="button" title="Quitar" aria-label="Quitar">${icon('trash')}</button>
        </div>
      </div>`;
    }).join('') : '<p class="data-info">Aún no hay propuestas guardadas.</p>';
  }
  $('#histBtn').addEventListener('click', () => { renderHist(); openModal('#histModal'); if (!qbAll.length) loadVigentes().then(renderHist); });
  $('#histList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const id = b.closest('.hist-item').dataset.id;
    const h = (S.hist || []).find((x) => x.id === id); if (!h) return;
    if (b.dataset.h === 'ver') {
      // Ya programada: solo vista previa del PDF (no se edita)
      sheetCards = h.cards.map((c) => ({ ...c, uid: uid() })); sheetCat = null; sheetReport = null; sheetTheme = null;
      $('#histModal').hidden = true;
      buildSheet(); openModal('#clientModal'); fitPages();
      return;
    }
    if (b.dataset.h === 'open') {
      if ($('#workspace').hidden) { toast('Conecta InSitu o carga el Excel primero'); return; }
      S.cards = h.cards.map((c) => ({ ...c, uid: uid(), open: false }));
      S.set.from = h.from; S.set.to = h.to;
      syncControls();
      render(true);
      $('#histModal').hidden = true;
    } else if (confirm('¿Quitar esta propuesta del historial? (nadie más la verá)')) {
      Cloud.del(id).then(renderHist).catch((err) => toast('No se pudo quitar (' + (err.code || err.message) + ')'));
    }
  });

  /* ================= VISTA CLIENTE (PDF de temporada) ================= */
  // PDF tamaño carta: hojas de especiales (9 por hoja) con colores de temporada, sin costos.
  // Las fotos pasan por /api/img (Vercel del catálogo) para poder meterlas al PDF.
  const IMG_PROXY = 'https://catalogo-mexiquense.vercel.app/api/img?u=';
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const PER_PAGE = 9;

  // Arte por temporada (SVG simple, colores de cada fiesta)
  const rng = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const SH = {
    star: (c) => `<path d="M0-10 2.9-3.1 10-3.1 4.3 1.2 6.5 8.1 0 4 -6.5 8.1 -4.3 1.2 -10-3.1 -2.9-3.1Z" fill="${c}"/>`,
    heart: (c) => `<path d="M0 8C-9 1-10-5-6-8-3-10 0-8 0-5 0-8 3-10 6-8 10-5 9 1 0 8Z" fill="${c}"/>`,
    snow: (c) => `<g stroke="${c}" stroke-width="1.6" stroke-linecap="round"><path d="M0-10V10M-8.7-5 8.7 5M-8.7 5 8.7-5"/><path d="M-3-7 0-4 3-7M-3 7 0 4 3 7"/></g>`,
    bat: (c) => `<path d="M0-2C-3-7-8-7-13-3-11-1-11 1-13 3-9 1-6 2-4 5-3 3-1 3 0 5 1 3 3 3 4 5 6 2 9 1 13 3 11 1 11-1 13-3 8-7 3-7 0-2Z" fill="${c}"/><circle cy="-3" r="2.4" fill="${c}"/>`,
    pumpkin: (c) => `<g><ellipse cx="-4" cy="2" rx="6" ry="7" fill="${c}"/><ellipse cx="4" cy="2" rx="6" ry="7" fill="${c}"/><ellipse cx="0" cy="2" rx="6" ry="7.5" fill="${c}" opacity=".85"/><rect x="-1" y="-8" width="2.4" height="5" rx="1" fill="#3a6b35"/></g>`,
    flower: (c) => `<g>${[0, 45, 90, 135].map((a) => `<ellipse rx="3" ry="9" fill="${c}" transform="rotate(${a})"/>`).join('')}<circle r="3.2" fill="#7a2e00"/></g>`,
    dot: (c) => `<circle r="4" fill="${c}"/>`,
    conf: (c) => `<rect x="-5" y="-2" width="10" height="4" rx="1" fill="${c}"/>`,
    sun: (c) => `<g><circle r="7" fill="${c}"/>${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="-1" y="-13" width="2" height="4" rx="1" fill="${c}" transform="rotate(${a})"/>`).join('')}</g>`,
    fish: (c) => `<path d="M-9 0C-5-6 4-6 7 0 4 6-5 6-9 0ZM7 0 12-5V5Z" fill="${c}"/>`,
    leaf: (c) => `<path d="M0-10C8-4 8 4 0 10-8 4-8-4 0-10Z" fill="${c}"/>`,
  };
  // avoid = [x1,y1,x2,y2]: zona libre (ej. el título) donde no cae decoración
  function scatter(w, h, shapes, colors, n, seed, sMin = 1.2, sMax = 3, avoid = null, op = [0.35, 0.5]) {
    const r = rng(seed); let out = ''; let tries = 0;
    for (let i = 0; i < n && tries < n * 20; tries++) {
      const sh = SH[shapes[Math.floor(r() * shapes.length)]];
      const c = colors[Math.floor(r() * colors.length)];
      const x = r() * w, y = r() * h, rot = Math.floor(r() * 360), sc = sMin + r() * (sMax - sMin), o = op[0] + r() * op[1];
      if (avoid && x > avoid[0] - 14 * sc && x < avoid[2] + 14 * sc && y > avoid[1] - 14 * sc && y < avoid[3] + 14 * sc) continue;
      i++;
      out += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot}) scale(${sc.toFixed(2)})" opacity="${o.toFixed(2)}">${sh(c)}</g>`;
    }
    return `<svg class="pat" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${out}</svg>`;
  }
  const THEMES = {
    ctd: { word: 'la Semana', label: 'CTD (sin temporada)', title: 'Especiales de la semana', bg: '#0F0D0A', ink: '#F6F2E9', acc: '#F2A31E', price: '#D8331B', pat: ['dot'], pc: ['#F2A31E', '#D8331B', '#2E8B3D'] },
    anio: { word: 'Año Nuevo', label: 'Año Nuevo / Reyes', title: 'Especiales de Año Nuevo', bg: '#14213d', ink: '#fff8e7', acc: '#f2c14e', price: '#c0392b', pat: ['star', 'conf'], pc: ['#f2c14e', '#e5e5e5', '#fca311'] },
    valentin: { word: 'San Valentín', label: 'San Valentín', title: 'Especiales de San Valentín', bg: '#7a1030', ink: '#fff0f3', acc: '#ff8fab', price: '#c9184a', pat: ['heart'], pc: ['#ff8fab', '#ffc2d1', '#ff4d6d'] },
    cuaresma: { word: 'Cuaresma', label: 'Cuaresma', title: 'Especiales de Cuaresma', bg: '#0f4c5c', ink: '#effaf8', acc: '#9ad1d4', price: '#0f4c5c', pat: ['fish', 'dot'], pc: ['#9ad1d4', '#e0fbfc', '#5fa8d3'] },
    primavera: { word: 'Primavera', label: 'Primavera / Pascua', title: 'Especiales de Primavera', bg: '#2d6a4f', ink: '#f1faee', acc: '#ffd6a5', price: '#bc4749', pat: ['flower', 'leaf'], pc: ['#ffd6a5', '#fdffb6', '#caffbf'] },
    mayo: { word: 'Mayo', label: 'Cinco de Mayo / Día de las Madres', title: 'Especiales de Mayo', bg: '#0b6e3a', ink: '#ffffff', acc: '#ffd23f', price: '#c1121f', pat: ['flower', 'dot'], pc: ['#ffffff', '#ffd23f', '#e63946'] },
    padre: { word: 'Día del Padre', label: 'Día del Padre', title: 'Especiales del Día del Padre', bg: '#0b3954', ink: '#f5f9ff', acc: '#ffb703', price: '#d62828', pat: ['star', 'dot'], pc: ['#ffb703', '#8ecae6', '#ffffff'] },
    verano: { word: 'Verano', label: 'Verano / 4 de julio', title: 'Especiales de Verano', bg: '#e85d04', ink: '#fffbeb', acc: '#ffd166', price: '#d00000', pat: ['sun', 'star'], pc: ['#ffd166', '#ffffff', '#ffba08'] },
    clases: { word: 'Regreso a Clases', label: 'Regreso a clases', title: 'Especiales de Regreso a Clases', bg: '#264653', ink: '#f8f5ee', acc: '#e9c46a', price: '#e76f51', pat: ['star', 'conf'], pc: ['#e9c46a', '#f4a261', '#2a9d8f'] },
    patrias: { word: 'Fiestas Patrias', label: 'Fiestas Patrias', title: 'Especiales Patrios', bg: '#006847', ink: '#ffffff', acc: '#ffffff', price: '#ce1126', pat: ['star', 'dot'], pc: ['#ffffff', '#ce1126'] },
    halloween: { word: 'Halloween', label: 'Halloween', title: 'Especiales de Halloween', bg: '#16110d', ink: '#fff4e6', acc: '#ff7518', price: '#ff7518', pat: ['bat', 'pumpkin', 'star'], pc: ['#ff7518', '#8338ec', '#ffbe0b'] },
    muertos: { word: 'Día de Muertos', label: 'Día de Muertos', title: 'Especiales de Día de Muertos', bg: '#2a1036', ink: '#fff5e1', acc: '#f7a300', price: '#e0457b', pat: ['flower', 'dot'], pc: ['#f7a300', '#e0457b', '#ffb703'] },
    gracias: { word: 'Acción de Gracias', label: 'Acción de Gracias', title: 'Especiales de Acción de Gracias', bg: '#5a2a0a', ink: '#fff5e6', acc: '#f4a259', price: '#bc3908', pat: ['leaf'], pc: ['#f4a259', '#e76f51', '#e9c46a'] },
    navidad: { word: 'Navidad', label: 'Navidad', title: 'Especiales de Navidad', bg: '#7c0a02', ink: '#fffaf0', acc: '#f4d35e', price: '#1e5631', pat: ['snow', 'star'], pc: ['#ffffff', '#f4d35e', '#9ee493'] },
  };
  const MONTH_THEME = ['anio', 'valentin', 'cuaresma', 'primavera', 'mayo', 'padre', 'verano', 'clases', 'patrias', 'halloween', 'muertos', 'navidad'];
  function rangeText(a, b) {
    const d1 = parseYmd(a), d2 = parseYmd(b);
    const y = d2.getFullYear();
    if (d1.getMonth() === d2.getMonth()) return `del ${d1.getDate()} al ${d2.getDate()} de ${MESES[d2.getMonth()]} de ${y}`;
    return `del ${d1.getDate()} de ${MESES[d1.getMonth()]}${d1.getFullYear() !== y ? ' de ' + d1.getFullYear() : ''} al ${d2.getDate()} de ${MESES[d2.getMonth()]} de ${y}`;
  }
  const proxied = (u) => (u ? IMG_PROXY + encodeURIComponent(u) : '');

  let sheetTheme = null;
  let sheetCards = null; // null = las tarjetas de la propuesta; si no, las que se pasen (ej. vigentes)
  let sheetCat = null; // catálogo completo después de las promos (solo al descargar el catálogo)
  let sheetReport = null; // informe de caducidades (pestaña Fechas)
  const sheetList = () => sheetCards || S.cards;
  // Descuento que se anuncia en la hoja (para ordenar y escoger los destacados)
  const sheetOff = (c) => (c.nx ? 1 / (c.nx + 1) : c.kind === 'group' ? groupOff(c) : stats(c).off);
  // Ordena de mayor a menor descuento y escoge cuántos van como banner para que no sobre espacio:
  // un banner ocupa una fila completa (3 lugares), uno "ancho" ocupa 2.
  function sheetLayout(list) {
    const sorted = [...list].sort((a, b) => sheetOff(b) - sheetOff(a));
    const n = sorted.length, left = (PER_PAGE - (n % PER_PAGE)) % PER_PAGE;
    let feat = Math.floor(left / 2), wide = left % 2;
    feat = Math.min(feat, n); wide = Math.min(wide, n - feat);
    return sorted.map((c, i) => ({ c, size: i < feat ? 'feat' : i < feat + wide ? 'wide' : '' }));
  }
  function buildSheet() {
    const head = $('#clientModal .modal-head h3');
    if (head) head.innerHTML = sheetReport ? 'Informe de caducidades <small>(sin costos)</small>' : 'Vista para clientes <small>(sin costos ni márgenes)</small>';
    if (sheetReport) { buildReport(); return; }
    const list = sheetList();
    const froms = list.map((c) => c.from).sort(), tos = list.map((c) => c.to).sort();
    const today = ymd(new Date());
    const from = froms[0] || today, to = tos[tos.length - 1] || today;
    const key = sheetTheme || MONTH_THEME[parseYmd(from).getMonth()];
    const t = THEMES[key] || THEMES.ctd;
    const foot = `<div class="pg-foot">Sujetos a disponibilidad ${esc(rangeText(from, to))}</div>`;
    const style = `--t-bg:${t.bg};--t-ink:${t.ink};--t-acc:${t.acc};--t-price:${t.price}`;
    const mes = MESES[parseYmd(from).getMonth()];

    let firstFeat = true;
    const card = ({ c, size }) => {
      const flag = size === 'feat' ? (firstFeat ? 'Mayor descuento' : 'Destacado') : '';
      if (size === 'feat') firstFeat = false;
      const st = stats(c);
      const grp = c.kind === 'group';
      const name = grp ? (c.title || groupTitle(c.items)) : c.items.map((i) => i.name).join(' + ');
      const brand = [...new Set(c.items.map((i) => i.brand).filter(Boolean))].join(' · ');
      const imgs = (grp ? c.items.slice(0, 4) : c.items).map((i) => `<img src="${esc(proxied(i.photo))}" crossorigin="anonymous" alt="">`).join('')
        + (grp && c.items.length > 4 ? `<span class="pc-more">+${c.items.length - 4}</span>` : '');
      const pack = c.kind === 'combo' ? 'Combo · ' + c.items.length + ' productos' : grp ? groupShort(c) : c.items[0].pack;
      return `<div class="pc${size ? ' pc-' + size : ''}">
        <div class="pc-ph${c.kind === 'combo' || grp ? ' combo' : ''}${grp ? ' grp' + (c.items.length > 2 ? ' g4' : '') : ''}">${imgs}<span class="pc-off">${c.nx ? `${c.nx}+1` : `-${Math.round((grp ? groupOff(c) : st.off) * 100)}%`}</span></div>
        <div class="pc-b">
          ${flag ? `<div class="pc-flag">${flag}</div>` : ''}
          <div class="pc-brand">${esc(brand)}</div>
          <div class="pc-name">${esc(!size && name.length > 42 ? name.slice(0, 40).trim() + '…' : name.length > 90 ? name.slice(0, 88).trim() + '…' : name)}</div>
          ${c.nx ? `<div class="pc-nx">Compra ${c.nx}, llévate 1 gratis</div><div class="pc-old eq">Precio ${money(c.P)} · equivale a ${money(c.S)} c/u</div>`
            : grp ? `<div class="pc-old">Antes desde ${money(Math.min(...c.items.map((i) => i.price)))}</div><div class="pc-new">${money(c.S)} <small>c/u</small></div>`
            : `<div class="pc-old">Antes ${money(c.P)}</div><div class="pc-new">${money(c.S)}</div>`}
          <div class="pc-pack${grp ? ' pc-short' + ((pack || '').length > 170 ? ' xl' : (pack || '').length > 105 ? ' lg' : '') : ''}">${esc(pack || '')}</div>
        </div></div>`;
    };
    // Hojas de 9 lugares (3×3): los banners van primero, en la hoja 1
    const lay = sheetLayout(list), slots = (x) => (x.size === 'feat' ? 3 : x.size === 'wide' ? 2 : 1);
    const chunks = [];
    let cur = [], used = 0;
    lay.forEach((x) => { if (used + slots(x) > PER_PAGE) { chunks.push(cur); cur = []; used = 0; } cur.push(x); used += slots(x); });
    if (cur.length) chunks.push(cur);
    const pages = [];
    for (let i = 0; i < chunks.length; i++) {
      pages.push(`<div class="pgwrap"><section class="pg pg-list" style="${style}">
        <header class="pl-head">${scatter(816, 170, t.pat, t.pc, 16, 3 + i, 1, 2)}
          <div><p class="cv-k">Central Trade Distribution</p><h2>${esc(t.title)}</h2><p class="pl-date">${esc(rangeText(from, to))}</p></div>
          <span class="pl-logo"><img src="ctd-logo.png" alt="CTD"></span>
        </header>
        <div class="pl-grid">${chunks[i].map(card).join('')}</div>
        ${foot}
      </section></div>`);
    }
    if (sheetCat) pages.push(...catalogPages(sheetCat, style, t, pages.length));
    $('#clientSheet').innerHTML = pages.join('');
    $$('#clientSheet .pc-ph img, #clientSheet .ct-ph img').forEach(fitImg);
    fitShorts();
    $('#themeSel').innerHTML = Object.entries(THEMES).map(([k, v]) => `<option value="${k}"${k === key ? ' selected' : ''}>${esc(v.label)}${k === MONTH_THEME[parseYmd(from).getMonth()] ? ` (${mes})` : ''}</option>`).join('');
    fitPages();
    return { from, to, key };
  }
  /* ================= CATÁLOGO DESCARGABLE =================
   * PDF para vendedores/clientes: primero las promociones activas (mismo diseño de especiales) y luego
   * todo el catálogo por departamento con foto, empaque y precio. Sin costos y sin productos CR- (crédito). */
  const CT = { deps: new Set(), stock: true, promos: true, vig: null, altas: null }; // deps vacío = todos los departamentos
  const depOn = (d) => !CT.deps.size || CT.deps.has(d);
  // Recién dados de alta (Costeo, últimos 30 días): salen aunque todavía no tengan existencia y van primero en el PDF
  const NUEVO_DIAS = 30;
  const altaDe = (p) => p.alta || (CT.altas && CT.altas[String(p.id)]) || 0;
  const esNuevoCat = (p) => { const t = altaDe(p); return t && Date.now() - t < NUEVO_DIAS * DAY; };
  function loadCatAltas() {
    if (CT.altas) return Promise.resolve();
    return cosCall('catalogo').then((d) => { CT.altas = {}; (d.items || []).forEach((x) => { if (x.alta) CT.altas[String(x.id)] = x.alta; }); }).catch(() => { CT.altas = {}; });
  }
  function catalogItems() {
    return S.products.filter((p) => p.price > 0 && !isCredito(p) && !EXCLUDE_CATS.includes(p.cat) && (!CT.stock || p.stock == null || p.stock > 0 || esNuevoCat(p)));
  }
  function catalogDeps() {
    const m = new Map();
    catalogItems().forEach((p) => { const d = p.cat || 'Otros'; m.set(d, (m.get(d) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  async function loadCatVig() {
    try { CT.vig = (await cosCall('vigentes')).list || []; } catch (e) { CT.vig = []; }
  }
  function renderCatalogo() {
    const deps = catalogDeps();
    const n = catalogItems().filter((p) => depOn(p.cat || 'Otros')).length;
    const when = S.fromCatAt || S.catAt || (S.meta && S.meta.at);
    $('#catInfo').innerHTML = S.products.length
      ? `${n} productos en ${CT.deps.size ? CT.deps.size : deps.length} ${(CT.deps.size || deps.length) === 1 ? 'departamento' : 'departamentos'}${when ? ` · precios al ${esc(fmtTs(when))}` : ''}. Sin costos y sin productos de crédito (CR-).${CT.vig ? ` · ${CT.vig.length} promociones vigentes` : ''}`
      : 'Cargando productos…';
    $('#catDeps').innerHTML = `<button type="button" class="${CT.deps.size ? '' : 'on'}" data-d="">Todos<small>${catalogItems().length}</small></button>`
      + deps.map(([d, c]) => `<button type="button" class="${CT.deps.has(d) ? 'on' : ''}" data-d="${esc(d)}">${esc(d)}<small>${c}</small></button>`).join('');
    $('#catStock').checked = CT.stock; $('#catPromos').checked = CT.promos;
    const nn = catalogItems().filter((p) => esNuevoCat(p) && depOn(p.cat || 'Otros')).length;
    if (nn) $('#catInfo').innerHTML += ` · <b>${nn} ${nn === 1 ? 'producto nuevo' : 'productos nuevos'}</b> (van primero, en "Lo más nuevo")`;
    if (!CT.vig) loadCatVig().then(renderCatalogo);
    if (!CT.altas) loadCatAltas().then(renderCatalogo);
  }
  $('#catDeps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    const d = b.dataset.d;
    if (!d) CT.deps.clear(); else if (CT.deps.has(d)) CT.deps.delete(d); else CT.deps.add(d);
    renderCatalogo();
  });
  $('#catStock').addEventListener('change', (e) => { CT.stock = e.target.checked; renderCatalogo(); });
  $('#catPromos').addEventListener('change', (e) => { CT.promos = e.target.checked; });
  $('#catGo').addEventListener('click', async () => {
    const items = catalogItems().filter((p) => depOn(p.cat || 'Otros'));
    if (!items.length) { toast(S.products.length ? 'No hay productos con esos filtros' : 'Todavía se están cargando los productos'); return; }
    if (CT.promos && !CT.vig) await loadCatVig();
    if (!CT.altas) await loadCatAltas();
    vigData = CT.promos ? (CT.vig || []) : [];
    sheetCards = vigToCards(); sheetCat = items; sheetReport = null; sheetTheme = null;
    buildSheet(); openModal('#clientModal'); fitPages();
  });
  // Páginas del catálogo: departamentos en orden, 4 columnas; el título del departamento se repite si continúa
  function catalogPages(items, style, t, startIdx) {
    const byDep = new Map();
    const nuevos = items.filter(esNuevoCat).sort((a, b) => altaDe(b) - altaDe(a));
    if (nuevos.length) byDep.set('Lo más nuevo', nuevos);
    [...items].sort((a, b) => (a.cat || 'Otros').localeCompare(b.cat || 'Otros') || a.name.localeCompare(b.name))
      .forEach((p) => { const d = p.cat || 'Otros'; (byDep.get(d) || byDep.set(d, []).get(d)).push(p); });
    const COLS = 4, ROW = 206, HEAD = 46, AVAIL = 1056 - 116 - 70; // alto útil de la hoja
    const pages = [];
    let cur = [], used = 0;
    const flush = () => { if (cur.length) pages.push(cur); cur = []; used = 0; };
    byDep.forEach((list, d) => {
      for (let i = 0; i < list.length; i += COLS) {
        const row = list.slice(i, i + COLS), first = i === 0;
        const need = ROW + (first || !used ? HEAD : 0);
        if (used + need > AVAIL) flush();
        if (first || !used) { cur.push({ head: d, cont: !first }); used += HEAD; }
        cur.push({ row }); used += ROW;
      }
    });
    flush();
    const date = new Date(), dtxt = `${date.getDate()} de ${MESES[date.getMonth()]} de ${date.getFullYear()}`;
    const item = (p) => `<div class="ct-i">
        <div class="ct-ph">${p.photo ? `<img src="${esc(proxied(p.photo))}" crossorigin="anonymous" alt="">` : ''}${esNuevoCat(p) ? '<span class="ct-new">NUEVO</span>' : ''}</div>
        <div class="ct-n">${esc(p.name.length > 54 ? p.name.slice(0, 52).trim() + '…' : p.name)}</div>
        <div class="ct-f"><span class="ct-pk">${esc(p.pack || '')}</span><b class="ct-pr">${money(p.price)}</b></div>
      </div>`;
    return pages.map((blocks, k) => `<div class="pgwrap"><section class="pg pg-cat" style="${style}">
        <header class="pl-head ct-head">${scatter(816, 116, t.pat, t.pc, 10, 40 + startIdx + k, 0.8, 1.6)}
          <div><p class="cv-k">Central Trade Distribution</p><h2>Catálogo</h2><p class="pl-date">Precios al ${esc(dtxt)}</p></div>
          <span class="pl-logo"><img src="ctd-logo.png" alt="CTD"></span>
        </header>
        <div class="ct-body">${blocks.map((b) => (b.head ? `<h3 class="ct-dep">${esc(b.head)}${b.cont ? ' <small>(continúa)</small>' : ''}</h3>` : `<div class="ct-row">${b.row.map(item).join('')}</div>`)).join('')}</div>
        <div class="pg-foot">Precios por caja · sujetos a cambio y disponibilidad · Hoja ${startIdx + k + 1}</div>
      </section></div>`);
  }

  // Informe de caducidades: hojas carta por departamento, 12 renglones por hoja, con foto
  function buildReport() {
    const t = THEMES.ctd, style = `--t-bg:${t.bg};--t-ink:${t.ink};--t-acc:${t.acc};--t-price:${t.price}`;
    const rows = [...sheetReport.rows].sort((a, b) => a.dep.localeCompare(b.dep) || (a.d < b.d ? -1 : 1));
    const ROW = 62, HEAD = 40, AVAIL = 1056 - 116 - 80;
    const pages = []; let cur = [], used = 0, lastDep = '';
    rows.forEach((r) => {
      const needHead = r.dep !== lastDep || !used;
      if (used + ROW + (needHead ? HEAD : 0) > AVAIL) { pages.push(cur); cur = []; used = 0; }
      if (r.dep !== lastDep || !used) { cur.push({ head: r.dep, cont: r.dep === lastDep }); used += HEAD; }
      cur.push({ r }); used += ROW; lastDep = r.dep;
    });
    if (cur.length) pages.push(cur);
    const d = new Date(), dtxt = `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
    const line = (r) => {
      const p = fechProd(r.sku), ph = p && p.photo ? `<img src="${esc(proxied(p.photo))}" crossorigin="anonymous" alt="">` : '';
      const st = r.dias < 0 ? 'dead' : r.dias <= 30 ? 'hot' : r.dias <= 60 ? 'warm' : '';
      return `<div class="rp-r ${st}"><div class="rp-ph">${ph}</div>
        <div class="rp-n">${esc(r.nombre)}<small>${skuFech(r.sku) ? esc(skuFech(r.sku)) + ' · ' : ''}${r.dias < 0 ? `venció hace ${-r.dias} días` : `vence en ${r.dias} días`}${r.riesgo ? ' · no alcanza a venderse' : ''}</small></div>
        <div class="rp-d">${esc(fmtLong(r.d))}</div><div class="rp-q">${nfmt(cajasDe(r))}<small>cajas</small></div></div>`;
    };
    $('#clientSheet').innerHTML = pages.map((blocks, k) => `<div class="pgwrap"><section class="pg pg-cat" style="${style}">
        <header class="pl-head ct-head">${scatter(816, 116, t.pat, t.pc, 8, 70 + k, 0.8, 1.6)}
          <div><p class="cv-k">Central Trade Distribution</p><h2>Caducidades</h2><p class="pl-date">${esc(sheetReport.filtro)} · ${esc(dtxt)}</p></div>
          <span class="pl-logo"><img src="ctd-logo.png" alt="CTD"></span>
        </header>
        <div class="ct-body">${blocks.map((b) => (b.head ? `<h3 class="ct-dep">${esc(b.head)}${b.cont ? ' <small>(continúa)</small>' : ''}</h3>` : line(b.r))).join('')}</div>
        <div class="pg-foot">Hoja ${k + 1} de ${pages.length}</div>
      </section></div>`).join('');
    $$('#clientSheet .rp-ph img').forEach(fitImg);
    $('#themeSel').innerHTML = '';
    fitPages();
  }

  // Lista de nombres cortos de un grupo: se achica la letra hasta que quepan todos en la tarjeta
  function fitShorts() {
    $$('#clientSheet .pc-short').forEach((el) => {
      const box = el.closest('.pc-b');
      el.style.webkitLineClamp = 'unset'; el.style.display = 'block'; el.style.overflow = 'visible';
      let fs = parseFloat(getComputedStyle(el).fontSize);
      while (box.scrollHeight > box.clientHeight + 1 && fs > 7) { fs -= 0.5; el.style.fontSize = fs + 'px'; }
    });
  }
  // html2canvas ignora object-fit y estira las fotos: se calcula el tamaño exacto que cabe
  // en el recuadro sin deformarse (también agranda las fotos chicas)
  function fitImg(img) {
    const fit = () => {
      const box = img.parentElement, cs = getComputedStyle(box);
      const combo = box.classList.contains('combo');
      let bw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      let bh = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (combo) bw = (bw - 6) / 2;
      if (box.classList.contains('g4')) bh = (bh - 6) / 2; // grupo de 3+: dos filas de fotos
      if (!img.naturalWidth || !img.naturalHeight || bw <= 0 || bh <= 0) return;
      const k = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
      img.style.maxWidth = img.style.maxHeight = 'none';
      img.style.width = Math.round(img.naturalWidth * k) + 'px';
      img.style.height = Math.round(img.naturalHeight * k) + 'px';
    };
    if (img.complete) fit(); else img.addEventListener('load', fit, { once: true });
  }

  // Las hojas miden 816×1056 (carta a 96 dpi); en pantalla se escalan al ancho disponible
  function fitPages() {
    fitShorts(); // ya con la hoja visible se puede medir
    $$('#clientSheet .pgwrap').forEach((w) => {
      const k = Math.min(1, w.clientWidth / 816);
      const pg = w.firstElementChild;
      pg.style.transform = `scale(${k})`;
      w.style.height = 1056 * k + 'px';
    });
  }
  window.addEventListener('resize', () => { if (!$('#clientModal').hidden) fitPages(); });

  $('#clientBtn').addEventListener('click', () => { sheetCards = null; sheetCat = null; sheetReport = null; sheetTheme = null; buildSheet(); openModal('#clientModal'); fitPages(); });

  // Guardar como imagen (JPG por hoja): para WhatsApp o estados. En celular abre compartir.
  async function renderPages() {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await Promise.all($$('#clientSheet img').map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
    const out = [];
    for (const pg of $$('#clientSheet .pg')) {
      out.push(await window.html2canvas(pg, { scale: 2, useCORS: true, backgroundColor: null, width: 816, height: 1056, windowWidth: 816,
        onclone: (d) => { d.querySelectorAll('.pg').forEach((x) => { x.style.transform = 'none'; }); } }));
    }
    return out;
  }
  $('#imgBtn').addEventListener('click', async () => {
    const btn = $('#imgBtn'); btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Generando…';
    try {
      const canvases = await renderPages();
      const blobs = await Promise.all(canvases.map((cv) => new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9))));
      const list = sheetList(), d1 = list.length ? parseYmd(list.map((c) => c.from).sort()[0]) : new Date();
      const base = `${sheetReport ? 'Caducidades' : sheetCat ? 'Catalogo' : 'Especiales'}-CTD-${d1.getDate()}${MES[d1.getMonth()]}`;
      const files = blobs.map((b, i) => new File([b], `${base}${blobs.length > 1 ? '-' + (i + 1) : ''}.jpg`, { type: 'image/jpeg' }));
      if (window.matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ files, title: 'Especiales CTD' });
      } else {
        files.forEach((f) => download(f, f.name));
        toast(files.length > 1 ? `${files.length} imágenes guardadas` : 'Imagen guardada');
      }
    } catch (e) { if (e && e.name !== 'AbortError') toast('No se pudo generar la imagen (' + (e.message || e) + ')'); }
    finally { btn.disabled = false; btn.innerHTML = label; }
  });
  $('#themeSel').addEventListener('change', (e) => { if (sheetReport) return; sheetTheme = e.target.value; buildSheet(); });

  $('#pdfBtn').addEventListener('click', async () => {
    const btn = $('#pdfBtn'); btn.disabled = true;
    const label = btn.innerHTML; btn.textContent = 'Generando PDF…';
    try {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const pages = $$('#clientSheet .pg');
      // Espera las fotos; si alguna no carga, se queda el espacio en blanco
      await Promise.all($$('#clientSheet img').map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: 'letter' });
      for (let i = 0; i < pages.length; i++) {
        const canvas = await window.html2canvas(pages[i], {
          scale: 2, useCORS: true, backgroundColor: null, width: 816, height: 1056, windowWidth: 816,
          onclone: (d) => { d.querySelectorAll('.pg').forEach((p) => { p.style.transform = 'none'; }); },
        });
        if (i) doc.addPage();
        doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 612, 792);
      }
      if (sheetReport) {
        const d = new Date();
        download(doc.output('blob'), `Caducidades-CTD-${d.getDate()}${MES[d.getMonth()]}-${d.getFullYear()}.pdf`);
      } else if (sheetCat) {
        const d = new Date();
        download(doc.output('blob'), `Catalogo-CTD-${d.getDate()}${MES[d.getMonth()]}-${d.getFullYear()}.pdf`);
      } else {
        const froms = sheetList().map((c) => c.from).sort(), tos = sheetList().map((c) => c.to).sort();
        const d1 = parseYmd(froms[0]), d2 = parseYmd(tos[tos.length - 1]);
        download(doc.output('blob'), `Especiales-CTD-${d1.getDate()}${MES[d1.getMonth()]}-${d2.getDate()}${MES[d2.getMonth()]}-${d2.getFullYear()}.pdf`);
      }
      toast('PDF guardado');
    } catch (e) {
      toast('No se pudo generar el PDF (' + (e.message || e) + ')');
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  });


  /* ================= QUICKBOOKS =================
   * QuickBooks es el dueño de productos y precios (InSitu los copia cada hora). Los especiales
   * se programan aquí y el servidor (ctd-seven.vercel.app/api) cambia el precio en QuickBooks el
   * día que empieza y lo regresa al original el día después de que termina. */
  const QB_API = 'https://ctd-seven.vercel.app/api';
  const QB_STATUS = { programado: 'Programado', activo: 'Activo', terminado: 'Terminado', cancelado: 'Cancelado', omitido: 'No se regresó', vencido: 'Vencido' };
  let qbState = null, qbCards = [], qbMatches = {};

  async function qbCall(action, extra = {}) {
    if (!auth || !auth.currentUser) throw new Error('Vuelve a entrar a la IA');
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(QB_API + '/qb', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw Object.assign(new Error(d.error || `Error ${r.status}`), { code: d.code, data: d });
    return d;
  }

  async function openQb(cards) {
    qbCards = cards.filter((c) => c.kind === 'single' || c.kind === 'group');
    openModal('#qbModal');
    $('#qbStatus').innerHTML = '<p class="data-info">Revisando la conexión con QuickBooks…</p>';
    $('#qbPlan').hidden = true;
    $('#qbList').innerHTML = '';
    try { qbState = await qbCall('status'); } catch (e) { qbState = { connected: false, error: e.message }; }
    renderQbStatus();
    if (qbState.connected) {
      loadQbList();
      if (qbCards.length) planQb();
    }
  }

  function renderQbStatus() {
    const s = qbState || {};
    $('#qbEnv').textContent = s.env === 'production' ? '' : '(empresa de prueba)';
    if (!s.connected) {
      $('#qbStatus').innerHTML = `<p class="qb-msg">QuickBooks no está conectado${s.error ? ` (${esc(s.error)})` : ''}. Un administrador de QuickBooks tiene que autorizar la conexión una vez.</p>
        <button id="qbConnect" class="btn btn-oro" type="button">${icon('qb')}Conectar QuickBooks</button>`;
      $('#qbConnect').addEventListener('click', async () => {
        const t = await auth.currentUser.getIdToken();
        location.href = QB_API + '/qb-connect?t=' + encodeURIComponent(t);
      });
      return;
    }
    $('#qbStatus').innerHTML = `<p class="qb-msg ok">● Conectado a <b>${esc(s.company || 'QuickBooks')}</b>${s.connectedBy ? ` · lo conectó ${esc(s.connectedBy)}` : ''}</p>` +
      `<span class="qb-actions">${s.env !== 'production' ? '<button id="qbTest" class="btn btn-ghost btn-sm" type="button">Probar cambio de precio</button>' : ''}` +
      '<button id="qbDisc" class="btn btn-ghost btn-sm" type="button">Desconectar</button></span>';
    $('#qbDisc').addEventListener('click', async () => {
      if (!confirm('¿Desconectar QuickBooks? Los especiales programados no se aplicarán ni regresarán hasta que vuelvas a conectar.')) return;
      try { await qbCall('disconnect'); toast('QuickBooks desconectado'); qbState = { connected: false, env: s.env }; renderQbStatus(); $('#qbPlan').hidden = true; }
      catch (e) { toast('No se pudo desconectar: ' + e.message); }
    });
    const tb = $('#qbTest');
    if (tb) tb.addEventListener('click', async () => {
      tb.disabled = true; tb.textContent = 'Probando…';
      try { const d = await qbCall('selftest'); toast(d.ok ? `Prueba OK: ${d.name} ${money(d.before)} → ${money(d.test)} → ${money(d.after)}` : 'La prueba no salió: ' + JSON.stringify(d)); }
      catch (e) { toast('Falló la prueba: ' + e.message); }
      finally { tb.disabled = false; tb.textContent = 'Probar cambio de precio'; }
    });
  }

  // Programar: primero se busca cada producto en QuickBooks para que confirmes que es el correcto
  async function planQb() {
    const box = $('#qbPlan');
    box.hidden = false;
    // Cada producto de un grupo se programa como su propio especial (mismo precio y fechas)
    const ok = qbCards.filter((c) => !c.nx && c.kind !== 'combo').flatMap((c) => (c.kind === 'group'
      ? c.items.filter((it) => it.price > c.S).map((it) => ({ ...c, kind: 'single', items: [it], P: it.price, C: it.cost, grupo: c.uid, grupoTitulo: c.title || groupTitle(c.items), grupoCorto: groupShort(c) }))
      : [c]));
    const nx = qbCards.filter((c) => c.nx);
    box.innerHTML = '<p class="data-info">Buscando los productos en QuickBooks…</p>';
    try {
      const d = await qbCall('match', { items: ok.map((c) => ({ sku: c.items[0].id, upc: c.items[0].upc, name: c.items[0].name })) });
      qbMatches = d.matches || {};
    } catch (e) { box.innerHTML = `<p class="qb-msg">No se pudo buscar: ${esc(e.message)}</p>`; return; }
    const rows = ok.map((c, i) => {
      const it = c.items[0], m = qbMatches[it.id];
      return `<div class="qb-row${m ? '' : ' miss'}" data-i="${i}">
        <label class="qb-chk">${m ? `<input type="checkbox" checked data-i="${i}">` : ''}</label>
        <div class="qb-main"><b>${esc(it.name)}</b>
          <span>${m ? `En QuickBooks: ${esc(m.qbName)}${m.how !== 'id' ? ` <em>(encontrado por ${esc(m.how)}, revisa que sea el mismo)</em>` : ''}` : 'No lo encontré en QuickBooks'}</span></div>
        <div class="qb-prices">${m ? `<s>${money(m.price)}</s> → <b>${money(c.S)}</b>` : ''}<span>${fmtD(c.from)} – ${fmtD(c.to)}</span></div>
      </div>`;
    }).join('');
    const warn = [];
    if (nx.length) warn.push(`${nx.length} en formato "Compra N + 1": en QuickBooks solo se puede poner un precio, cámbialos a precio directo si los quieres programar.`);
    const diff = ok.filter((c) => { const m = qbMatches[c.items[0].id]; return m && Math.abs(m.price - c.P) >= 0.01; });
    if (diff.length) warn.push(`${diff.length} tienen en QuickBooks un precio distinto al de InSitu (${diff.map((c) => esc(c.items[0].name)).slice(0, 3).join(', ')}…). Al terminar se regresa al precio que tenga QuickBooks ese día.`);
    box.innerHTML = `<p class="lbl">Programar ${ok.length === 1 ? 'este especial' : 'estos especiales'}</p>${rows || '<p class="data-info">Nada que programar.</p>'}
      ${warn.filter(Boolean).map((w) => `<p class="qb-warn">${w}</p>`).join('')}
      <p class="data-info">El precio cambia en QuickBooks el día que empieza (a las ~4am) y regresa solo al terminar. InSitu lo recibe en su siguiente sincronización (cada hora).</p>
      ${ok.some((c) => qbMatches[c.items[0].id]) ? '<button id="qbDo" class="btn btn-oro" type="button">Programar en QuickBooks</button>' : ''}`;
    const go = $('#qbDo');
    if (go) go.addEventListener('click', async () => {
      const chosen = $$('#qbPlan .qb-chk input:checked').map((x) => ok[Number(x.dataset.i)]);
      if (!chosen.length) { toast('Marca al menos uno'); return; }
      if (!confirm(`¿Programar ${chosen.length} ${chosen.length === 1 ? 'especial' : 'especiales'} en QuickBooks? Cambia el precio para todos los clientes durante la vigencia.`)) return;
      go.disabled = true; go.textContent = 'Programando…';
      try {
        const d = await qbCall('schedule', { items: chosen.map((c) => { const m = qbMatches[c.items[0].id]; return { qbId: m.qbId, qbName: m.qbName, sku: c.items[0].id, name: c.items[0].name, special: c.S, regular: m.price, from: c.from, to: c.to, grupo: c.grupo || '', grupoTitulo: c.grupoTitulo || '', grupoCorto: c.grupoCorto || '' }; }) });
        loadVigentes();
        toast(`Programados: ${d.saved.length}${d.applied ? ` · ${d.applied} ya activos hoy` : ''}${d.errors.length ? ` · ${d.errors.length} con error` : ''}`);
        if (d.errors.length) box.insertAdjacentHTML('beforeend', d.errors.map((e) => `<p class="qb-warn">${esc(e.name)}: ${esc(e.error)}</p>`).join(''));
        else box.hidden = true;
        loadQbList();
      } catch (e) { toast('No se pudo programar: ' + e.message); }
      finally { go.disabled = false; go.textContent = 'Programar en QuickBooks'; }
    });
  }

  async function loadQbList() {
    const box = $('#qbList');
    box.innerHTML = '<p class="data-info">Cargando…</p>';
    try {
      const d = await qbCall('list');
      // Solo los que siguen vivos (programados / activos); los terminados quedan guardados para Resultados
      const vivos = d.list.filter((e) => ['programado', 'activo'].includes(e.status));
      const viejos = d.list.length - vivos.length;
      const lista = S.qbVerTodos ? d.list : vivos;
      box.innerHTML = (lista.length ? lista.map((e) => `<div class="qb-row st-${esc(e.status)}">
          <span class="qb-pill">${esc(QB_STATUS[e.status] || e.status)}</span>
          <div class="qb-main"><b>${esc(e.name || e.qbName)}</b><span>${fmtD(e.from)} – ${fmtD(e.to)} · ${esc(e.by || '')}${e.note ? ' · ' + esc(e.note) : ''}${e.lastError ? ' · ⚠ ' + esc(e.lastError) : ''}</span></div>
          <div class="qb-prices">${e.original != null ? `<s>${money(e.original)}</s> → ` : ''}<b>${money(e.special)}</b>
            ${['programado', 'activo'].includes(e.status) ? `<button class="btn-link" type="button" data-cancel="${esc(e.id)}">cancelar</button>` : ''}</div>
        </div>`).join('') : '<p class="data-info">No hay especiales activos ni programados en QuickBooks.</p>')
        + (viejos ? `<button type="button" class="btn-link sm" data-vertodos>${S.qbVerTodos ? 'ocultar terminados' : `ver terminados (${viejos})`}</button>` : '');
    } catch (e) { box.innerHTML = `<p class="qb-msg">${esc(e.message)}</p>`; }
  }
  $('#qbList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-vertodos]')) { S.qbVerTodos = !S.qbVerTodos; loadQbList(); return; }
    const b = e.target.closest('[data-cancel]'); if (!b) return;
    if (!confirm('¿Cancelar este especial? Si ya está activo, el precio regresa al original ahora mismo.')) return;
    b.disabled = true;
    try { await qbCall('cancel', { id: b.dataset.cancel }); toast('Especial cancelado'); loadQbList(); loadVigentes(); }
    catch (err) { toast('No se pudo cancelar: ' + err.message); b.disabled = false; }
  });

  // Regreso de Intuit después de autorizar (?qb=conectado / error / cancelado)
  (function qbReturn() {
    const sp = new URLSearchParams(location.search);
    const r = sp.get('qb'); if (!r) return;
    const msg = { conectado: 'QuickBooks conectado ✓', cancelado: 'Se canceló la conexión con QuickBooks', 'sin-acceso': 'Sin acceso: entra primero a la IA', 'faltan-llaves': 'Faltan las llaves de QuickBooks en Vercel', error: 'No se pudo conectar QuickBooks' }[r] || r;
    setTimeout(() => toast(msg + (sp.get('m') ? ': ' + sp.get('m') : '')), 1200);
    history.replaceState(null, '', location.pathname);
    if (r === 'conectado') setTimeout(() => { if (S.who) openQb([]); }, 1500);
  })();


  /* ================= COSTEO DE FACTURAS =================
   * Subes la factura → Claude la lee (api/costeo) → se empareja con tus productos (código del
   * proveedor aprendido, UPC o nombre) → ves costo antes/ahora, precio y margen, editables →
   * "Aplicar" cambia precio/costo y da de alta nuevos en QuickBooks (InSitu los recibe cada hora). */
  const COS_API = 'https://ctd-seven.vercel.app/api/costeo';
  const C = { head: null, lines: [], saved: false, applied: false, results: [], dup: null, busy: false, recibo: null, reciboNota: '', reciboBy: '', bodega: null };
  const CS = Object.assign({ target: 20, round: true }, store.get('ctdIA.costeoSettings', {}));
  const ALTA = { vendors: null, busy: false }; // proveedores de QuickBooks para dar de alta (no se guardan en el navegador)
  delete CS.down; // si el costo baja, el precio se queda (decisión de Oscar)

  async function cosCall(action, extra = {}) {
    if (!auth || !auth.currentUser) throw new Error('Vuelve a entrar a la IA');
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(COS_API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, ...extra }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw Object.assign(new Error(d.error || `Error ${r.status}`), { code: d.code, data: d });
    return d;
  }

  // ---- Archivo → imágenes JPEG (PDF por hoja con pdf.js; fotos reducidas) ----
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  async function fileToJpegs(file) {
    const toJpeg = (canvas) => canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await loadScript(PDFJS + 'pdf.min.js');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const out = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 12); i++) {
        const page = await pdf.getPage(i);
        const v1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(2.2, 1600 / v1.width) });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        out.push(toJpeg(cv));
      }
      return out;
    }
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return [toJpeg(cv)];
  }

  $('#cosFile').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    if (C.lines.length && !C.saved && !confirm('Hay una factura sin guardar. ¿Cargar otra de todos modos?')) return;
    C.busy = true; renderCosteo('Preparando la factura…');
    try {
      let images = [];
      for (const f of files) images = images.concat(await fileToJpegs(f));
      renderCosteo('Cargando la factura…');
      const d = await cosCall('parse', { images: images.slice(0, 12) });
      C.recibo = null; C.reciboNota = ''; C.bodega = null;
      await loadInvoice(d);
    } catch (err) {
      toast('No se pudo leer: ' + err.message);
      C.busy = false; renderCosteo();
    }
  });
  $('#cosNew').addEventListener('click', () => $('#cosFile').click());
  $('#cosHead').addEventListener('click', (e) => {
    if (e.target.closest('#cosBill')) {
      const b = e.target.closest('#cosBill'); b.disabled = true;
      crearBill({ costeoId: C.savedId }).then((r) => { if (r) { C.bill = r; renderCosteo(); } else b.disabled = false; });
      return;
    }
    if (!e.target.closest('#cosClose')) return;
    if (!C.saved && !confirm('Esta factura tiene cambios sin guardar. ¿Cerrarla de todos modos?\n\n(Cancelar y dale Guardar si los quieres conservar)')) return;
    Object.assign(C, { head: null, lines: [], saved: false, applied: false, results: [], dup: null, recibo: null, bodega: null, savedId: null });
    store.del(K_DRAFT); renderCosteo(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---- Emparejar renglones con tus productos ----
  const upcCore = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
  const sameUpc = (a, b) => { const x = upcCore(a), y = upcCore(b); if (!x || !y || x.length < 6 || y.length < 6) return false; return x === y || x === y.slice(0, -1) || y === x.slice(0, -1); };
  // Palabras que no distinguen un producto de otro (medidas, empaques, conectores)
  const STOPW = new Set(['oz', 'ml', 'lt', 'lts', 'lb', 'lbs', 'gr', 'grs', 'kg', 'ct', 'cj', 'cs', 'pk', 'pz', 'pcs', 'unds', 'und', 'caja', 'case', 'de', 'la', 'el', 'los', 'las', 'con', 'y', 'en', 'cr', 'lf']);
  const tokens = (s) => new Set(normTxt(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !/\d/.test(w) && !STOPW.has(w)));
  // Dice: 2·comunes / (total A + total B) — penaliza nombres con muchas palabras distintas
  // Cada nombre trae una palabra que el otro no (MANZANA vs MANGO, FRESA vs PIÑA): son productos distintos
  function otroProducto(a, b) {
    const A = tokens(a), B = tokens(b);
    return [...A].some((w) => !B.has(w)) && [...B].some((w) => !A.has(w)) && nameScore(a, b) < 0.95;
  }
  function nameScore(a, b) { const A = tokens(a), B = tokens(b); if (A.size < 2 || B.size < 2) return 0; let n = 0; A.forEach((w) => { if (B.has(w)) n++; }); return (2 * n) / (A.size + B.size); }
  // Tamaño/presentación: números del nombre (24/7OZ → 24, 7). Si los dos traen números, los del más
  // corto deben estar en el otro; si no, son presentaciones distintas (ej. 12/12 OZ vs 24/7 OZ)
  const sizeNums = (s) => new Set((normTxt(s).match(/\d+(?:\.\d+)?/g) || []).map((x) => String(parseFloat(x))));
  function sameSize(a, b) {
    const A = sizeNums(a), B = sizeNums(b);
    if (!A.size || !B.size) return true;
    const [small, big] = A.size <= B.size ? [A, B] : [B, A];
    return [...small].every((x) => big.has(x));
  }

  function matchLine(l, vmap) {
    const byCode = l.codigo_proveedor && vmap[String(l.codigo_proveedor).trim().replace(/[.#$/[\]\s]+/g, '_')];
    if (byCode) { const p = S.products.find((x) => String(x.id) === String(byCode.sku)); if (p) return { p, how: 'código del proveedor' }; }
    // Muchos proveedores usan como código el mismo número que está como código de barras en InSitu (ej. Cortes 1168)
    const cc = String(l.codigo_proveedor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cc.length >= 3) {
      const p = S.products.find((x) => String(x.upc || '').toLowerCase().replace(/[^a-z0-9]/g, '') === cc && sameSize(l.producto, x.name) && nameScore(l.producto, x.name) >= 0.34);
      if (p) return { p, how: 'código' };
    }
    if (l.upc) { const p = S.products.find((x) => sameUpc(x.upc, l.upc) || (x.ean && sameUpc(x.ean, l.upc))); if (p) return { p, how: 'UPC' }; }
    let best = null;
    const lineUpc = upcCore(l.upc).length >= 8;
    S.products.forEach((p) => {
      if (lineUpc && upcCore(p.upc).length >= 8) return; // los dos traen UPC y no coincide: es otro producto
      if (!sameSize(l.producto, p.name) || otroProducto(l.producto, p.name)) return;
      const s = nameScore(l.producto, p.name);
      if (s >= 0.7 && (!best || s > best.s)) best = { p, s };
    });
    return best ? { p: best.p, how: 'nombre', review: true } : null;
  }

  const priceFor = (cost) => { const raw = cost / (1 - CS.target / 100); return CS.round ? psychUp(raw) : r2(raw); };
  const marginOf = (price, cost) => (price > 0 ? (price - cost) / price : 0);

  // El precio se queda como está en el sistema: "precio nuevo" va en blanco y solo cambia si lo escribes.
  // Se aplica si cambió el costo (se actualiza en QuickBooks) o si escribiste un precio nuevo.
  // Productos que se venden por pieza: la factura trae la caja, QuickBooks lleva costo y precio de UNA pieza
  const cu = (l) => (l.pz > 1 ? r2(l.costo_caja / l.pz) : l.costo_caja);
  const PZ_KEY = 'ctdIA.porPieza'; // { sku: piezas por caja | 0 = se vende por caja } lo que se eligió a mano
  function piezasCaja(it) {
    const s = `${it.producto || ''} ${it.empaque || ''}`;
    const m = s.match(/\bcj\.?\s*(\d{1,3})\b/i) || s.match(/\bcaja\s*(?:de\s*)?(\d{1,3})\b/i) || s.match(/\b(\d{1,3})\s*(?:unds?|pzas?|piezas|pcs|ct)\b/i) || s.match(/(?:^|\s)(\d{1,3})\s*\/\s*\d/);
    return Number(it.unidades_por_caja) > 1 ? Number(it.unidades_por_caja) : m ? Number(m[1]) : 0;
  }
  function detectPieza(l) {
    const n = piezasCaja(l), local = store.get(PZ_KEY, {})[l.sku], srv = (C.pzMem || {})[String(l.sku || '').replace(/[.#$/[\]\s]+/g, '_')];
    const man = local != null ? local : srv; // lo que ya se eligió/aprendió en Costeo
    l.pzCaja = n;
    l.factPieza = 0;
    if (man != null && !l.nuevo) {
      // Se vende por pieza, pero esta factura ya viene en piezas (precio ≈ costo de una pieza, ej. Cortes: Mayonesa BB 320 a $1.63): no se divide
      const r = l.costo_antes > 0 ? l.costo_caja / l.costo_antes : 0;
      if (man > 1 && ((r > 0.6 && r < 1.6) || (l.precio_antes > 0 && l.costo_caja <= l.precio_antes * 1.2))) { l.pz = 0; l.pzSet = false; l.factPieza = man; return; }
      l.pz = man > 1 ? man : 0; l.pzSet = true; return;
    }
    if (n < 2) { l.pz = 0; return; }
    // Se vende por pieza si en InSitu es "Pieza" o si el costo de QuickBooks es ~ el de la caja entre las piezas
    const r = l.costo_antes > 0 ? l.costo_caja / l.costo_antes : 0;
    l.pz = !l.nuevo && (l.pack === 'Pieza' || (r > n * 0.6 && r < n * 1.4)) ? n : 0;
  }
  const qbIdOf = (l) => (l.qb && l.qb.qbId) || l.qbId || '';
  const creado = (l) => l.nuevo && !!l.qbId; // ya se dio de alta: los cambios siguientes son de precio/costo
  const effPrice = (l) => (l.precio_nuevo != null ? l.precio_nuevo : l.nuevo ? priceFor(cu(l)) : l.precio_antes);
  const priceChanged = (l) => l.precio_nuevo != null && !same2(l.precio_nuevo, l.precio_antes);
  // El costo SIEMPRE se actualiza si cambió (salvo que lo desmarques a mano); el precio solo si escribes uno nuevo
  function decide(l) {
    if (l.offManual) { l.aplicar = false; return; }
    if (l.nuevo && !creado(l) && l.rec && l.rec.estado === 'no') { l.aplicar = false; return; } // bodega dice que no llegó: no se da de alta
    if (l.nuevo) { l.aplicar = !creado(l) || priceChanged(l) || !same2(cu(l), l.costo_antes); return; }
    l.aplicar = priceChanged(l) || !same2(cu(l), l.costo_antes);
  }
  const same2 = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005;

  async function loadInvoice(d) {
    let vmap = {};
    try { const mm = await cosCall('map', { proveedor: d.proveedor }); vmap = mm.map || {}; C.pzMem = mm.pz || {}; } catch (e) { /* sin memoria */ }
    C.head = { proveedor: d.proveedor, factura: d.factura, fecha: d.fecha, total_factura: d.total_factura, total_calculado: d.total_calculado, mercancia: d.mercancia, cuadra: d.cuadra, flete: d.flete, creditos: d.creditos, otros_cargos: d.otros_cargos, dudas: d.dudas || [], modelo: d.modelo };
    C.lines = (d.items || []).map((it, i) => {
      const m = matchLine(it, vmap);
      const l = { i, ...it, precio_nuevo: null, costo_caja: r2(Number(it.costo_caja) || 0), duda: (d.dudas || []).filter((x) => x.renglon === i + 1).map((x) => x.nota).join(' ') };
      if (m) Object.assign(l, { sku: String(m.p.id), nombre: m.p.name, photo: m.p.photo, pack: m.p.pack, costo_antes: r2(m.p.cost || 0), precio_antes: r2(m.p.price || 0), how: m.how, review: !!m.review, nuevo: false });
      else Object.assign(l, { nuevo: true, alta: { name: cleanTitle(it.producto), sku: it.upc || '', barcode: it.upc || '', photo: '', ...altaGuess(it.producto) } });
      return l;
    });
    // Un producto ligado a dos renglones: se queda con el que coincide por código/UPC o el nombre más parecido; el otro queda para revisar
    const porSku = {};
    C.lines.filter((l) => !l.nuevo).forEach((l) => { (porSku[l.sku] = porSku[l.sku] || []).push(l); });
    Object.values(porSku).filter((g) => g.length > 1).forEach((g) => {
      const fuerte = (l) => !['nombre', 'parecido'].includes(l.how);
      const best = g.slice().sort((a, b) => fuerte(b) - fuerte(a) || nameScore(b.producto, b.nombre) - nameScore(a.producto, a.nombre))[0];
      g.filter((l) => l !== best && !fuerte(l) && norm(l.producto) !== norm(best.producto)).forEach((l) => {
        const sk = l.sku, nm = l.nombre;
        Object.assign(l, { nuevo: true, sku: '', nombre: '', how: '', review: false, costo_antes: null, precio_antes: null, duda: `se parecía a ${nm} (SKU ${sk}), pero ese ya está en otro renglón: búscalo y lígalo`, alta: { name: cleanTitle(l.producto), sku: l.upc || '', barcode: l.upc || '', photo: '', ...altaGuess(l.producto) } });
      });
    });
    C.saved = false; C.applied = false; C.results = []; C.dup = null; C.busy = false; C.savedId = null; C.bill = null;
    // UPC de la factura contra el SKU de QuickBooks (en InSitu muchos traen código interno, no UPC)
    const byUpc = C.lines.filter((l) => upcCore(l.upc).length >= 8 && (l.nuevo || l.how === 'nombre'));
    if (byUpc.length) {
      try {
        const r = await cosCall('lookup', { items: byUpc.map((l) => ({ sku: 'upc:' + l.i, upc: l.upc, name: '' })) });
        byUpc.forEach((l) => {
          const q = r.items['upc:' + l.i];
          if (!q || q.how !== 'sku') return;
          const p = S.products.find((x) => String(x.id) === String(q.qbId)) || S.products.find((x) => normTxt(x.name) === normTxt(q.qbName));
          if (!p) return;
          Object.assign(l, { nuevo: false, sku: String(p.id), nombre: p.name, photo: p.photo, pack: p.pack, costo_antes: r2(p.cost || 0), precio_antes: r2(p.price || 0), how: 'UPC en QuickBooks', review: false });
          delete l.alta;
        });
      } catch (e) { /* sigue con lo que hay */ }
    }
    await ligarNuevosEnQb();
    // Precio y costo reales de QuickBooks (el dueño) para los emparejados
    const matched = C.lines.filter((l) => !l.nuevo);
    if (matched.length) {
      try {
        const r = await cosCall('lookup', { items: [...new Map(matched.map((l) => [l.sku, { sku: l.sku, upc: l.upc, name: l.nombre }])).values()] });
        matched.forEach((l) => {
          const q = r.items[l.sku];
          if (q) { l.qb = q; l.precio_antes = q.price; if (q.cost) l.costo_antes = q.cost; } else l.qbMissing = true;
        });
      } catch (e) { toast('QuickBooks: ' + e.message); }
    }
    C.lines.forEach((l) => { detectPieza(l); decide(l); });
    try { C.dup = (await cosCall('dup', { proveedor: d.proveedor, factura: d.factura })).dup; } catch (e) { /* ok */ }
    if (!C.recibo && d.factura) {
      try { const r = (await cosCall('recibo_find', { proveedor: d.proveedor, factura: d.factura })).recibo; if (r && r.status === 'revisado') attachRecibo(r); } catch (e) { /* ok */ }
    }
    renderCosteo();
    window.scrollTo({ top: $('#cosHead').offsetTop - 80, behavior: 'smooth' });
  }
  // "Nuevos" que en realidad ya están en QuickBooks (dados de alta antes o aún sin llegar a InSitu): se ligan solos
  // si coincide el nombre exacto o el SKU/UPC (no por parecido, para no ligar mal)
  async function ligarNuevosEnQb() {
    C.lines.forEach((l) => { // dado de alta desde esta misma factura: ya tiene su Id
      if (l.nuevo && l.qbId) { Object.assign(l, { nuevo: false, sku: String(l.qbId), nombre: l.nombre || (l.alta && l.alta.name) || l.producto, how: 'dado de alta aquí', review: false }); delete l.alta; }
    });
    const ns = C.lines.filter((l) => l.nuevo);
    if (!ns.length) return;
    try {
      const r = await cosCall('lookup', { items: ns.map((l) => ({ sku: 'n' + l.i, upc: l.upc || (l.alta && l.alta.barcode) || '', name: (l.alta && l.alta.name) || cleanTitle(l.producto) })) });
      ns.forEach((l) => {
        const q = r.items['n' + l.i];
        if (!q || !q.active || !['sku', 'nombre'].includes(q.how)) return;
        const p = S.products.find((x) => String(x.id) === String(q.qbId));
        Object.assign(l, { nuevo: false, sku: String(q.qbId), nombre: q.qbName, photo: p ? p.photo : l.photo, pack: p ? p.pack : '', qb: q, costo_antes: q.cost, precio_antes: q.price, how: 'ya estaba en QuickBooks', review: false });
        delete l.alta; detectPieza(l);
      });
    } catch (e) { /* se quedan como nuevos */ }
    // Mismo producto con el nombre escrito un poco distinto (ej. sin "500 ML"): mismas palabras y misma presentación
    const mismo = (a, b) => { const A = tokens(a), B = tokens(b); return A.size >= 2 && A.size === B.size && [...A].every((w) => B.has(w)) && sameSize(a, b); };
    for (const l of C.lines.filter((x) => x.nuevo).slice(0, 15)) {
      const nm = (l.alta && l.alta.name) || l.producto;
      let hit = S.products.find((p) => !isCredito(p) && mismo(nm, p.name)), q = null;
      try {
        const r = await cosCall('qb_buscar', { q: [...tokens(nm)].slice(0, 3).join(' ') });
        const its = (r.items || []).filter((x) => x.active);
        q = its.find((x) => (hit ? x.qbId === String(hit.id) : mismo(nm, x.name))) || null;
        if (!hit && !q) { const par = its.find((x) => !otroProducto(nm, x.name) && nameScore(nm, x.name) >= 0.6); l.parecidoQb = par ? par.name : ''; }
      } catch (e) { /* sin QuickBooks: solo lo de InSitu */ }
      if (!hit && !q) continue;
      const id = String(q ? q.qbId : hit.id), p = hit || S.products.find((x) => String(x.id) === id);
      Object.assign(l, { nuevo: false, sku: id, nombre: q ? q.name : hit.name, photo: p ? p.photo : '', pack: p ? p.pack : '', how: 'ya estaba en QuickBooks', review: false, parecidoQb: '',
        qb: q ? { qbId: id, qbName: q.name, price: q.price, cost: q.cost, active: true, how: 'nombre' } : null, costo_antes: q ? q.cost : r2((p && p.cost) || 0), precio_antes: q ? q.price : r2((p && p.price) || 0) });
      delete l.alta; detectPieza(l); decide(l);
    }
  }
  const cleanTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 100);

  // ---- SKU CTD-#### en todos los productos: los que son solo número (6330, el de Cortes) → CTD-6330 ----
  const SKU = { r: null, all: false };
  function renderSku() {
    const box = $('#skuBox'), r = SKU.r; if (!box || !r) return;
    const ok = r.numero.filter((x) => !x.choca), malos = r.numero.filter((x) => x.choca);
    const lista = SKU.all ? ok : ok.slice(0, 15);
    box.innerHTML = `<p class="status">De <b>${r.total}</b> productos: <b>${r.ctd}</b> ya tienen CTD · <b>${r.numero.length}</b> tienen solo el número · <b>${r.vacio.length}</b> sin SKU · ${r.otroN} con otro código (UPC, etc.)</p>
      ${ok.length ? `<div class="sku-l">${lista.map((x) => `<div class="sku-r"><span>${esc(x.name)}</span><b>${esc(x.sku)} → ${esc(x.nuevo)}</b></div>`).join('')}</div>
        ${ok.length > 15 ? `<button type="button" class="btn-link sm" data-skuall>${SKU.all ? 'ver menos' : `ver los ${ok.length}`}</button>` : ''}
        <p class="status">Solo revisión: "1261" y "CTD-1261" pueden ser productos distintos, por eso no se cambian en automático.</p>` : '<p class="status">✓ No hay productos con SKU de solo número.</p>'}
      ${malos.length ? `<p class="qb-warn">${malos.length} no se pueden cambiar porque ese CTD ya lo tiene otro producto: ${malos.slice(0, 5).map((x) => esc(`${x.name} (${x.nuevo})`)).join(', ')}${malos.length > 5 ? '…' : ''}</p>` : ''}
      ${r.vacio.length ? `<details><summary class="status">${r.vacio.length} sin SKU (hay que ponerlo a mano)</summary><div class="sku-l">${r.vacio.slice(0, 200).map((x) => `<div class="sku-r"><span>${esc(x.name)}</span><b>código ${esc(x.id)}</b></div>`).join('')}</div></details>` : ''}
      <button id="skuRev" class="btn-link sm" type="button">volver a revisar</button>`;
  }
  $('#skuSec').addEventListener('click', async (e) => {
    if (e.target.closest('#skuRev')) {
      $('#skuBox').innerHTML = '<p class="status">Revisando productos en QuickBooks…</p>';
      try { SKU.r = await cosCall('sku_revision'); renderSku(); } catch (err) { $('#skuBox').innerHTML = `<p class="qb-warn">${esc(err.message)}</p><button id="skuRev" class="btn-link sm" type="button">intentar otra vez</button>`; }
      return;
    }
    if (e.target.closest('[data-skuall]')) { SKU.all = !SKU.all; renderSku(); return; }
    const go = e.target.closest('[data-skugo]'); if (!go) return;
    const ok = SKU.r.numero.filter((x) => !x.choca);
    if (!confirm(`¿Cambiar el SKU de ${ok.length} productos en QuickBooks?\n\nEjemplo: ${ok.slice(0, 3).map((x) => `${x.sku} → ${x.nuevo}`).join(', ')}\n\nInSitu los toma en su siguiente sincronización (Barcode).`)) return;
    go.disabled = true;
    let hechos = 0; const errores = [];
    for (let i = 0; i < ok.length; i += 40) {
      go.textContent = `Cambiando… ${Math.min(i + 40, ok.length)} de ${ok.length}`;
      try { const d = await cosCall('sku_poner_ctd', { ids: ok.slice(i, i + 40).map((x) => x.id) }); hechos += d.hechos.length; errores.push(...d.errores); } catch (err) { errores.push({ error: err.message }); break; }
    }
    alert(`Listo ✓ ${hechos} productos con CTD- en QuickBooks.${errores.length ? `\n\n${errores.length} no se cambiaron:\n` + errores.slice(0, 10).map((x) => `• ${x.name || x.id || ''}: ${x.error}`).join('\n') : ''}\n\nInSitu los toma en su siguiente sincronización.`);
    try { SKU.r = await cosCall('sku_revision'); renderSku(); } catch (err) { /* */ }
  });

  // ---- Pantalla ----
  const K_DRAFT = 'ctdIA.cosDraft';
  function cosDraftSave() {
    if (!C.lines.length) return;
    store.set(K_DRAFT, { at: Date.now(), who: S.who, c: { head: C.head, lines: C.lines.map((l) => ({ ...l, comp: null })), saved: C.saved, applied: C.applied, results: C.results, recibo: C.recibo, savedId: C.savedId, bodega: C.bodega, pzMem: C.pzMem } });
  }
  function cosDraftRestore() {
    if (C.lines.length || C.draftChecked) return;
    C.draftChecked = true;
    const d = store.get(K_DRAFT, null);
    if (!d || d.who !== S.who || !d.c || !Array.isArray(d.c.lines) || !d.c.lines.length || Date.now() - d.at > 3 * 864e5) return;
    if (d.c.saved) { store.del(K_DRAFT); return; } // ya está guardada: se abre desde la lista si se quiere
    Object.assign(C, d.c, { busy: false, dup: null });
    if (C.lines.some((l) => l.nuevo)) ligarNuevosEnQb().then(() => renderCosteo());
    toast(`Recuperé la factura que tenías abierta (${(C.head && C.head.proveedor) || ''} #${(C.head && C.head.factura) || ''})`);
  }
  function renderCosteo(busyMsg) {
    cosDraftRestore();
    $('#cosTarget').value = CS.target; $('#cosRound').checked = CS.round;
    if (busyMsg) { $('#cosInfo').innerHTML = `<span class="age old">⟳ ${esc(busyMsg)}</span>`; return; }
    $('#cosInfo').textContent = C.lines.length ? '' : 'Sube la factura del proveedor: se lee sola, se compara con tu costo y precio, y aplicas los cambios en QuickBooks.';
    renderCosPhotos();
    const has = C.lines.length > 0;
    $('#cosHead').hidden = !has; $('#cosKpis').hidden = !has;
    $('#cosApply').disabled = !has || C.applied || !C.lines.some((l) => l.aplicar && (!l.nuevo || l.alta));
    $('#cosSave').disabled = !has || C.saved;
    loadCosPend();
    if (!has) { $('#cosList').innerHTML = ''; loadCosRecent(); return; }
    cosDraftSave();
    if (!C.recentShown) { C.recentShown = true; loadCosRecent(); } // las facturas guardadas siempre se ven abajo
    const h = C.head;
    const cuadra = h.cuadra === true ? '<span class="pill ok">Cuadra</span>' : h.cuadra === false ? `<span class="pill bad">No cuadra: factura ${money(h.total_factura)} vs calculado ${money(h.total_calculado)}</span>` : '';
    $('#cosHead').innerHTML = `
      <div class="cos-h1"><div><p class="hud">Factura</p><h2>${esc(h.proveedor || 'Proveedor')}</h2>
        <p class="status">#${esc(h.factura || '—')} · ${esc(h.fecha || 'sin fecha')} · ${C.lines.length} renglones · total ${h.total_factura != null ? money(h.total_factura) : '—'}${h.flete ? ` · flete ${money(h.flete)}` : ''}${h.creditos ? ` · créditos ${money(h.creditos)}` : ''}</p>
        <button id="cosClose" class="btn btn-ghost btn-sm" type="button">✕ Cerrar factura</button>
        ${C.bill && C.bill.tipo !== 'bill' ? `<span class="pill ok">Orden QB ${esc(C.bill.doc || C.bill.id)} creada</span>` : ''}${C.savedId ? `<button id="cosBill" class="btn ${C.bill ? 'btn-ghost' : 'btn-oro'} btn-sm" type="button">Crear Orden QB</button>` : ''}
        ${PAUSA_QB ? '' : C.bill ? `<span class="pill ok">QuickBooks: ${C.bill.tipo === 'bill' ? 'Bill' : 'orden'} ${esc(C.bill.doc || C.bill.id)} ✓</span>` : C.savedId ? '<button id="cosBill" class="btn btn-oro btn-sm" type="button">Mandar a QuickBooks para recibir</button>' : ''}</div>${cuadra}</div>
      ${C.dup ? `<p class="qb-warn">⚠ Esta factura ya se guardó el ${fmtTs(C.dup.ts)} por ${esc(C.dup.by || '')}. Revisa antes de aplicar otra vez.</p>` : ''}
      ${C.bodega && !C.recibo ? `<div class="cos-bod"><p class="status">Revisada en bodega por <b>${esc(C.bodega.by || '')}</b> · ${fmtTs(C.bodega.at)}${C.bodega.nota ? ' · Nota: <b>' + esc(C.bodega.nota) + '</b>' : ''}</p>${(C.bodega.dif || []).length ? `<ul class="rec-falt">${C.bodega.dif.map((x) => `<li><b>${esc(EST[x.estado] || x.estado)}</b> · ${esc(x.producto)}${x.estado === 'parcial' ? ` — llegaron ${nfmt(x.recibido || 0)} de ${nfmt(x.cantidad)}` : ''}${x.nota ? ` · <i>${esc(x.nota)}</i>` : ''}</li>`).join('')}</ul>` : '<p class="status">Todo llegó completo.</p>'}</div>` : ''}
      ${C.recibo ? `<p class="status">Revisada en bodega${C.reciboBy ? ' por ' + esc(C.reciboBy) : ''}.${C.reciboNota ? ' Nota: <b>' + esc(C.reciboNota) + '</b>' : ''}</p>` : ''}
      ${C.applied ? '<p class="qb-msg ok">● Cambios aplicados en QuickBooks. InSitu los recibe en su siguiente sincronización (máx. 1 hora).</p>' : ''}`;
    const up = C.lines.filter((l) => !l.nuevo && cu(l) > (l.costo_antes || 0) + 0.005).length;
    const nuevos = C.lines.filter((l) => l.nuevo).length;
    const cambiosP = C.lines.filter((l) => !l.nuevo && l.aplicar && priceChanged(l)).length;
    $('#cosKpis').innerHTML = `
      <div class="kpi"><span class="lbl">Renglones</span><div class="kpi-v">${C.lines.length}</div></div>
      <div class="kpi"><span class="lbl">Costo subió</span><div class="kpi-v">${up}</div>${up ? '<button id="cosUpXls" type="button" class="btn-link sm">Descargar Excel</button>' : ''}</div>
      <div class="kpi"><span class="lbl">Cambios de precio</span><div class="kpi-v">${cambiosP}</div></div>
      <div class="kpi"><span class="lbl">Productos nuevos</span><div class="kpi-v">${nuevos}</div></div>`;
    $('#cosList').innerHTML = C.lines.map(lineCosHTML).join('');
  }

  // PDF (desde Facturas guardadas) de lo que subió de costo; "Precio nuevo" va vacío para escribirlo a mano
  async function pdfCostosSubieron(id) {
    toast('Armando el reporte…');
    const d = await cosCall('costos_subieron', { id });
    if (!d.rows.length) { toast('En esta factura ningún producto subió de costo'); return; }
    const rows = d.rows.map((x) => ({ ...x, dif: r2(x.nuevo - x.antes), p: x.antes ? (x.nuevo - x.antes) / x.antes : 0 })).sort((a, b) => b.p - a.p);
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(15, 13, 10); doc.rect(0, 0, W, 70, 'F');
    doc.setTextColor(242, 163, 30); doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text('CENTRAL TRADE DISTRIBUTION', 36, 26);
    doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.text('Productos que subieron de costo', 36, 50);
    doc.setTextColor(40, 40, 40); doc.setFontSize(11);
    doc.text(`${d.proveedor} · Factura #${d.factura}${d.fecha ? ' · ' + fmtLong(d.fecha) : ''}`, 36, 92);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(110, 110, 110);
    doc.text(`${rows.length} ${rows.length === 1 ? 'producto subió' : 'productos subieron'} · margen objetivo ${CS.target}% · ${fmtLong(ymd(new Date()))}`, 36, 108);
    doc.autoTable({
      startY: 120, margin: { left: 36, right: 36 },
      head: [['#', 'SKU', 'Producto', 'Cajas', 'Costo antes', 'Costo nuevo', 'Subió', '%', 'Precio actual', 'Margen con precio actual', `Sugerido ${CS.target}%`, 'Precio nuevo']],
      body: rows.map((x, i) => [i + 1, x.sku, x.nombre + (x.pz > 1 ? `\n(por pieza · ${x.pz} por caja)` : ''), nfmt(x.cajas), money(x.antes), money(x.nuevo), '+' + money(x.dif), pct(x.p), x.precio ? money(x.precio) : '—', x.precio ? pct(marginOf(x.precio, x.nuevo)) : '—', money(priceFor(x.nuevo)), '']),
      styles: { fontSize: 8.5, cellPadding: 5, valign: 'middle', lineColor: [225, 222, 215], lineWidth: 0.5 },
      headStyles: { fillColor: [15, 13, 10], textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center' },
      columnStyles: { 0: { cellWidth: 22, halign: 'right' }, 1: { cellWidth: 52 }, 3: { cellWidth: 38, halign: 'right' }, 4: { cellWidth: 56, halign: 'right' }, 5: { cellWidth: 56, halign: 'right', fontStyle: 'bold' }, 6: { cellWidth: 50, halign: 'right', textColor: [216, 51, 27], fontStyle: 'bold' }, 7: { cellWidth: 40, halign: 'right', textColor: [216, 51, 27], fontStyle: 'bold' }, 8: { cellWidth: 56, halign: 'right' }, 9: { cellWidth: 62, halign: 'right' }, 10: { cellWidth: 56, halign: 'right' }, 11: { cellWidth: 70, fillColor: [255, 248, 230] } },
      alternateRowStyles: { fillColor: [250, 248, 243] },
      didParseCell: (h) => { if (h.section === 'body' && h.column.index === 9) { const x = rows[h.row.index]; if (x.precio && marginOf(x.precio, x.nuevo) < CS.target / 100 - 1e-9) { h.cell.styles.textColor = [180, 83, 9]; h.cell.styles.fontStyle = 'bold'; } } },
    });
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(150, 150, 150); doc.text(`Hoja ${i} de ${pages}`, W - 36, doc.internal.pageSize.getHeight() - 18, { align: 'right' }); }
    download(doc.output('blob'), `Costos-subieron-${normTxt(d.proveedor || '').replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${String(d.factura || '').replace(/[^\w-]+/g, '')}.pdf`);
    toast('PDF de costos que subieron descargado');
  }

  // Excel de los productos que subieron de costo en esta factura
  $('#cosKpis').addEventListener('click', (e) => { if (e.target.closest('#cosUpXls')) excelCostosSubieron().catch((err) => toast('No se pudo: ' + err.message)); });
  async function excelCostosSubieron() {
    const h = C.head || {};
    const L = C.lines.filter((l) => !l.nuevo && cu(l) > (l.costo_antes || 0) + 0.005).map((l) => {
      const antes = r2(l.costo_antes || 0), nuevo = r2(cu(l)), d = r2(nuevo - antes), pz = l.pz > 1 ? l.pz : 1;
      return { sku: String(prodSrv(l).upc || '').trim() || skuDe(prodSrv(l)) || l.sku, prod: l.nombre || l.producto, fact: l.producto, cod: l.codigo_proveedor || l.upc || '', unidad: pz > 1 ? `Pieza (${pz} por caja)` : 'Caja',
        cant: Number(l.cantidad) || 0, antes, nuevo, d, p: antes ? d / antes : 0, impacto: r2(d * (Number(l.cantidad) || 0) * pz),
        pa: r2(l.precio_antes || 0), pn: r2(effPrice(l)), m0: l.precio_antes ? marginOf(l.precio_antes, antes) : null, m1: marginOf(effPrice(l), nuevo) };
    }).sort((a, b) => b.p - a.p);
    if (!L.length) { toast('Ningún producto subió de costo'); return; }
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Costos que subieron', { views: [{ state: 'frozen', ySplit: 5 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const cols = [['#', 5], ['SKU', 11], ['Producto', 40], ['Código / UPC', 16], ['Unidad', 16], ['Cajas', 8], ['Costo antes', 12], ['Costo nuevo', 12], ['Subió $', 11], ['Subió %', 10], ['Impacto factura', 14], ['Precio actual', 13], ['Precio nuevo', 13], ['Margen antes', 12], ['Margen nuevo', 12]];
    ws.columns = cols.map(([, w]) => ({ width: w }));
    ws.mergeCells(1, 1, 1, cols.length); ws.getCell(1, 1).value = 'PRODUCTOS QUE SUBIERON DE COSTO';
    ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: 'FFD8331B' } };
    ws.mergeCells(2, 1, 2, cols.length); ws.getCell(2, 1).value = `${h.proveedor || ''} · Factura #${h.factura || '—'} · ${h.fecha ? fmtLong(h.fecha) : ''}`;
    ws.getCell(2, 1).font = { bold: true, size: 12 };
    ws.mergeCells(3, 1, 3, cols.length); ws.getCell(3, 1).value = `${L.length} ${L.length === 1 ? 'producto subió' : 'productos subieron'} · impacto en esta factura ${money(L.reduce((a, x) => a + x.impacto, 0))} · margen objetivo ${CS.target}% · ${fmtLong(ymd(new Date()))}`;
    ws.getCell(3, 1).font = { size: 11, color: { argb: 'FF555555' } };
    const hr = ws.getRow(5);
    cols.forEach(([n], i) => { const c = hr.getCell(i + 1); c.value = n; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F0D0A' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; });
    hr.height = 30;
    const thin = { style: 'thin', color: { argb: 'FFD9D9D9' } };
    L.forEach((x, i) => {
      const r = ws.getRow(6 + i);
      [i + 1, /^\d+$/.test(String(x.sku)) ? Number(x.sku) : x.sku, x.prod, x.cod, x.unidad, x.cant, x.antes, x.nuevo, x.d, x.p, x.impacto, x.pa, x.pn, x.m0, x.m1].forEach((v, j) => { r.getCell(j + 1).value = v; });
      [7, 8, 9, 11, 12, 13].forEach((j) => { r.getCell(j).numFmt = '$#,##0.00'; });
      [10, 14, 15].forEach((j) => { r.getCell(j).numFmt = '0.0%'; });
      r.getCell(9).font = { bold: true, color: { argb: 'FFD8331B' } }; r.getCell(10).font = { bold: true, color: { argb: 'FFD8331B' } };
      if (x.p >= 0.1) r.getCell(10).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2DD' } };
      if (x.m1 < CS.target / 100 - 1e-9) { r.getCell(15).font = { bold: true, color: { argb: 'FFB45309' } }; r.getCell(15).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF1D6' } }; }
      for (let j = 1; j <= cols.length; j++) r.getCell(j).border = { top: thin, bottom: thin, left: thin, right: thin };
      r.getCell(3).alignment = { wrapText: true, vertical: 'middle' };
      if (i % 2) for (let j = 1; j <= cols.length; j++) if (!r.getCell(j).fill) r.getCell(j).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F5F0' } };
    });
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Costos-subieron-${normTxt(h.proveedor || '').replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${String(h.factura || '').replace(/[^\w-]+/g, '')}.xlsx`);
    toast('Excel de costos que subieron descargado');
  }

  // Foto: la del producto; si es nuevo, la del link que se escribió para darlo de alta
  const cosPhoto = (l) => (l.nuevo ? (l.alta && /^https?:\/\//.test(l.alta.photo || '') ? l.alta.photo.trim() : '') : l.photo || prodSrv(l).photo || '');
  const cosImg = (src) => (src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
  function lineCosHTML(l) {
    const img = cosImg(cosPhoto(l));
    const delta = l.nuevo ? 0 : cu(l) - (l.costo_antes || 0);
    const pctD = l.costo_antes ? delta / l.costo_antes : 0;
    const m1 = marginOf(effPrice(l), cu(l));
    const m0 = !l.nuevo && l.costo_antes ? marginOf(l.precio_antes, l.costo_antes) : null;
    const badges = [
      l.nuevo ? '<span class="pill new">NUEVO</span>' : '',
      l.pz > 1 ? `<span class="pill">se vende por pieza · ${l.pz} por caja</span>` : '',
      l.factPieza ? `<span class="pill">la factura ya viene en piezas (${l.factPieza} por caja)</span>` : '',
      !l.nuevo && delta > 0.005 ? `<span class="pill bad">▲ costo +${money(delta)} (${pct(pctD)})</span>` : '',
      !l.nuevo && delta < -0.005 ? `<span class="pill ok">▼ costo ${money(delta)} (${pct(pctD)})</span>` : '',
      m1 < CS.target / 100 - 1e-9 ? `<span class="pill warn">margen ${pct(m1)} &lt; ${CS.target}%</span>` : '',
      l.review ? '<span class="pill warn">encontrado por nombre: revisa</span>' : '',
      l.qb && l.qb.special ? `<span class="pill warn">especial activo hasta ${fmtD(l.qb.special.to)}: el precio se aplica al terminar</span>` : '',
      l.qbMissing ? '<span class="pill bad">no está en QuickBooks</span>' : '',
      l.duda ? `<span class="pill warn">revisa: ${esc(l.duda)}</span>` : '',
      l.rec && l.rec.estado === 'parcial' ? `<span class="pill warn">bodega: llegaron ${nfmt(l.rec.recibido || 0)} de ${nfmt(l.cantidad)}</span>` : '',
      l.rec && l.rec.estado === 'no' ? '<span class="pill bad">bodega: no llegó</span>' : '',
      l.rec && l.rec.estado === 'pendiente' ? '<span class="pill warn">bodega: pendiente</span>' : '',
      l.rec && l.rec.estado === '' ? '<span class="pill warn">bodega: sin revisar</span>' : '',
      l.rec && l.rec.caducidad ? `<span class="pill">vence ${esc(fmtLong(l.rec.caducidad))}</span>` : '',
      l.rec && l.rec.nota ? `<span class="pill warn">nota: ${esc(l.rec.nota)}</span>` : '',
      l.result ? (l.result.ok ? '<span class="pill ok">✓ aplicado</span>' : `<span class="pill bad">✗ ${esc(l.result.error)}</span>`) : '',
    ].join('');
    const nuevo = l.nuevo ? `
      <div class="cos-alta">
        <label class="field alta-n"><span>Nombre en QuickBooks</span><input data-a="name" value="${esc(l.alta.name)}"></label>
        <label class="field${skuAltaOk(l.alta.sku) ? '' : ' falta'}"><span>SKU (CTD-#### o número)</span><input data-a="sku" placeholder="CTD-#### o 5205" value="${esc(skuAltaOk(l.alta.sku) ? l.alta.sku : (l.alta.sku = ''))}"></label>
        <label class="field"><span>Código de barras (UPC) → Barcode 2</span><input data-a="barcode" inputmode="numeric" value="${esc(l.alta.barcode || '')}"></label>
        <label class="field${l.alta.cat ? '' : ' falta'}"><span>Categoría</span><select data-a="cat"><option value="">Elige…</option>${altaCats().map((c) => `<option${c === l.alta.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field${l.alta.brand ? '' : ' falta'}"><span>Marca</span><input data-a="brand" list="altaBrands" placeholder="Ej. La Costeña" value="${esc(l.alta.brand || '')}"></label>
        <label class="field${l.alta.vendorId ? '' : ' falta'}"><span>Proveedor (QuickBooks)</span><select data-a="vendorId"><option value="">${ALTA.vendors ? 'Elige…' : 'Cargando proveedores…'}</option>${(ALTA.vendors || []).map((v) => `<option value="${esc(v.id)}"${v.id === l.alta.vendorId ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label class="field${l.alta.units ? '' : ' falta'}"><span>Unidad (InSitu)</span>${unitSel('data-a="units"', l.alta.units || (l.alta.units = unitGuess(l)))}</label>
        <label class="field"><span>Foto (URL)</span><input data-a="photo" placeholder="https://…" value="${esc(l.alta.photo)}"></label>
        <button class="btn-link" type="button" data-link>¿Ya existe? buscar y ligar</button>
      </div>` : '';
    return `<article class="ol cos-l${l.aplicar ? '' : ' is-off'}" data-i="${l.i}">
      <div class="ol-ph">${img}</div>
      <div class="ol-main">
        <div class="ol-name">${esc(l.nuevo ? l.producto : l.nombre)}</div>
        <div class="meta">Factura: ${esc(l.producto)}${l.empaque ? ' · ' + esc(l.empaque) : ''}${l.upc ? ' · UPC ' + esc(l.upc) : ''}${l.codigo_proveedor ? ' · código ' + esc(l.codigo_proveedor) : ''}${!l.nuevo ? ` · SKU ${esc(l.sku)} · por ${esc(l.how)}` : ''}</div>
        <div class="cos-badges">${badges}</div>
        <div class="cos-grid">
          <span><small>Cant.</small><b>${nfmt(l.cantidad)}</b></span>
          <label><small>Costo factura${l.pz > 1 ? ' (caja)' : ''}</small><input type="number" step="0.01" inputmode="decimal" data-f="cost" value="${l.costo_caja.toFixed(2)}">${l.pz > 1 ? `<em class="m-antes" data-v="cu">${money(cu(l))} por pieza</em>` : ''}</label>
          ${l.pz > 1 ? `<label><small>Piezas por caja</small><input type="number" step="1" min="2" inputmode="numeric" data-f="pz" value="${l.pz}"></label>` : ''}
          <span><small>Costo antes${l.pz > 1 ? ' (pieza)' : ''}</small><b>${l.nuevo ? '—' : money(l.costo_antes || 0)}</b></span>
          <span><small>Precio actual${l.pz > 1 ? ' (pieza)' : ''}</small><b>${l.nuevo ? '—' : money(l.precio_antes)}</b></span>
          <label><small>Precio nuevo</small><input type="number" step="0.01" inputmode="decimal" data-f="price" placeholder="${l.nuevo ? money(priceFor(cu(l))) : money(l.precio_antes)}" value="${l.precio_nuevo != null ? l.precio_nuevo.toFixed(2) : ''}"></label>
          <span><small>Margen</small><b class="${m1 < CS.target / 100 - 1e-9 ? 'warn' : 'okc'}" data-v="m">${pct(m1)}</b>${m0 != null ? `<em class="m-antes">antes ${pct(m0)}</em>` : ''}</span>
          <span><small>Sugerido ${CS.target}%</small><b>${money(priceFor(cu(l)))}</b></span>
        </div>
        ${!(l.nuevo && creado(l)) && saboresDe(l.producto).length >= 2 ? '<button type="button" class="btn btn-oro btn-sm" data-mix>Separar en sabores</button> ' : ''}
        ${C.applied ? '' : `<button type="button" class="btn-link sm cos-pz" data-pz>${l.pz > 1 ? 'Se vende por caja, no por pieza' : `¿Lo vendes por pieza?${l.pzCaja > 1 ? ` (${l.pzCaja} por caja)` : ''}`}</button>`}
        ${nuevo}
        ${!l.nuevo ? '<button class="btn-link sm" type="button" data-link>¿Es otro producto? buscar y ligar</button>' : ''}
        ${!l.nuevo && qbIdOf(l) || !l.nuevo && l.sku ? `<button class="btn-link sm" type="button" data-comp>${l.comp ? 'Cerrar' : datosCompletos(l) ? `✓ ${esc(skuDe(prodSrv(l)))} · ${esc(prodSrv(l).cat)} · ${esc(prodSrv(l).brand)} · ${esc(prodSrv(l).units)} (editar)` : 'Completar categoría, marca y unidad'}</button>` : ''}
        ${l.comp ? `<div class="cos-alta">
          <label class="field"><span>Categoría</span><select data-c="cat"><option value="">Elige…</option>${altaCats().map((c) => `<option${c === l.comp.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span>Marca</span><input data-c="brand" list="altaBrands" value="${esc(l.comp.brand)}"></label>
          <label class="field"><span>Unidad (InSitu)</span>${unitSel('data-c="units"', l.comp.units)}</label>
          <label class="field"><span>SKU (CTD-####)</span><input data-c="sku" placeholder="CTD-####" value="${esc(l.comp.sku)}"></label>
          <label class="field"><span>UPC → Barcode 2</span><input data-c="barcode" inputmode="numeric" value="${esc(l.comp.barcode)}"></label>
          <label class="field"><span>Foto (URL)</span><input data-c="photo" placeholder="https://…" value="${esc(l.comp.photo)}"></label>
          <button class="btn btn-oro btn-sm" type="button" data-comp-save>Guardar en QuickBooks e InSitu</button>
        </div>` : ''}
      </div>
      <label class="cos-apply"><input type="checkbox" data-f="aplicar"${l.aplicar ? ' checked' : ''}${C.applied ? ' disabled' : ''}><span>${l.nuevo ? 'Dar de alta' : 'Aplicar'}</span></label>
    </article>`;
  }

  // Edición en vivo: costo/precio → margen
  $('#cosList').addEventListener('input', (e) => {
    const el = e.target.closest('.cos-l'); if (!el) return;
    const l = C.lines[Number(el.dataset.i)]; if (!l) return;
    const f = e.target.dataset.f, a = e.target.dataset.a;
    if (['cost', 'price', 'pz'].includes(f)) {
      if (l.result && l.result.ok) l.result = null;
      if (C.applied) { C.applied = false; $$('#cosList [data-f="aplicar"]').forEach((x) => { x.disabled = false; }); }
    }
    if (f === 'cost') { const v = parseFloat(e.target.value); if (v >= 0) { l.costo_caja = r2(v); decide(l); el.querySelector('[data-f="aplicar"]').checked = l.aplicar; const c = el.querySelector('[data-v="cu"]'); if (c) c.textContent = money(cu(l)) + ' por pieza'; } }
    else if (f === 'pz') { const v = Math.round(Number(e.target.value)); if (v > 1) { l.pz = v; l.pzSet = true; if (!l.nuevo) { const m = store.get(PZ_KEY, {}); m[l.sku] = v; store.set(PZ_KEY, m); } decide(l); clearTimeout(C.pzT); C.pzT = setTimeout(renderCosteo, 700); } }
    else if (f === 'price') { const v = parseFloat(e.target.value); l.precio_nuevo = v > 0 ? r2(v) : null; decide(l); el.querySelector('[data-f="aplicar"]').checked = l.aplicar; }
    else if (f === 'aplicar') { l.aplicar = e.target.checked; l.offManual = !e.target.checked; }
    else if (a) {
      l.alta[a] = e.target.value; if (a === 'photo') el.querySelector('.ol-ph').innerHTML = cosImg(cosPhoto(l));
      if (a === 'sku') e.target.closest('.field').classList.toggle('falta', !skuAltaOk(e.target.value));
      if (['cat', 'brand', 'vendorId', 'units'].includes(a)) e.target.closest('.field').classList.toggle('falta', !String(e.target.value).trim());
      if (a === 'vendorId') { const m = store.get('ctdIA.altaVendor', {}); m[normTxt(C.head.proveedor || '')] = e.target.value; store.set('ctdIA.altaVendor', m); }
    }
    const m1 = marginOf(effPrice(l), cu(l)), mv = el.querySelector('[data-v="m"]');
    mv.textContent = pct(m1); mv.className = m1 < CS.target / 100 - 1e-9 ? 'warn' : 'okc';
    el.classList.toggle('is-off', !l.aplicar);
    C.saved = false; $('#cosSave').disabled = false;
    $('#cosApply').disabled = C.applied || !C.lines.some((x) => x.aplicar);
    clearTimeout(C.draftT); C.draftT = setTimeout(cosDraftSave, 800);
  });
  // Completar categoría (QuickBooks + InSitu), marca, unidad, código y foto (InSitu) de un producto que ya existe
  $('#cosList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-comp],[data-comp-save]'); if (!b) return;
    const l = C.lines[Number(b.closest('.cos-l').dataset.i)]; if (!l) return;
    if (b.hasAttribute('data-comp')) {
      if (l.comp) { l.comp = null; renderCosteo(); return; }
      b.disabled = true; await Promise.all([loadUnits(true), loadVivo([qbIdOf(l) || l.sku], true)]); // InSitu y QuickBooks al momento
      const p = prodSrv(l);
      const ctdYa = ctdOk(p.qbSku) ? ctdFmt(p.qbSku) : ctdOk(p.upc) ? ctdFmt(p.upc) : ''; // el que ya tiene en QuickBooks (o en InSitu)
      const upcYa = p.ean || (!ctdYa && /^\d{8,14}$/.test(p.upc || '') ? p.upc : '');
      l.comp = { cat: p.cat && p.cat !== 'Otros' ? p.cat : altaGuess(l.producto).cat, brand: p.brand || altaGuess(l.producto).brand, units: p.units || unitGuess(l), sku: ctdYa, barcode: upcYa || l.upc || '', photo: '' };
      renderCosteo(); return;
    }
    const box = b.closest('.cos-alta');
    $$('[data-c]', box).forEach((x) => { l.comp[x.dataset.c] = x.value.trim(); });
    if (l.comp.sku && !skuAltaOk(l.comp.sku)) { alert(`"${l.comp.sku}" no es un SKU válido. Escríbelo así: CTD-1345 o solo el número (ej. 5205)`); return; }
    l.comp.sku = l.comp.sku ? ctdFmt(l.comp.sku) : '';
    b.disabled = true; b.textContent = 'Guardando…';
    try {
      const d = await cosCall('alta_completar', { qbId: qbIdOf(l) || l.sku, ...l.comp });
      if (/^https?:\/\//.test(l.comp.photo || '')) l.photo = l.comp.photo; // se ve ya; en InSitu queda en la siguiente sincronización
      const k = String(qbIdOf(l) || l.sku); ALTA.vivo = ALTA.vivo || {}; ALTA.vivo[k] = { ...(ALTA.vivo[k] || {}), qbSku: l.comp.sku || (ALTA.vivo[k] || {}).qbSku, cat: l.comp.cat, brand: l.comp.brand, units: l.comp.units }; // lo recién guardado
      alert(`Listo ✓${d.qbSku ? ` · SKU ${d.qbSku} en QuickBooks` : ''}${d.qbCat ? ` · categoría "${d.qbCat}" en QuickBooks` : ''}${d.insitu ? ' · en InSitu se pone en la siguiente sincronización (máx. 1 hora)' : ''}`);
      l.comp = null; renderCosteo();
    } catch (err) { alert('No se pudo guardar:\n\n' + err.message); b.disabled = false; b.textContent = 'Guardar en QuickBooks e InSitu'; }
  });
  // Pallet mixto ("PEÑAFIEL 600 ML MIX - 1 PALLET (14 TWIST LIMON, 14 MANZANITA, …)") → un renglón por sabor
  function saboresDe(texto) {
    const s = String(texto || '');
    const dentro = (s.match(/\(([^)]*\d[^)]*)\)/) || [])[1] || (s.includes(',') ? s : '');
    const out = [];
    dentro.replace(/(\d{1,4})\s*(?:x\s*)?([A-ZÁÉÍÓÚÑa-záéíóúñ][^,;\n\d]*)/g, (m, n, nom) => { const nm = nom.replace(/\s+/g, ' ').trim(); if (nm && !/^(pallets?|cajas?|cs|ct|pz|pk|pack|piezas?|ml|oz|fl oz|lt|l|g|gr|kg|lb)\b/i.test(nm)) out.push({ n: Number(n), nom: nm }); return m; });
    // el mismo sabor dos veces (14 TWIST LIMON … 14 TWIST LIMON) = un solo renglón de 28
    const uno = {};
    out.forEach((x) => { const k = x.nom.toUpperCase(); if (uno[k]) uno[k].n += x.n; else uno[k] = { ...x }; });
    return Object.values(uno);
  }
  function baseMix(texto) {
    return String(texto || '').split(/\s+-\s+|\(/)[0].replace(/\b(mix|mixto|surtido|assorted|variety|variado)\b/ig, '').replace(/\s+/g, ' ').trim();
  }
  async function separarSabores(l) {
    const sab = saboresDe(l.producto);
    if (sab.length < 2) { alert('No encontré sabores con cantidades en este renglón (ej. "14 TWIST LIMON, 14 MANZANITA…").'); return; }
    const base = baseMix(l.producto), suma = sab.reduce((a, x) => a + x.n, 0);
    if (!confirm(`¿Separar en ${sab.length} productos?\n\n${sab.map((x) => `• ${x.n} × ${base} ${x.nom}`).join('\n')}\n\nCada uno con costo ${money(l.costo_caja)} por caja.${suma !== Number(l.cantidad) ? `\n\nOjo: suman ${suma} cajas y el renglón dice ${l.cantidad}.` : ''}`)) return;
    const toItem = (x) => ({ upc: x.upc || '', codigo_proveedor: x.codigo_proveedor || '', producto: x.producto, cantidad: x.cantidad, empaque: x.empaque || '', unidades_por_caja: x.unidades_por_caja ?? null, costo_caja: x.costo_caja, total_linea: x.total_linea ?? null, caducidad: x.caducidad || '' });
    const items = C.lines.flatMap((x) => (x === l ? sab.map((s) => ({ ...toItem(l), upc: '', producto: `${base} ${s.nom}`.toUpperCase(), cantidad: s.n, total_linea: r2(s.n * l.costo_caja) })) : [toItem(x)]));
    const head = { ...C.head };
    C.busy = true; renderCosteo('Separando y buscando cada sabor…');
    const keep = { savedId: C.savedId, recibo: C.recibo, reciboNota: C.reciboNota, bodega: C.bodega }; // misma factura: se guarda encima, no se duplica
    try { await loadInvoice({ ...head, items, dudas: [] }); } catch (err) { C.busy = false; renderCosteo(); throw err; }
    Object.assign(C, keep); renderCosteo();
  }
  $('#cosList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mix]'); if (!b) return;
    const l = C.lines[Number(b.closest('.cos-l').dataset.i)]; if (l) separarSabores(l).catch((err) => toast(err.message));
  });
  // Cambiar entre "por pieza" y "por caja" (se recuerda por producto)
  $('#cosList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pz]'); if (!b) return;
    const l = C.lines[Number(b.closest('.cos-l').dataset.i)]; if (!l) return;
    l.pzSet = true;
    if (l.pz > 1) l.pz = 0;
    else {
      const n = l.pzCaja > 1 ? l.pzCaja : Math.round(Number(prompt('¿Cuántas piezas trae la caja?', '12')) || 0);
      if (!(n > 1)) return;
      l.pz = n;
    }
    if (!l.nuevo) { const m = store.get(PZ_KEY, {}); m[l.sku] = l.pz; store.set(PZ_KEY, m); }
    decide(l); C.saved = false; renderCosteo();
  });
  // Ligar un "nuevo" a un producto que ya existe
  $('#cosList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-link]'); if (!b) return;
    const l = C.lines[Number(b.closest('.cos-l').dataset.i)];
    const q = prompt('Escribe parte del nombre, SKU o UPC del producto existente:', l.producto.split(' ').slice(0, 3).join(' '));
    if (!q) return;
    const words = normTxt(q).split(/\s+/).filter(Boolean);
    // En la lista de InSitu y directo en QuickBooks (ahí está el SKU, y los recién dados de alta que aún no llegan a InSitu)
    const prods = fechProds();
    const res = prods.filter((p) => { const t = normTxt(`${p.name} ${p.id} ${p.upc || ''} ${p.ean || ''}`); return words.every((w) => t.includes(w)); }).slice(0, 8);
    try {
      toast('Buscando en QuickBooks…');
      const r = await cosCall('qb_buscar', { q });
      (r.items || []).filter((x) => x.active).forEach((x) => {
        if (res.some((p) => String(p.id) === x.qbId)) return;
        const p = prods.find((y) => String(y.id) === x.qbId);
        res.unshift(p || { id: x.qbId, name: x.name, price: x.price, cost: x.cost, photo: '', pack: '', qbSku: x.sku, soloQb: true });
      });
    } catch (e) { /* solo lo de InSitu */ }
    // "0" = no existe: se da de alta como producto nuevo (ej. se ligó a otro sabor por error)
    const comoNuevo = () => {
      Object.assign(l, { nuevo: true, sku: '', nombre: '', how: '', review: false, qb: null, qbId: '', qbMissing: false, duda: '', result: null, pz: 0, costo_antes: null, precio_antes: null, precio_nuevo: null, offManual: false,
        alta: { name: cleanTitle(l.producto), sku: l.upc || '', barcode: l.upc || '', photo: '', ...altaGuess(l.producto) } });
      altaVendorDefault(); decide(l); C.applied = false; C.saved = false; renderCosteo();
      toast('Queda como producto nuevo: llena categoría, marca y proveedor y dale Aplicar');
    };
    if (!res.length) { if (confirm('No lo encontré en InSitu ni en QuickBooks.\n\n¿Darlo de alta como producto nuevo?')) comoNuevo(); return; }
    const lista = res.slice(0, 10);
    const pickN = prompt(lista.map((p, i) => `${i + 1}. ${p.name} (código ${p.id}${p.qbSku ? ', SKU ' + p.qbSku : ''}, ${money(p.price || 0)})${p.soloQb ? ' — en QuickBooks, aún no llega a InSitu' : ''}`).join('\n') + '\n0. No existe: darlo de alta como producto NUEVO\n\nEscribe el número:', '1');
    if (pickN != null && String(pickN).trim() === '0') { comoNuevo(); return; }
    const p = lista[Number(pickN) - 1]; if (!p) return;
    Object.assign(l, { nuevo: false, sku: String(p.id), nombre: p.name, photo: p.photo, pack: p.pack, costo_antes: r2(p.cost || 0), precio_antes: r2(p.price || 0), how: 'elegido a mano', review: false, qb: null, qbId: '', qbMissing: false, duda: '', result: null });
    delete l.alta;
    cosCall('lookup', { items: [{ sku: l.sku, upc: p.upc, name: p.name }] }).then((r) => { const qd = r.items[l.sku]; if (qd) { l.qb = qd; l.precio_antes = qd.price; if (qd.cost) l.costo_antes = qd.cost; } else l.qbMissing = true; detectPieza(l); decide(l); if (l.aplicar) C.applied = false; C.saved = false; renderCosteo(); }).catch(() => { detectPieza(l); decide(l); if (l.aplicar) C.applied = false; renderCosteo(); });
  });

  ['#cosTarget', '#cosRound'].forEach((id) => $(id).addEventListener('change', () => {
    CS.target = Math.min(80, Math.max(0, parseFloat($('#cosTarget').value) || 0)); CS.round = $('#cosRound').checked;
    store.set('ctdIA.costeoSettings', CS);
    if (!C.applied) C.lines.forEach(decide);
    renderCosteo();
  }));

  // ---- Aplicar en QuickBooks ----
  $('#cosApply').addEventListener('click', async () => {
    const sel = C.lines.filter((l) => l.aplicar);
    const changes = sel.filter((l) => (!l.nuevo || creado(l)) && qbIdOf(l) && !(l.result && l.result.ok)).map((l) => ({ qbId: qbIdOf(l), price: priceChanged(l) ? l.precio_nuevo : null, cost: same2(cu(l), l.costo_antes) ? null : cu(l) })).filter((c) => c.price != null || c.cost != null);
    const nNuevos = sel.filter((l) => l.nuevo && !creado(l)).length;
    if (nNuevos) {
      toast('Revisando que los nuevos no existan ya en QuickBooks…');
      await ligarNuevosEnQb();
      const ya = nNuevos - C.lines.filter((l) => l.aplicar && l.nuevo && !creado(l)).length;
      if (ya > 0) { C.saved = false; renderCosteo(); toast(`${ya} ${ya === 1 ? 'producto ya existía' : 'productos ya existían'} en QuickBooks: ${ya === 1 ? 'lo ligué' : 'los ligué'}. Revisa y dale Aplicar otra vez.`); return; }
      const dud = C.lines.filter((l) => l.aplicar && l.nuevo && !creado(l) && l.parecidoQb);
      if (dud.length && !confirm(`Ojo: en QuickBooks ya hay productos parecidos:\n\n${dud.map((l) => `• ${l.alta.name}\n   parecido a: ${l.parecidoQb}`).join('\n')}\n\n¿Darlos de alta de todos modos? (Cancelar para revisarlos con "¿Ya existe? buscar y ligar")`)) return;
    }
    // El mismo producto nuevo en dos renglones (ej. la factura lo repite): se da de alta una sola vez
    const altaKey = (l) => cleanTitle(l.alta.name || l.producto);
    const vistos = new Set(), repetidos = new Set();
    sel.filter((l) => l.nuevo && !creado(l)).forEach((l) => { const k = altaKey(l); if (vistos.has(k)) repetidos.add(l); else vistos.add(k); });
    const faltan = sel.filter((l) => l.nuevo && !creado(l) && !repetidos.has(l) && (!skuAltaOk(l.alta.sku) || !l.alta.cat || !String(l.alta.brand || '').trim() || !l.alta.vendorId));
    if (faltan.length) { toast(`Falta SKU (CTD-#### o número), categoría, marca o proveedor en ${faltan.length} ${faltan.length === 1 ? 'producto nuevo' : 'productos nuevos'}`); const el = $(`.cos-l[data-i="${faltan[0].i}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const creates = sel.filter((l) => l.nuevo && !creado(l) && !repetidos.has(l)).map((l) => ({ name: l.alta.name, sku: l.alta.sku, price: effPrice(l), cost: cu(l), photo: l.alta.photo, description: l.producto,
      barcode: String(l.alta.barcode || '').trim(), cat: l.alta.cat, brand: String(l.alta.brand || '').trim(), vendorId: l.alta.vendorId, units: l.alta.units || '' }));
    const sinPrecio = sel.filter((l) => l.nuevo && !creado(l) && !repetidos.has(l) && l.precio_nuevo == null).length;
    const nP = changes.filter((c) => c.price != null).length, nC = changes.filter((c) => c.cost != null).length;
    if (!changes.length && !creates.length) { toast('No hay cambios que aplicar'); return; }
    if (!confirm(`¿Aplicar en QuickBooks?\n\n• ${nP} cambios de precio\n• ${nC} cambios de costo\n• ${creates.length} productos nuevos${sinPrecio ? ` (${sinPrecio} sin precio escrito: se usa el sugerido de ${CS.target}%)` : ''}\n\nInSitu los recibe en su siguiente sincronización (máx. 1 hora).`)) return;
    const btn = $('#cosApply'); btn.disabled = true;
    try {
      const d = await cosCall('apply', { changes, creates, factura: `${C.head.proveedor} #${C.head.factura}` });
      C.results = d.results;
      d.results.forEach((r) => {
        const l = r.create ? C.lines.find((x) => x.nuevo && !creado(x) && x.alta && cleanTitle(x.alta.name) === cleanTitle(r.create)) : C.lines.find((x) => qbIdOf(x) === r.qbId && !(x.result && x.result.ok));
        if (l) {
          l.result = r; if (r.qbId && l.nuevo) l.qbId = r.qbId; if (r.note) l.duda = r.note;
          // Lo aplicado pasa a ser lo "de antes" (por si se corrige otra vez)
          if (r.ok) { l.costo_antes = cu(l); if (l.precio_nuevo != null && !(l.qb && l.qb.special)) l.precio_antes = l.precio_nuevo; else if (l.nuevo) l.precio_antes = effPrice(l); l.aplicar = false; }
          // los otros renglones del mismo producto nuevo quedan ligados al que se acaba de dar de alta
          if (r.create && r.ok && r.qbId) C.lines.filter((x) => x !== l && x.nuevo && !creado(x) && x.alta && cleanTitle(x.alta.name || x.producto) === cleanTitle(r.create)).forEach((x) => { x.qbId = r.qbId; x.result = r; x.aplicar = false; x.costo_antes = cu(x); x.precio_antes = l.precio_antes; });
        }
      });
      const bad = d.results.filter((r) => !r.ok).length;
      C.applied = !bad;
      toast(bad ? `${d.results.length - bad} aplicados · ${bad} con error (revisa los renglones)` : 'Aplicado en QuickBooks ✓');
      await saveCosteo(true);
    } catch (e) { toast('No se pudo aplicar: ' + e.message); }
    finally { renderCosteo(); }
  });

  async function saveCosteo(silent) {
    const f = { ...C.head, lines: C.lines.map((l) => ({ producto: l.producto, upc: l.upc, codigo_proveedor: l.codigo_proveedor, cantidad: l.cantidad, empaque: l.empaque, costo_caja: l.costo_caja, sku: l.sku || '', qbId: (l.qb && l.qb.qbId) || l.qbId || '', nombre: l.nombre || (l.alta && l.alta.name) || '', costo_antes: l.costo_antes ?? null, precio_antes: l.precio_antes ?? null, precio_nuevo: l.precio_nuevo, pz: l.pz || 0, pzSet: !!(l.pz > 1 || l.pzSet), aplicado: !!(l.result && l.result.ok), nuevo: !!l.nuevo, caducidad: l.caducidad || '' })) };
    try {
      const d = await cosCall('save', { factura: f, results: C.results, id: C.savedId || '' }); C.saved = true; C.savedId = d.id;
      if (C.recibo) { try { await cosCall('recibo_costeado', { id: C.recibo, costeoId: d.id }); } catch (e) { /* queda en la lista */ } C.recibo = null; loadCosPend(true); }
      const st = d.recibo && d.recibo.status;
      const BOD = RECIBO_ONLY[0];
      toast(st === 'enviado' ? `Factura guardada · le llegó a ${BOD} para revisar` : st === 'borrador' ? `Factura guardada · ${BOD} la está revisando` : 'Factura guardada ✓');
      loadCosRecent();
    }
    catch (e) { toast('No se pudo guardar: ' + e.message); }
    renderCosteo();
  }
  $('#cosSave').addEventListener('click', () => saveCosteo(false));

  async function loadCosRecent() {
    const box = $('#cosRecent');
    try {
      const d = await cosCall('list');
      const bod = (f) => f.bodega ? (f.bodega.dif ? `<span class="pill warn">bodega: ${f.bodega.dif} ${f.bodega.dif === 1 ? 'diferencia' : 'diferencias'}</span>` : '<span class="pill ok">bodega: todo llegó</span>')
        : f.bodegaStatus === 'borrador' ? `<span class="pill">bodega: por revisar</span>` : '';
      box.innerHTML = d.list.length ? d.list.map((f) => `<div class="hist-item" data-cid="${esc(f.id)}"><div class="hi-txt"><b>${esc(f.proveedor)} · #${esc(f.factura)}</b>${esc(f.fecha || '')} · ${f.lines} renglones · ${f.total_factura != null ? money(f.total_factura) : ''} · ${esc(f.by || '')} · ${fmtTs(f.ts)} ${bod(f)}</div><button class="icon-btn" data-c="del" type="button" title="Borrar factura" aria-label="Borrar factura">${icon('trash')}</button><button class="btn btn-ghost btn-sm" data-c="pdfup" type="button" title="PDF de los productos que subieron de costo">PDF costos</button><button class="btn btn-ghost btn-sm" data-c="open" type="button">Ver</button></div>`).join('')
        : '<p class="data-info">Todavía no hay facturas guardadas.</p>';
    } catch (e) { box.innerHTML = `<p class="data-info">${esc(e.message)}</p>`; }
  }
  $('#cosRecent').addEventListener('click', async (e) => {
    const pu = e.target.closest('[data-c="pdfup"]');
    if (pu) { pu.disabled = true; pdfCostosSubieron(pu.closest('.hist-item').dataset.cid).catch((err) => toast('No se pudo: ' + err.message)).finally(() => { pu.disabled = false; }); return; }
    const del = e.target.closest('[data-c="del"]');
    if (del) {
      const row = del.closest('.hist-item'), name = row.querySelector('b').textContent;
      if (!confirm(`¿Borrar la factura ${name}?\n\nSe quita de Costeo y de Recibo (con sus fechas de caducidad). Lo que ya se aplicó en QuickBooks NO se deshace.`)) return;
      try {
        const d = await cosCall('borrar', { id: row.dataset.cid });
        toast(`Factura borrada${d.recibos ? ' · también su recibo' : ''}${d.aplicados ? ` · ojo: ${d.aplicados} cambios ya estaban en QuickBooks` : ''}`);
        if (C.head && C.lines.length && C.saved) { C.head = null; C.lines = []; store.del(K_DRAFT); }
        cosPendAt = 0; loadCosRecent(); renderCosteo();
      } catch (err) { toast('No se pudo borrar: ' + err.message); }
      return;
    }
    const b = e.target.closest('[data-c="open"]'); if (!b) return;
    try {
      const { factura: f } = await cosCall('get', { id: b.closest('.hist-item').dataset.cid });
      C.head = { ...f, dudas: [] };
      C.lines = (f.lines || []).map((l, i) => ({ i, ...l, photo: (S.products.find((p) => String(p.id) === l.sku) || {}).photo, aplicar: false, result: l.aplicado ? { ok: true } : null, alta: l.nuevo ? { name: l.nombre, sku: l.upc, photo: '' } : null }));
      C.saved = true; C.applied = true; C.dup = null; C.recibo = null; C.reciboNota = ''; C.savedId = b.closest('.hist-item').dataset.cid;
      C.bodega = f.bodega || null; C.bill = f.po ? { ...f.po, tipo: 'po' } : f.bill ? { ...f.bill, tipo: 'bill' } : null;
      await ligarNuevosEnQb();
      renderCosteo();
      const conQb = C.lines.filter((l) => qbIdOf(l) || l.sku);
      if (conQb.length) {
        cosCall('lookup', { items: [...new Map(conQb.map((l) => [qbIdOf(l) || l.sku, { sku: qbIdOf(l) || l.sku, upc: l.upc, name: l.nombre }])).values()] }).then((r) => {
          conQb.forEach((l) => { const q = r.items[qbIdOf(l) || l.sku]; if (q) { l.qb = q; l.precio_antes = q.price; if (q.cost) l.costo_antes = q.cost; } });
          // Lo que quedó sin aplicar (ej. el costo que no se mandó) se marca para aplicarse
          C.lines.forEach((l) => { if (qbIdOf(l) || l.sku) decide(l); if (l.aplicar && l.result && l.result.ok) l.result = null; });
          if (C.lines.some((l) => l.aplicar)) C.applied = false;
          renderCosteo();
        }).catch(() => {});
      }
      window.scrollTo({ top: $('#cosHead').offsetTop - 80, behavior: 'smooth' });
    } catch (err) { toast(err.message); }
  });

  // Pega lo que revisó bodega a los renglones de Costeo (por posición, o por código / nombre si se subieron por separado)
  function attachRecibo(r) {
    const L = r.lines || [];
    C.recibo = r.id; C.reciboNota = r.nota || ''; C.reciboBy = r.updatedBy || r.by || '';
    const used = new Set();
    const find = (l) => {
      const k = L.findIndex((x, j) => !used.has(j) && ((x.codigo_proveedor && x.codigo_proveedor === l.codigo_proveedor) || normTxt(x.producto) === normTxt(l.producto)));
      return k >= 0 ? k : (L[l.i] && !used.has(l.i) && normTxt(L[l.i].producto) === normTxt(l.producto) ? l.i : -1);
    };
    C.lines.forEach((l) => {
      const k = find(l); if (k < 0) return;
      used.add(k);
      const x = L[k];
      l.rec = { estado: x.estado || '', recibido: x.recibido, caducidad: x.caducidad, nota: x.nota };
      if (l.nuevo && !creado(l) && x.estado === 'no') l.aplicar = false; // no llegó: no se da de alta
      // Bodega ya lo ligó a un producto y aquí no se encontró: se usa el de bodega
      const p = (l.nuevo || l.review) && x.sku && !/revisa/.test(x.how || '') ? S.products.find((q) => String(q.id) === String(x.sku)) : null;
      if (p) { Object.assign(l, { nuevo: false, sku: String(p.id), nombre: p.name, photo: p.photo, pack: p.pack, costo_antes: r2(p.cost || 0), precio_antes: r2(p.price || 0), how: 'bodega', review: false }); delete l.alta; decide(l); }
    });
  }

  // ---- Facturas que ya revisó bodega (Recibo) → se costean aquí con lo que llegó y sus caducidades ----
  let cosPendAt = 0;
  async function loadCosPend(force) {
    if (!force && Date.now() - cosPendAt < 20000) return;
    cosPendAt = Date.now();
    try {
      const list = ((await cosCall('recibo_list')).list || []).filter((f) => f.status === 'revisado');
      $('#cosPendWrap').hidden = !list.length;
      $('#cosPend').innerHTML = list.map((f) => `
        <div class="hist-item" data-rid="${esc(f.id)}"><div class="hi-txt"><b>${esc(f.proveedor)} · #${esc(f.factura)}</b>${f.lines} productos${f.parcial ? ` · ${f.parcial} llegaron menos` : ''}${f.no ? ` · ${f.no} no llegaron` : ''}${f.pendiente ? ` · ${f.pendiente} pendientes` : ''} · revisó ${esc(f.by || '')} · ${fmtTs(f.doneAt || f.updated)}</div>
          <button class="btn btn-oro btn-sm" data-c="cost" type="button">Costear</button></div>`).join('');
    } catch (e) { $('#cosPendWrap').hidden = true; }
  }
  $('#cosPend').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-c="cost"]'); if (!b) return;
    if (C.lines.length && !C.saved && !confirm('Hay una factura sin guardar. ¿Cargar esta de todos modos?')) return;
    C.busy = true; renderCosteo('Cargando la factura que revisó bodega…');
    try {
      const { recibo: r } = await cosCall('recibo_get', { id: b.closest('.hist-item').dataset.rid });
      const L = r.lines || [];
      await loadInvoice({ proveedor: r.proveedor, factura: r.factura, fecha: r.fecha, ...(r.head || {}), dudas: [],
        items: L.filter((l) => l.how !== 'agregado').map((l) => ({ upc: l.upc, codigo_proveedor: l.codigo_proveedor, producto: l.producto, cantidad: l.cantidad, empaque: l.empaque, unidades_por_caja: l.unidades_por_caja, costo_caja: l.costo_caja, total_linea: l.total_linea })) });
      attachRecibo(r);
      renderCosteo();
    } catch (err) { toast(err.message); C.busy = false; renderCosteo(); }
  });

  // ---- Alta de productos: categoría y marca (de InSitu) y proveedor (de QuickBooks) ----
  const altaCats = () => [...new Set(fechProds().map((p) => p.cat).filter((c) => c && c !== 'Otros'))].sort((a, b) => a.localeCompare(b));
  // Unidades que ya existen en InSitu (de los productos de este dispositivo o de la copia del catálogo del servidor)
  // Copia del catálogo del servidor (se renueva cada hora desde InSitu): unidades y lo que ya tiene cada producto
  async function loadVivo(codes, qb) {
    codes = [...new Set(codes.filter(Boolean).map(String))];
    if (!codes.length) return;
    try { const d = await cosCall('insitu_vivo', { codes, qb: !!qb }); ALTA.vivo = { ...(ALTA.vivo || {}), ...(d.items || {}) }; } catch (e) { /* se queda la copia */ }
  }
  async function loadUnits(force) {
    if ((ALTA.units && !force) || ALTA.unitsBusy) return;
    ALTA.unitsBusy = true;
    try {
      const items = (await cosCall('catalogo')).items || [];
      ALTA.units = [...new Set(items.map((p) => String(p.units || '').trim()).filter(Boolean))];
      ALTA.cat = {}; items.forEach((p) => { ALTA.cat[String(p.id)] = p; });
    } catch (e) { ALTA.units = ALTA.units || []; }
    ALTA.unitsBusy = false; renderCosteo();
  }
  const prodSrv = (l) => { const k = String(qbIdOf(l) || l.sku), v = (ALTA.vivo || {})[k], c = (ALTA.cat || {})[k]; return v ? { ...(c || {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x)) } : c || prodSrvLocal(l); };
  const prodSrvLocal = (l) => fechProds().find((x) => String(x.id) === String(qbIdOf(l) || l.sku)) || {};
  const skuDe = (p) => (ctdOk(p.qbSku) ? ctdFmt(p.qbSku) : ctdOk(p.upc) ? ctdFmt(p.upc) : '');
  const datosCompletos = (l) => { const p = prodSrv(l); return !!(p.cat && p.cat !== 'Otros' && p.brand && p.units && skuDe(p)); };
  const altaUnits = () => [...new Set([...fechProds().map((p) => String(p.units || '').trim()), ...(ALTA.units || [])].filter(Boolean))]
    .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0) || a.localeCompare(b));
  // Unidad de InSitu: por pieza → la de "each/pieza"; por caja → CaseN con las piezas de la factura
  function unitGuess(l) {
    const us = altaUnits();
    if (l.pz > 1) return us.find((u) => /each|pieza|unit|count/i.test(u)) || '';
    const n = l.pzCaja || piezasCaja(l);
    return n > 1 ? (us.find((u) => u.replace(/\s+/g, '').toLowerCase() === 'case' + n) || us.find((u) => /case|caja/i.test(u) && parseInt(u.replace(/\D/g, ''), 10) === n) || '') : '';
  }
  const unitSel = (attr, val) => `<select ${attr}><option value="">Elige…</option>${altaUnits().map((u) => `<option${u === val ? ' selected' : ''}>${esc(u)}</option>`).join('')}${val && !altaUnits().includes(val) ? `<option selected>${esc(val)}</option>` : ''}</select>`;
  // Siguiente SKU de CTD (CTD-####): el mayor que ya existe + 1 (sin repetir los que se están dando de alta)
  function nextCtd(extraUsados) {
    let max = 0;
    [...fechProds(), ...Object.values(ALTA.cat || {})].forEach((p) => [p.upc, p.sku].forEach((v) => { const m = String(v || '').match(/^CTD-(\d+)$/i); if (m) max = Math.max(max, +m[1]); }));
    [ALTA.ctdQb ? 'CTD-' + (+(ALTA.ctdQb.match(/\d+/) || [0])[0] - 1) : '', ...(extraUsados || [])].forEach((v) => { const m = String(v || '').match(/^CTD-?(\d+)$/i); if (m) max = Math.max(max, +m[1]); });
    return max ? 'CTD-' + (max + 1) : '';
  }
  const ctdOk = (v) => /^CTD\s*-?\s*\d{1,6}$/i.test(String(v || '').trim());
  // SKU para dar de alta: CTD-#### o solo el número (ej. 5205, 6330: así están algunos en InSitu). Son productos distintos.
  const skuAltaOk = (v) => ctdOk(v) || /^\d{2,6}$/.test(String(v || '').trim());
  const skuAltaFmt = (v) => (ctdOk(v) ? ctdFmt(v) : String(v || '').trim());
  const ctdFmt = (v) => { const m = String(v || '').trim().match(/^CTD\s*-?\s*(\d{1,6})$/i); return m ? 'CTD-' + m[1] : String(v || '').trim(); };
  // Siguiente CTD según QuickBooks (más seguro que la copia de InSitu); se guarda unos minutos
  async function loadCtdNext() {
    if (ALTA.ctdAt && Date.now() - ALTA.ctdAt < 120000) return;
    try { const d = await cosCall('ctd_next'); ALTA.ctdQb = d.next || ''; ALTA.ctdAt = Date.now(); } catch (e) { /* se usa la copia */ }
  }
  const ctdUsados = () => C.lines.map((l) => (l.alta && l.alta.sku) || (l.comp && l.comp.sku)).filter(Boolean);
  const altaBrands = () => [...new Set(fechProds().map((p) => String(p.brand || '').trim()).filter(Boolean))];
  // Adivina marca y categoría por el nombre de la factura (marca que ya existe en el catálogo)
  function altaGuess(producto) {
    const n = ' ' + normTxt(producto).replace(/[^a-z0-9]+/g, ' ') + ' ';
    const brand = altaBrands().filter((b) => normTxt(b).length > 2 && n.includes(' ' + normTxt(b).replace(/[^a-z0-9]+/g, ' ').trim() + ' ')).sort((a, b) => b.length - a.length)[0] || '';
    if (!brand) return { brand: '', cat: '' };
    const cnt = {};
    fechProds().filter((p) => p.brand === brand && p.cat && p.cat !== 'Otros').forEach((p) => { cnt[p.cat] = (cnt[p.cat] || 0) + 1; });
    return { brand, cat: Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '' };
  }
  async function altaVendors() {
    if (!C.lines.some((l) => l.nuevo) || ALTA.vendors || ALTA.busy) return;
    ALTA.busy = true;
    try { ALTA.vendors = (await cosCall('qb_vendors')).vendors || []; } catch (e) { ALTA.vendors = []; toast('No pude bajar los proveedores de QuickBooks: ' + e.message); }
    ALTA.busy = false;
    altaVendorDefault();
    renderCosteo();
  }
  // Proveedor de la factura: el último que se eligió para ese proveedor, o el que se llame igual
  function altaVendorDefault() {
    if (!ALTA.vendors || !C.head) return;
    const prov = normTxt(C.head.proveedor || ''), w = prov.split(/\s+/)[0] || '';
    const last = store.get('ctdIA.altaVendor', {})[prov];
    const v = (last && ALTA.vendors.find((x) => x.id === last))
      || ALTA.vendors.find((x) => normTxt(x.name) === prov) || (w.length > 2 && ALTA.vendors.find((x) => normTxt(x.name).split(/\s+/)[0] === w));
    if (v) C.lines.forEach((l) => { if (l.nuevo && l.alta && !l.alta.vendorId) l.alta.vendorId = v.id; });
  }
  // ---- Productos dados de alta: el servidor les pone categoría, marca, código y foto en InSitu cuando llegan de QuickBooks ----
  let cosPhotos = null;
  async function renderCosPhotos() {
    if (!$('#altaBrands')) document.body.insertAdjacentHTML('beforeend', '<datalist id="altaBrands"></datalist>');
    $('#altaBrands').innerHTML = altaBrands().slice(0, 800).map((b) => `<option value="${esc(b)}">`).join('');
    altaVendors(); if (C.lines.length) loadUnits();
    // Fotos y datos de InSitu al momento para los renglones ya ligados (una vez por factura)
    if (C.lines.length && C.vivoFor !== (C.savedId || (C.head && C.head.factura))) {
      C.vivoFor = C.savedId || (C.head && C.head.factura);
      loadVivo(C.lines.filter((l) => !l.nuevo).map((l) => qbIdOf(l) || l.sku)).then(() => renderCosteo());
    }
    return; // lo de abajo ya lo hace solo el servidor cada hora
    if (!Insitu.token()) return; // poner fotos en InSitu necesita la sesión de InSitu
    if (cosPhotos === null) { cosPhotos = {}; try { cosPhotos = (await cosCall('photos')).photos || {}; } catch (e) { cosPhotos = {}; } }
    const ready = Object.entries(cosPhotos).map(([qbId, f]) => ({ qbId, ...f, p: S.products.find((x) => String(x.id) === qbId || normTxt(x.name) === normTxt(f.name)) })).filter((x) => x.p);
    if (!ready.length || C.lines.length) return;
    $('#cosInfo').innerHTML += ` <button id="cosPhotoBtn" class="btn-link" type="button">Poner ${ready.length} ${ready.length === 1 ? 'foto' : 'fotos'} de productos nuevos en InSitu</button>`;
    $('#cosPhotoBtn').addEventListener('click', async () => {
      if (!confirm(`¿Poner la foto a ${ready.length} producto(s) en InSitu?`)) return;
      let ok = 0;
      for (const x of ready) {
        try {
          const r = await fetch(INSITU + '/products/bulk/operations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Insitu.token() }, body: JSON.stringify([{ code: String(x.p.id), name: x.p.name, photourl: x.photo }]) });
          if (r.ok) { ok++; await cosCall('photo_done', { qbId: x.qbId }); delete cosPhotos[x.qbId]; }
        } catch (e) { /* sigue */ }
      }
      toast(`${ok} de ${ready.length} fotos puestas en InSitu`);
      renderCosteo();
    });
  }


  /* ================= RECIBO DE MERCANCÍA =================
   * Jonathan (bodega) sube la factura que llegó → Claude la lee → la revisa producto por producto:
   * llegó / llegó menos / no llegó / pendiente, y su caducidad. Al terminar pasa a Costeo.
   * Caducidades = lotes en la IA (producto + fecha: la misma fecha suma, otra fecha es otro lote).
   * NO mueven inventario en InSitu ni en QuickBooks. */
  const RECIBO_ONLY = ['Jonathan'];
  const onlyView = () => ONLY[S.who] || null;
  const K_REC = 'ctdIA.recibo';
  const R = { rec: store.get(K_REC, null), cur: 0, busy: false, lotes: null, cat: null, list: null, saveT: null, sheet: null, lastDate: '' };
  const EST = { ok: 'Llegó', parcial: 'Llegó menos', no: 'No llegó', pendiente: 'Pendiente', '': 'Sin revisar' };
  const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const fmtLong = (s) => { if (!ymdOk(s)) return '—'; const d = parseYmd(s); return `${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`; };
  const daysTo = (s) => Math.round((parseYmd(s) - parseYmd(ymd(new Date()))) / 864e5);
  const skuKey = (s) => String(s || '').trim().replace(/[.#$/[\]\s]+/g, '_');
  const codeCore = (s) => normTxt(s).replace(/[^a-z0-9]/g, '');

  // Las fechas siguen a la existencia real: lo vendido sale primero de la fecha más vieja; si una fecha llega a 0
  // se cierra y ya no revive aunque llegue mercancía nueva (esa entra con su fecha por Recibo o en "Ponle fecha").
  async function ajustarLotes() {
    if (onlyView() || !S.products.length || !S.meta || S.meta.source !== 'InSitu' || !R.lotes) return;
    if (Date.now() - (S.meta.at || 0) > 12 * 36e5) return; // existencia muy vieja: mejor no ajustar
    const items = [];
    Object.entries(R.lotes).forEach(([sku, v]) => {
      const p = S.products.find((x) => skuKey(x.id) === sku);
      if (!p || p.stock == null) return;
      let left = Math.max(0, p.stock);
      Object.keys(v.fechas).sort().reverse().forEach((d) => { // nueva → vieja
        const f = v.fechas[d], queda = Math.min(f.q, left);
        left -= queda;
        if (queda < f.q - 0.01) { items.push({ sku, fecha: d, r: queda }); if (queda > 0) f.q = r2(queda); else delete v.fechas[d]; }
      });
    });
    if (!items.length) return;
    R.lotesV = (R.lotesV || 0) + 1;
    try { await cosCall('lote_ajuste', { items }); } catch (e) { /* se reintenta la próxima vez */ }
  }
  // Comparte la sesión de InSitu con el servidor para que actualice existencia y fechas solo, cada hora
  // (así Jonathan y Rocío siempre tienen la existencia, aunque nadie abra la IA)
  async function shareInsituSession() {
    if (onlyView() || !Insitu.token()) return;
    const saved = store.get(K_TOKEN, null) || {};
    const k = 'ctdIA.insituShared';
    if (store.get(k, '') === saved.token) return;
    try { await cosCall('insitu_token', { token: saved.token, scheme: saved.scheme ?? 'Bearer ' }); store.set(k, saved.token); } catch (e) { /* se intenta después */ }
  }
  async function pushCatalog() {
    if (onlyView() || !S.products.length || !S.meta || S.meta.source !== 'InSitu') return;
    const k = 'ctdIA.catPushed3'; // v3: con precio, departamento, stock y EAN (se sube con cada actualización de InSitu)
    if (store.get(k, 0) === S.meta.at) return;
    if (!S.products.some((p) => p.stock != null)) return; // sin existencia no sirve para bodega: no se pisa una copia buena
    try {
      await cosCall('catalogo_save', { items: S.products.map((p) => ({ id: p.id, name: p.name, upc: p.upc, ean: p.ean, photo: p.photo, price: p.price, cat: p.cat, pack: p.pack, brand: p.brand, stock: p.stock })) });
      store.set(k, S.meta.at);
    } catch (e) { /* se intenta en la siguiente */ }
  }
  // Copia para Órdenes de los usuarios sin InSitu (Jonathan): ventas, existencia y proveedor de cada producto
  async function pushOrdenes() {
    if (onlyView() || !S.products.length || !S.meta || S.meta.source !== 'InSitu') return;
    const k = 'ctdIA.ordPushed2';
    if (store.get(k, 0) === S.meta.at || !S.products.some((p) => p.st) || pushOrdenes.busy) return;
    pushOrdenes.busy = true;
    try {
      await cosCall('ordenes_save', { items: S.products.map((p) => ({ id: p.id, name: p.name, key: p.key, upc: p.upc, ean: p.ean, photo: p.photo, price: p.price, cost: p.cost, cat: p.cat, pack: p.pack, brand: p.brand, vendor: p.vendor, stock: p.stock, why: p.why,
        st: p.st ? { u30: p.st.u30, u90: p.st.u90, uPrev90: p.st.uPrev90, u365: p.st.u365, days: p.st.days, last: p.st.last, clients: p.st.clients, m: p.st.m } : null, buy: p.buy || null })) });
      store.set(k, S.meta.at);
    } catch (e) { console.warn('Copia de Órdenes', e); } // se intenta en la siguiente
    pushOrdenes.busy = false;
  }
  async function loadLotes(force) {
    if (R.lotes && !force) return R.lotes;
    try { R.lotes = (await cosCall('lotes')).lotes || {}; } catch (e) { R.lotes = R.lotes || {}; }
    R.lotesV = (R.lotesV || 0) + 1;
    await ajustarLotes();
    return R.lotes;
  }
  // Productos para emparejar: los de InSitu si este dispositivo ya los tiene; si no, el catálogo de QuickBooks (mismo código)
  async function recProducts() {
    if (S.products.length) return S.products;
    if (!R.cat) { try { const d = await cosCall('catalogo'); R.cat = d.items || []; R.catAt = d.at || null; } catch (e) { R.cat = []; } }
    return R.cat;
  }
  // Emparejar: código aprendido del proveedor → código del proveedor = código de barras/SKU → UPC → nombre (misma presentación)
  function recMatch(l, vmap, list) {
    const byCode = l.codigo_proveedor && vmap[skuKey(l.codigo_proveedor)];
    if (byCode) { const p = list.find((x) => String(x.id) === String(byCode.sku)); if (p) return { p, how: 'código del proveedor' }; }
    const cc = codeCore(l.codigo_proveedor);
    if (cc.length >= 3) {
      const p = list.find((x) => codeCore(x.upc) === cc && sameSize(l.producto, x.name) && nameScore(l.producto, x.name) >= 0.34);
      if (p) return { p, how: 'código' };
    }
    if (l.upc) { const p = list.find((x) => sameUpc(x.upc, l.upc) || (x.ean && sameUpc(x.ean, l.upc))); if (p) return { p, how: 'UPC' }; }
    let best = null;
    list.forEach((p) => {
      if (!sameSize(l.producto, p.name) || otroProducto(l.producto, p.name)) return;
      const s = nameScore(l.producto, p.name);
      if (s >= 0.7 && (!best || s > best.s)) best = { p, s };
    });
    return best ? { p: best.p, how: 'nombre', review: true } : null;
  }

  $('#recFile').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    if (R.rec && R.rec.status === 'borrador' && R.rec.lines.some((l) => l.estado) && !confirm('Tienes un recibo a medias (queda guardado en la lista). ¿Empezar otro?')) return;
    R.busy = true; renderRecibo('Preparando la factura…');
    try {
      let images = [];
      for (const f of files) images = images.concat(await fileToJpegs(f));
      renderRecibo('Cargando la factura…');
      const d = await cosCall('parse', { images: images.slice(0, 12) });
      await startRecibo(d);
    } catch (err) {
      toast('No se pudo leer: ' + err.message);
    } finally { R.busy = false; renderRecibo(); }
  });

  async function startRecibo(d) {
    // ¿Ya existe esta factura (subida en Costeo o por otro)? Se abre esa en vez de duplicarla
    try {
      const ex = (await cosCall('recibo_find', { proveedor: d.proveedor, factura: d.factura })).recibo;
      if (ex && ex.status !== 'borrador') { toast(`Esta factura ya se revisó (${fmtTs(ex.doneAt || ex.updated)} · ${ex.updatedBy || ex.by}).`); R.list = null; return; }
      if (ex) {
        await loadLotes(true);
        const list = await recProducts();
        R.rec = { ...ex, lines: ex.lines || [] };
        (d.items || []).forEach((it) => { // fechas escritas a mano que leyó Claude en esta foto
          if (!ymdOk(it.caducidad)) return;
          const l = R.rec.lines.find((x) => (x.codigo_proveedor && x.codigo_proveedor === it.codigo_proveedor) || normTxt(x.producto) === normTxt(it.producto));
          if (l) { l.leida = it.caducidad; if (!l.caducidad) l.caducidad = it.caducidad; }
        });
        R.rec.lines.forEach((l) => { if (l.sku && !l.photo) { const p = list.find((x) => String(x.id) === String(l.sku)); if (p) { l.photo = p.photo || ''; l.upcSis = l.upcSis || p.upc || ''; } } });
        R.cur = 0; store.set(K_REC, R.rec);
        toast('Esta factura ya estaba en el sistema · se abrió para revisar');
        renderRecibo(); window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    } catch (e) { /* sigue como nueva */ }
    let vmap = {};
    try { vmap = (await cosCall('map', { proveedor: d.proveedor })).map || {}; } catch (e) { /* sin memoria */ }
    const [list] = await Promise.all([recProducts(), loadLotes(true)]);
    const lines = (d.items || []).map((it) => {
      const l = { producto: it.producto, upc: it.upc || '', codigo_proveedor: it.codigo_proveedor || '', cantidad: Number(it.cantidad) || 0, empaque: it.empaque || '',
        unidades_por_caja: it.unidades_por_caja ?? null, costo_caja: r2(Number(it.costo_caja) || 0), total_linea: it.total_linea ?? null,
        sku: '', nombre: '', how: '', photo: '', upcSis: '', estado: '', recibido: null, caducidad: '', leida: ymdOk(it.caducidad) ? it.caducidad : '', nota: '' };
      l.caducidad = l.leida; // la fecha escrita en la factura ya viene puesta
      const m = recMatch(l, vmap, list);
      if (m) Object.assign(l, { sku: String(m.p.id), nombre: m.p.name, photo: m.p.photo || '', upcSis: m.p.upc || '', how: m.how + (m.review ? ' (revisa)' : '') });
      return l;
    });
    R.rec = { id: '', proveedor: d.proveedor || '', factura: d.factura || '', fecha: d.fecha || '', status: 'borrador', nota: '', by: S.who,
      head: { total_factura: d.total_factura, total_calculado: d.total_calculado, mercancia: d.mercancia, cuadra: d.cuadra, flete: d.flete, creditos: d.creditos, otros_cargos: d.otros_cargos },
      lines };
    R.cur = 0;
    await saveRecibo(false);
    renderRecibo();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // La factura abierta en este teléfono se pone al día con lo del servidor (Costeo pudo separar o ligar renglones)
  async function recAlDia() {
    if (!R.rec || !R.rec.id) return;
    try {
      const { recibo } = await cosCall('recibo_get', { id: R.rec.id });
      if (!recibo || !R.rec || recibo.id !== R.rec.id) return;
      const firma = (L) => (L || []).map((l) => `${l.producto}|${l.sku || ''}|${l.cantidad}`).join('~');
      if (firma(recibo.lines) === firma(R.rec.lines)) return;
      R.rec = { ...recibo, lines: recibo.lines || [] };
      const list = await recProducts();
      R.rec.lines.forEach((l) => { if (l.sku && !l.photo) { const p = list.find((x) => String(x.id) === String(l.sku)); if (p) { l.photo = p.photo || ''; l.upcSis = l.upcSis || p.upc || ''; } } });
      R.cur = 0; nextCard(); store.set(K_REC, R.rec); renderRecibo();
      toast('La factura se actualizó con los cambios de Costeo');
    } catch (e) { /* sin red: se queda la copia */ }
  }
  // Guardado: en este dispositivo al instante y en la nube (para seguir en otro teléfono / que lo vea Costeo)
  function touchRec() {
    store.set(K_REC, R.rec);
    clearTimeout(R.saveT);
    R.saveT = setTimeout(() => saveRecibo(false).catch(() => {}), 1200);
  }
  async function saveRecibo(final) {
    if (!R.rec) return;
    clearTimeout(R.saveT);
    const d = await cosCall('recibo_save', { recibo: R.rec, final: !!final });
    R.rec.id = d.id; R.rec.status = d.status;
    store.set(K_REC, R.rec);
    R.list = null;
    return d;
  }

  const lineDone = (l) => !!l.estado;
  function setEstado(i, est) {
    const l = R.rec.lines[i];
    l.estado = est;
    if (est === 'ok') l.recibido = l.cantidad;
    else if (est === 'parcial') l.recibido = l.recibido != null && l.recibido < l.cantidad ? l.recibido : Math.max(0, l.cantidad - 1);
    else l.recibido = 0;
    touchRec();
  }
  function nextCard() {
    const n = R.rec.lines.length;
    for (let k = 1; k <= n; k++) { const j = (R.cur + k) % n; if (!lineDone(R.rec.lines[j])) { R.cur = j; return; } }
    R.cur = n; // todos revisados → pantalla de terminar
  }

  function renderRecibo(busyMsg) {
    const box = $('#recWork');
    const hasRec = !!(R.rec && R.rec.lines && R.rec.lines.length && R.rec.status !== 'costeado');
    $('#recHero').hidden = hasRec && !busyMsg;
    if (busyMsg) { box.hidden = true; $('#recInfo').innerHTML = `<span class="age old">⟳ ${esc(busyMsg)}</span>`; return; }
    $('#recInfo').textContent = 'Sube la factura que llegó y revisa producto por producto: qué llegó, qué faltó y su fecha de caducidad. Al terminar pasa a Costeo.';
    box.hidden = !hasRec;
    renderRecList();
    if (!hasRec) return;
    const L = R.rec.lines, done = L.filter(lineDone).length;
    if (R.cur > L.length) R.cur = L.length;
    const head = `
      <div class="rec-top">
        <button class="btn-back" type="button" data-r="close"><span aria-hidden="true">←</span> Recibos</button>
        <p class="hud">${esc(R.rec.status === 'revisado' ? 'Recibo · ya en Costeo (puedes corregir)' : 'Recibo')}</p>
        <h2 class="rec-title">${esc(R.rec.proveedor || 'Proveedor')} <small>#${esc(R.rec.factura || '—')}</small></h2>
        <div class="rec-prog"><span style="width:${L.length ? (done / L.length) * 100 : 0}%"></span></div>
        <p class="status">${done} de ${L.length} revisados${R.rec.fecha ? ' · factura del ' + esc(fmtLong(R.rec.fecha)) : ''}</p>
        <div class="rec-bus"><input id="recBus" type="search" placeholder="Buscar producto: SKU, UPC o nombre" autocomplete="off" enterkeyhint="search"><div id="recBusRes" class="rec-bus-res"></div></div>
      </div>`;
    box.innerHTML = head + (R.cur >= L.length ? finishHTML() : cardRecHTML(R.cur)) + stripHTML();
    const di = $('#recDate');
    if (di) {
      const setDate = (ymdv) => { L[R.cur].caducidad = ymdv; touchRec(); di.blur(); renderRecibo(); };
      di.addEventListener('input', () => {
        const d = di.value.replace(/\D/g, '').slice(0, 6);
        di.value = fmtMask(d);
        const pv = $('#recDatePrev');
        if (d.length === 6) { const y = parseMask(d); if (y) return setDate(y); pv.innerHTML = '<span class="bad">Fecha no válida</span>'; }
        else pv.textContent = d.length ? 'mes / día / año' : 'Sin fecha';
      });
      di.addEventListener('focus', () => { if (L[R.cur].caducidad) di.select(); });
      di.addEventListener('blur', () => { const d = di.value.replace(/\D/g, ''); if (d.length === 4) { const y = parseMask(d, true); if (y) setDate(y); } });
      di.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') di.blur(); });
    }
    const ni = $('#recNote');
    if (ni) ni.addEventListener('input', () => { L[R.cur].nota = ni.value.slice(0, 300); touchRec(); });
    const gi = $('#recNotaGen');
    if (gi) gi.addEventListener('input', () => { R.rec.nota = gi.value.slice(0, 1500); touchRec(); });
    const qi = $('#recQty');
    if (qi) qi.addEventListener('change', () => { const l = L[R.cur]; l.recibido = Math.max(0, Math.min(l.cantidad, Number(qi.value) || 0)); touchRec(); renderRecibo(); });
  }

  // Fecha rápida: 6 números mes-día-año como en la factura (102527 = 25 oct 2027); 4 números = mes-año (fin de mes)
  const pad2 = (n) => String(n).padStart(2, '0');
  function mkYmd(y, m, d) {
    if (!(m >= 1 && m <= 12) || !(y >= 2024 && y <= 2045)) return '';
    const last = new Date(y, m, 0).getDate();
    if (d === 0) d = last;
    return d >= 1 && d <= last ? `${y}-${pad2(m)}-${pad2(d)}` : '';
  }
  function parseMask(v, loose) {
    const d = String(v).replace(/\D/g, '');
    if (d.length === 6) return mkYmd(2000 + +d.slice(4), +d.slice(0, 2), +d.slice(2, 4));
    if (loose && d.length === 4) return mkYmd(2000 + +d.slice(2), +d.slice(0, 2), 0);
    return '';
  }
  const fmtMask = (d) => d.slice(0, 2) + (d.length > 2 ? ' / ' + d.slice(2, 4) : '') + (d.length > 4 ? ' / ' + d.slice(4, 6) : '');
  const ymdToMask = (s) => (ymdOk(s) ? `${s.slice(5, 7)} / ${s.slice(8, 10)} / ${s.slice(2, 4)}` : '');
  const thumb = (l, cls) => (l.sku ? `<span class="${cls}">${l.photo ? `<img src="${esc(l.photo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>` : '');

  function cardRecHTML(i) {
    const l = R.rec.lines[i];
    const lots = (R.lotes && l.sku && R.lotes[skuKey(l.sku)]) ? Object.entries(R.lotes[skuKey(l.sku)].fechas) : [];
    lots.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    const opts = [];
    if (l.leida) opts.push({ d: l.leida, t: 'factura' });
    lots.slice(0, 3).forEach(([d]) => { if (!opts.some((o) => o.d === d)) opts.push({ d, t: 'la vez pasada' }); });
    const chip = (o) => `<button type="button" class="chip${l.caducidad === o.d ? ' on' : ''}" data-r="date" data-d="${o.d}">${esc(fmtLong(o.d))}<small>${esc(o.t)}</small></button>`;
    const dd = l.caducidad ? daysTo(l.caducidad) : null;
    const prev = l.fechas && l.fechas.length > 1 ? `Vence <b>${l.fechas.map((x) => `${esc(fmtLong(x.f))} (${nfmt(x.q)})`).join(' + ')}</b>` : l.caducidad ? `Vence <b>${esc(fmtLong(l.caducidad))}</b>${dd < 0 ? ' · <span class="bad">ya venció</span>' : dd < 120 ? ` · <span class="warn">en ${dd} días</span>` : ''}` : 'Sin fecha';
    const same = l.sku && normTxt(l.nombre).replace(/\W/g, '') === normTxt(l.producto).replace(/\W/g, '');
    return `
      <article class="rec-card" data-i="${i}">
        <p class="rec-n">${i + 1} de ${R.rec.lines.length}${l.estado ? ` · <span class="rec-st ${l.estado}">${EST[l.estado]}${l.estado === 'parcial' ? ` ${nfmt(l.recibido || 0)} de ${nfmt(l.cantidad)}` : ''}</span>` : ''}</p>
        <div class="rec-prod">
          ${thumb(l, 'rec-ph')}
          <div class="rec-pinfo">
            <h3 class="rec-name">${esc(l.sku ? l.nombre : l.producto)}</h3>
            ${l.sku ? `<p class="meta">${l.upcSis || l.upc ? 'UPC ' + esc(l.upcSis || l.upc) + ' · ' : ''}SKU ${esc(l.sku)}</p>` : '<p class="meta"><span class="pill warn">no está en el sistema</span></p>'}
            ${l.how === 'agregado' ? `<p class="meta"><span class="pill warn">sobrante · no viene en la factura</span> <button type="button" class="btn-link sm" data-r="quitar" data-i="${R.cur}">Quitar</button></p>
              <label class="field rec-agcost"><span>Costo por caja (si Cortes lo cobró; si no, déjalo en 0)</span><input data-agcost type="number" step="0.01" min="0" inputmode="decimal" value="${Number(l.costo_caja) || 0}"></label>` : ''}
            ${l.sku && !same ? `<p class="meta">Factura: ${esc(l.producto)}</p>` : ''}
          </div>
        </div>
        <p class="rec-qty">Factura dice <b>${nfmt(l.cantidad)}</b> ${l.cantidad === 1 ? 'caja' : 'cajas'}${l.empaque ? ` <small>${esc(l.empaque)}</small>` : ''}</p>

        <div class="rec-date">
          <p class="rec-dprev">${l.caducidad ? `Caducidad: ${prev.replace(/^Vence /, '')}${l.leida === l.caducidad ? ' <small>(de la factura)</small>' : ''}` : 'Caducidad: <span class="muted">se escoge al confirmar</span>'}</p>
          <button type="button" class="btn-link" data-r="sheet">${l.caducidad ? 'cambiar' : 'poner ahora'}</button>
        </div>

        <div class="rec-acts">
          <button type="button" class="rec-b ok${l.estado === 'ok' ? ' on' : ''}" data-r="ok">✓ Llegó completo<small>${l.caducidad ? 'vence ' + esc(fmtLong(l.caducidad)) + ' · siguiente →' : 'luego escoges mes y año'}</small></button>
          <button type="button" class="rec-b warn${l.estado === 'parcial' ? ' on' : ''}" data-r="parcial">Llegó menos</button>
          <button type="button" class="rec-b bad${l.estado === 'no' ? ' on' : ''}" data-r="no">✗ No llegó</button>
          <button type="button" class="rec-b${l.estado === 'pendiente' ? ' on' : ''}" data-r="pendiente">Pendiente</button>
        </div>
        ${l.estado === 'parcial' ? `
        <div class="rec-step">
          <span class="lbl">¿Cuántas llegaron?</span>
          <div class="qty"><button type="button" data-r="minus" aria-label="Menos">−</button><input id="recQty" type="number" inputmode="numeric" min="0" max="${l.cantidad}" value="${l.recibido ?? 0}"><button type="button" data-r="plus" aria-label="Más">+</button></div>
          <span class="status">de ${nfmt(l.cantidad)}</span>
          <button type="button" class="btn btn-oro rec-listo" data-r="parcialok">Listo${l.caducidad ? ', siguiente →' : ' → fecha'}</button>
        </div>` : ''}
        ${novPanelHTML(l)}
        ${l.nota || R.noteOpen ? `<label class="field"><span>Nota</span><input id="recNote" type="text" maxlength="300" placeholder="Dañado, regresó, llegó otro sabor…" value="${esc(l.nota)}"></label>`
          : '<button type="button" class="btn-link rec-addnote" data-r="note">+ Agregar nota</button>'}
        <div class="rec-nav">
          <button type="button" class="btn btn-ghost" data-r="prev"${i === 0 ? ' disabled' : ''}>← Anterior</button>
          <button type="button" class="btn btn-ghost" data-r="next">Saltar →</button>
        </div>
      </article>`;
  }

  function finishHTML() {
    const L = R.rec.lines;
    const c = (e) => L.filter((l) => l.estado === e).length;
    const sinFecha = L.filter((l) => (l.estado === 'ok' || l.estado === 'parcial') && !l.caducidad).length;
    const falt = L.filter((l) => l.estado === 'parcial' || l.estado === 'no' || l.estado === 'pendiente');
    return `
      <article class="rec-card rec-fin">
        <h3 class="rec-name">Resumen</h3>
        <div class="kpis rec-kpis">
          <div class="kpi"><span class="lbl">Llegó</span><div class="kpi-v">${c('ok')}</div></div>
          <div class="kpi"><span class="lbl">Llegó menos</span><div class="kpi-v">${c('parcial')}</div></div>
          <div class="kpi"><span class="lbl">No llegó</span><div class="kpi-v">${c('no')}</div></div>
          <div class="kpi"><span class="lbl">Pendiente</span><div class="kpi-v">${c('pendiente')}</div></div>
        </div>
        ${c('') ? `<p class="qb-warn">Faltan ${c('')} productos por revisar.</p>` : ''}
        ${sinFecha ? `<p class="status">${sinFecha} de lo que llegó no tiene fecha de caducidad.</p>` : ''}
        ${falt.length ? `<ul class="rec-falt">${falt.map((l) => `<li><b>${esc(EST[l.estado])}</b> · ${esc(l.producto)}${l.estado === 'parcial' ? ` — llegaron ${nfmt(l.recibido || 0)} de ${nfmt(l.cantidad)}` : ''}${l.nota ? ` · <i>${esc(l.nota)}</i>` : ''}</li>`).join('')}</ul>` : ''}
        <div class="rec-recv">
          <label class="field"><span># Pallets total</span><input data-recv="pallets" inputmode="numeric" value="${esc((R.rec.recv || {}).pallets || '')}"></label>
          <label class="field"><span># Pallets combinados</span><input data-recv="combinados" inputmode="numeric" value="${esc((R.rec.recv || {}).combinados || '')}"></label>
          <label class="field"><span>Temperatura</span><input data-recv="temp" placeholder="ej. 36°F" value="${esc((R.rec.recv || {}).temp || '')}"></label>
          <label class="field"><span>Descargado por</span><input data-recv="por" value="${esc((R.rec.recv || {}).por || label(S.who))}"></label>
        </div>
        <label class="rec-invman"${PAUSA_QB ? ' hidden' : ''}><input type="checkbox" id="recInvMan"${R.rec.invManual ? ' checked' : ''}> <span><b>El inventario de esta factura ya se metió a mano en InSitu</b><small>Márcalo para que la IA no lo vuelva a meter (si ya lo había metido, lo regresa).</small></span></label>
        <label class="field"><span>Notas del recibo</span><textarea id="recNotaGen" rows="3" maxlength="1500" placeholder="Algo que regresó, que faltó, que venía dañado…">${esc(R.rec.nota || '')}</textarea></label>
        <div class="rec-nav">
          <button type="button" class="btn btn-ghost" data-r="prev">← Revisar</button>
          <button type="button" class="btn btn-oro" data-r="finish">${R.rec.status === 'revisado' ? 'Guardar cambios' : 'Terminar y mandar a Costeo'}</button>
        </div>
      </article>`;
  }

  /* ---- Formato de Novedad (Delivery Updates) para Cortes: lo que llegó mal se reporta al revisar y sale el Excel ---- */
  const NOMBRES = { jonathan: 'Jonathan Reyes' }; // nombre completo para los formatos del proveedor
  const nombreCompleto = (n) => NOMBRES[normTxt(n).trim()] || label(n);
  const NOV_ES = { damaged: 'Dañado', 'missing item': 'Faltante', 'short date format': 'Fecha corta', spare: 'Sobrante' };
  const FECHA_CORTA = 45; // días (mes y medio)
  const esCortes = (rec) => /cortes/i.test(String((rec && rec.proveedor) || ''));
  const diasEntre = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
  const recDia = (rec) => ymd(rec.doneAt ? new Date(rec.doneAt) : new Date());
  // Lo que viene con fecha corta en un renglón: si trae varias fechas, solo las cajas de la fecha corta
  function cortasDe(l, rec) {
    const dia = recDia(rec);
    const llego = l.estado === 'parcial' ? Number(l.recibido) || 0 : l.estado === 'no' ? 0 : Number(l.recibido ?? l.cantidad) || 0;
    const fs = Array.isArray(l.fechas) && l.fechas.length > 1 ? l.fechas : l.caducidad ? [{ f: l.caducidad, q: llego }] : [];
    const out = {};
    fs.forEach((x) => { if (x && x.f && x.q > 0 && diasEntre(dia, x.f) < FECHA_CORTA) out[x.f] = (out[x.f] || 0) + Number(x.q); });
    return Object.entries(out).sort((a, b) => a[0].localeCompare(b[0])).map(([f, q]) => ({ f, q }));
  }
  function novPanelHTML(l) {
    const cortas = cortasDe(l, R.rec);
    const auto = [l.estado === 'no' ? `Faltante: ${nfmt(l.cantidad)}` : '', l.estado === 'parcial' ? `Faltante: ${nfmt((l.cantidad || 0) - (l.recibido || 0))}` : '',
      ...cortas.map((x) => `Fecha corta: ${nfmt(x.q)} ${x.q === 1 ? 'caja' : 'cajas'} vencen ${fmtD(x.f)} (en ${diasEntre(recDia(R.rec), x.f)} días)`)].filter(Boolean);
    const fc = cortas.length ? `<div class="nov-fotos"><small class="nov-fc">Foto de la fecha corta:</small>${(l.fcFotos || []).map((f, k) => `<span class="nov-f"><img src="${f}" alt=""><button type="button" class="g-x" data-r="fcfotoquitar" data-k="${k}" aria-label="Quitar">×</button></span>`).join('')}
        ${(l.fcFotos || []).length < 3 ? '<button type="button" class="btn btn-ghost btn-sm" data-r="fcfoto">📷 Foto</button>' : ''}<input id="fcFile" type="file" accept="image/*" capture="environment" multiple hidden></div>` : '';
    if (!l.nov) return `<div class="nov-auto">${auto.length ? `<span class="pill warn">Se reporta a Cortes: ${esc(auto.join(' · '))}</span>` : ''}${fc}<button type="button" class="btn-link rec-addnote" data-r="nov">⚠ Reportar (dañado, sobrante…) con foto</button></div>`;
    const n = l.nov;
    return `<div class="nov-box">${fc}
      ${auto.length ? `<p class="status">También se reporta solo: ${esc(auto.join(' · '))}</p>` : ''}
      <div class="nov-grid">
        <label class="field"><span>Motivo</span><select data-nov="tipo">${Object.entries(NOV_ES).map(([k, v]) => `<option value="${k}"${n.tipo === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Cantidad</span><input data-nov="cant" type="number" inputmode="numeric" min="0" value="${n.cant ?? 1}"></label>
        <label class="field"><span>Unidad</span><select data-nov="um"><option value="case"${n.um !== 'each' ? ' selected' : ''}>Caja</option><option value="each"${n.um === 'each' ? ' selected' : ''}>Pieza</option></select></label>
      </div>
      <label class="field"><span>Observaciones</span><input data-nov="nota" type="text" maxlength="300" placeholder="una lata rota, falto una caja…" value="${esc(n.nota || '')}"></label>
      <div class="nov-fotos">${(n.fotos || []).map((f, k) => `<span class="nov-f"><img src="${f}" alt=""><button type="button" class="g-x" data-r="novfotoquitar" data-k="${k}" aria-label="Quitar">×</button></span>`).join('')}
        ${(n.fotos || []).length < 3 ? '<button type="button" class="btn btn-ghost btn-sm" data-r="novfoto">📷 Foto</button>' : ''}
        <input id="novFile" type="file" accept="image/*" capture="environment" multiple hidden></div>
      <button type="button" class="btn-link sm" data-r="novquitar">Quitar reporte</button>
    </div>`;
  }
  // Foto del celular → JPEG chico (máx. 1000 px) para guardarla y meterla al Excel
  function fotoChica(file) {
    return new Promise((ok, bad) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { const s = Math.min(1, 1000 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL('image/jpeg', 0.7)); };
      img.onerror = (e) => { URL.revokeObjectURL(url); bad(e); };
      img.src = url;
    });
  }
  // Renglones del formato: faltantes (Llegó menos / No llegó), fecha corta (< 90 días) y lo que Jona reportó
  function novFilas(rec) {
    const prods = S.products.length ? S.products : (R.cat || []);
    const dia = recDia(rec), out = [];
    (rec.lines || []).forEach((l) => {
      const p = prods.find((x) => String(x.id) === String(l.sku)) || {};
      const num = [l.upcSis, p.upc].map((v) => String(v || '').trim()).find((v) => /^\d{2,6}$/.test(v)) || '';
      const sku = String(l.codigo_proveedor || '').trim() || num;
      const base = { sku, prod: l.producto || l.nombre || '', exp: l.caducidad ? fmtLong(l.caducidad) : '', fact: rec.factura || '' };
      const falta = l.estado === 'no' ? Number(l.cantidad) || 0 : l.estado === 'parcial' ? (Number(l.cantidad) || 0) - (Number(l.recibido) || 0) : 0;
      if (falta > 0 && !(l.nov && l.nov.tipo === 'missing item')) out.push({ ...base, razon: 'missing item', cant: falta, um: 'CASE', obs: `falto ${nfmt(falta)} ${falta === 1 ? 'caja' : 'cajas'}`, fotos: [] });
      if (!(l.nov && l.nov.tipo === 'short date format')) {
        cortasDe(l, rec).forEach((x, k) => out.push({ ...base, exp: fmtLong(x.f), razon: 'short date format', cant: x.q, um: 'CASE', obs: 'FECHA CORTA', fotos: k === 0 ? (l.fcFotos || []) : [] }));
      }
      if (l.how === 'agregado' && !l.nov) { const q = l.estado === 'parcial' ? Number(l.recibido) || 0 : l.estado === 'ok' ? Number(l.recibido ?? l.cantidad) || 0 : 0; if (q > 0) out.push({ ...base, razon: 'spare', cant: q, um: 'CASE', obs: 'SOBRANTE: no viene en la factura', fotos: [] }); }
      if (l.nov) out.push({ ...base, razon: l.nov.tipo, cant: l.nov.cant, um: l.nov.um === 'each' ? 'EA' : 'CASE', obs: l.nov.nota || NOV_ES[l.nov.tipo], fotos: l.nov.fotos || [] });
    });
    return out;
  }
  async function formatoNovedad(rec) {
    const filas = novFilas(rec);
    if (!filas.length) { alert('Este recibo no tiene nada que reportar a Cortes (faltantes, dañados, fecha corta o sobrantes).'); return; }
    const { num } = await cosCall('novedad_num', { id: rec.id });
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Formato NOVEDAD', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    [5.9, 10, 37.8, 12, 17.6, 29.3, 16, 14, 11, 26.8, 11.1, 17.4, 17.4, 17.4].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const F = { name: 'Calibri', size: 10 }, thin = { style: 'thin' }, box = { top: thin, left: thin, bottom: thin, right: thin };
    ws.mergeCells('B1:J1'); Object.assign(ws.getCell('B1'), { value: 'DELIVERY UPDATES', font: { ...F, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }, alignment: { horizontal: 'center' } });
    const set = (a, v, o = {}) => Object.assign(ws.getCell(a), { value: v, font: { ...F, ...(o.font || {}) }, ...(o.alignment ? { alignment: o.alignment } : {}) });
    ws.mergeCells('C3:D3'); ws.mergeCells('G3:H3'); ws.mergeCells('C4:D4'); ws.mergeCells('G4:H4');
    set('B3', 'Reporr Nu.:', { font: { bold: true } }); set('C3', num);
    set('F3', 'Data:', { font: { bold: true }, alignment: { horizontal: 'center' } }); set('G3', fmtLong(recDia(rec)));
    set('B4', 'Costumer:', { font: { bold: true } }); set('C4', 'Central Trade Distribution, LLC');
    set('F4', 'Supplier:', { font: { bold: true }, alignment: { horizontal: 'center' } }); set('G4', 'Cortes Distributors, LLC');
    set('B6', 'This form is for informational purposes only and is valid only if completed within 48 hours of receiving the product.', { font: { bold: true } });
    ['Item', 'SKU', 'Product', 'Lote', 'Exp Date', 'REASON FOR ALERT', 'Quan. Sale Unit ', 'UM (EA, CASE)', 'CONDITION', 'OBSERVATIONS', 'INVOISE NUMBERT', 'PHOTOGRAPHIC RECORD'].forEach((h, k) => {
      Object.assign(ws.getRow(8).getCell(k + 1), { value: h, font: { ...F, bold: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: box });
    });
    ws.getRow(8).height = 27;
    try { const b = await (await fetch('cortes-logo.png')).blob(); const d64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); ws.addImage(wb.addImage({ base64: d64, extension: 'png' }), { tl: { col: 10.1, row: 0.05 }, ext: { width: 200, height: 118 } }); } catch (e) { /* sin logo */ }
    filas.forEach((f, k) => {
      const r = 9 + k, row = ws.getRow(r);
      [k + 1, f.sku ? (/^\d+$/.test(f.sku) ? Number(f.sku) : f.sku) : '', f.prod, '', f.exp, f.razon, f.cant, f.um, '', f.obs, f.fact, ''].forEach((v, j) => {
        Object.assign(row.getCell(j + 1), { value: v, font: F, border: box, alignment: { horizontal: j === 2 ? 'left' : 'center', vertical: 'middle', wrapText: j === 2 || j === 9 } });
      });
      row.height = f.fotos.length ? 95 : 30;
      f.fotos.forEach((foto, n) => { ws.addImage(wb.addImage({ base64: foto, extension: 'jpeg' }), { tl: { col: 11 + n + 0.05, row: r - 1 + 0.05 }, ext: { width: 115, height: 120 } }); });
    });
    const rs = 9 + filas.length + 2;
    set(`B${rs}`, 'SENT BY:'); ws.mergeCells(`C${rs}:D${rs}`);
    Object.assign(ws.getCell(`C${rs}`), { value: nombreCompleto((rec.recv && rec.recv.por) || rec.updatedBy || S.who), font: F, border: { bottom: { style: 'medium' } } });
    const buf = await wb.xlsx.writeBuffer(), d = new Date();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `formato novedad ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}-${num}.xlsx`);
    toast(`Formato de novedad #${num} descargado`);
  }

  // ---- Buscar un producto de la factura (tarimas mixtas: no llega en el orden de la factura) ----
  const recProd = (l) => (S.products.length ? S.products : (R.cat || [])).find((x) => String(x.id) === String(l.sku)) || {};
  const recSku = (l) => { const p = recProd(l); return ctdDe(l.upcSis, p.upc); };
  const recCodigos = (l) => { const p = recProd(l); return [recSku(l), l.upc, l.upcSis, p.upc, p.ean, l.sku, l.codigo_proveedor].map((v) => String(v || '').trim()).filter(Boolean); };
  function recBuscar(q) {
    const s = normTxt(q).trim(); if (!s) return [];
    const dig = s.replace(/[^a-z0-9]/g, '');
    return R.rec.lines.map((l, i) => ({ l, i })).filter(({ l }) => {
      const cods = recCodigos(l).map((c) => normTxt(c).replace(/[^a-z0-9]/g, ''));
      if (dig.length >= 3 && cods.some((c) => c === dig || c.endsWith(dig) || (dig.length >= 6 && c.includes(dig)) || (c.length >= 6 && dig.endsWith(c)))) return true;
      const nom = normTxt(`${l.nombre || ''} ${l.producto || ''}`);
      return s.split(/\s+/).every((w) => nom.includes(w) || cods.some((c) => c.includes(w)));
    }).slice(0, 8);
  }
  function recIr(i) { R.cur = i; R.noteOpen = false; renderRecibo(); toCard(); }
  $('#recWork').addEventListener('input', (e) => {
    if (e.target.id !== 'recBus') return;
    const res = recBuscar(e.target.value), box = $('#recBusRes');
    box.innerHTML = e.target.value.trim() ? (res.length ? res.map(({ l, i }) => `<button type="button" data-busi="${i}">
        <span class="rb-sku">${esc(recSku(l) || l.upc || ('#' + (l.sku || '')))}</span>${thumb(l, 'rec-th')}
        <span class="rb-n">${esc(l.sku ? l.nombre : l.producto)}<small>${nfmt(l.cantidad)} ${l.cantidad === 1 ? 'caja' : 'cajas'}${l.estado ? ' · ya revisado' : ''}</small></span></button>`).join('')
      : '<p class="data-info" style="padding:10px">No está en esta factura</p>') : '';
  });
  $('#recWork').addEventListener('keydown', (e) => {
    if (e.target.id !== 'recBus' || e.key !== 'Enter') return;
    e.preventDefault();
    const res = recBuscar(e.target.value);
    if (res.length === 1) recIr(res[0].i); // escaneado con lector: si solo hay uno, brinca solo
  });
  $('#recWork').addEventListener('click', (e) => { const b = e.target.closest('[data-busi]'); if (b) recIr(Number(b.dataset.busi)); });

  function stripHTML() {
    return `<div class="rec-strip">${R.rec.lines.map((l, i) => `
      <button type="button" class="rec-row${i === R.cur ? ' cur' : ''}" data-r="go" data-i="${i}">
        <span class="rec-dot ${l.estado || 'none'}" aria-hidden="true"></span>
        ${thumb(l, 'rec-th')}
        <span class="rec-row-n">${recSku(l) ? `<small class="rec-row-sku">${esc(recSku(l))}</small>` : ''}${esc(l.sku ? l.nombre : l.producto)}</span>
        <span class="rec-row-d">${l.estado === 'parcial' ? nfmt(l.recibido || 0) + '/' : ''}${nfmt(l.cantidad)}${l.caducidad ? ' · ' + esc(fmtD(l.caducidad)) + ' ' + parseYmd(l.caducidad).getFullYear() % 100 : ''}</span>
      </button>`).join('')}
      ${R.rec.status === 'costeado' ? '' : `<button type="button" class="rec-row" data-r="add"><span class="rec-dot none" aria-hidden="true"></span><span class="rec-row-n"><b>+ Agregar producto (por SKU)</b><small style="display:block;opacity:.7">llegó y no viene en la factura (sobrante)</small></span></button>`}
      <button type="button" class="rec-row${R.cur >= R.rec.lines.length ? ' cur' : ''}" data-r="go" data-i="${R.rec.lines.length}"><span class="rec-dot fin" aria-hidden="true"></span><span class="rec-row-n"><b>Terminar</b></span></button>
    </div>`;
  }

  /* ---- Caducidad en dos toques: hoja que sube desde abajo → mes + año.
   * Siempre pide también el día (día, mes y año). ---- */
  const DIAS = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
  const SHORT_DAYS = Infinity; // siempre se pide el día (Jonathan: día, mes y año en todas)
  function openSheet(i, adv) {
    R.sheet = { i, adv, m: null, y: null, day: false }; // siempre dos toques nuevos (la fecha anterior queda marcada como pista)
    renderSheet();
    requestAnimationFrame(() => $('#recSheet').classList.add('open'));
  }
  function closeSheet() {
    const el = $('#recSheet');
    el.classList.remove('open');
    R.sheet = null;
    setTimeout(() => { if (!R.sheet) el.hidden = true; }, 260);
  }
  function renderSheet() {
    const el = $('#recSheet');
    if (!R.sheet || (!R.sheet.item && !R.rec)) { el.hidden = true; return; }
    const sh = R.sheet, l = sh.item || R.rec.lines[sh.i];
    const now = new Date(), cy = now.getFullYear(), cm = now.getMonth() + 1;
    const lots = (R.lotes && l.sku && R.lotes[skuKey(l.sku)]) ? Object.keys(R.lotes[skuKey(l.sku)].fechas) : [];
    const hint = [l.caducidad, R.lastDate, l.leida, ...lots].filter(ymdOk);
    const hintM = new Set(hint.map((d) => +d.slice(5, 7))), hintY = new Set(hint.map((d) => +d.slice(0, 4)));
    const past = (y, m) => y < cy || (y === cy && m < cm);
    const months = MES.map((n, k) => {
      const m = k + 1, off = sh.y != null && past(sh.y, m);
      return `<button type="button" class="mo${sh.m === m ? ' pick' : ''}${hintM.has(m) ? ' sug' : ''}" data-s="m" data-m="${m}"${off ? ' disabled' : ''}><b>${n.toUpperCase()}</b></button>`;
    }).join('');
    const years = [0, 1, 2, 3, 4].map((k) => {
      const y = cy + k, off = sh.m != null && past(y, sh.m);
      return `<button type="button" class="yr${sh.y === y ? ' pick' : ''}${hintY.has(y) ? ' sug' : ''}" data-s="y" data-y="${y}"${off ? ' disabled' : ''}><b>${y}</b></button>`;
    }).join('');
    let days = '';
    if (sh.day) {
      const last = new Date(sh.y, sh.m, 0).getDate();
      const cur = l.caducidad && +l.caducidad.slice(0, 4) === sh.y && +l.caducidad.slice(5, 7) === sh.m ? +l.caducidad.slice(8) : 0;
      days = `<p class="lbl sh-l">Vence pronto · ¿qué día de ${MES[sh.m - 1]} ${sh.y}?</p><div class="sh-strip" id="shDays">${Array.from({ length: last }, (_, k) => k + 1).map((d) => {
        const wd = new Date(sh.y, sh.m - 1, d).getDay();
        const off = sh.y === cy && sh.m === cm && d < now.getDate();
        return `<button type="button" class="dy${d === cur ? ' pick' : ''}${wd === 0 || wd === 6 ? ' we' : ''}" data-s="d" data-d="${d}"${off ? ' disabled' : ''}><small>${DIAS[wd]}</small><b>${d}</b></button>`;
      }).join('')}</div>`;
    }
    const tot = !sh.item ? (l.estado === 'parcial' ? Number(l.recibido) || 0 : Number(l.cantidad) || 0) : 0;
    const parts = sh.parts || [], puestas = parts.reduce((a, x) => a + x.q, 0);
    const split = sh.split ? `<div class="sh-split"><p class="lbl sh-l">Varias fechas · ${nfmt(puestas)} de ${nfmt(tot)} cajas</p>
      ${parts.map((x, k) => `<span class="pill">${nfmt(x.q)} ${x.q === 1 ? 'caja' : 'cajas'} · ${esc(fmtLong(x.f))} <button type="button" class="g-x" data-s="rm" data-k="${k}" aria-label="Quitar">×</button></span>`).join(' ')}
      <p class="status">${puestas < tot ? `Escoge la fecha de las ${nfmt(tot - puestas)} que faltan.` : 'Listo.'}</p></div>` : '';
    el.hidden = false;
    el.innerHTML = `
      <div class="sh-back" data-s="close"></div>
      <div class="sh" role="dialog" aria-label="Fecha de caducidad">
        <div class="sh-grab" aria-hidden="true"></div>
        <div class="sh-h">
          ${thumb(l, 'rec-th')}
          <div><p class="hud">¿Cuándo vence?</p><p class="sh-prod">${esc(l.sku ? l.nombre : l.producto)}</p></div>
        </div>
        ${split}
        <div class="sh-months">${months}</div>
        <div class="sh-years">${years}</div>
        ${days}
        <div class="sh-foot">
          ${sh.split ? `<button type="button" class="btn btn-oro btn-sm" data-s="splitok"${parts.length ? '' : ' disabled'}>Guardar fechas</button>` : `<button type="button" class="btn btn-ghost btn-sm" data-s="none">Sin fecha</button>${!sh.item && tot > 1 ? '<button type="button" class="btn btn-ghost btn-sm" data-s="split">Varias fechas</button>' : ''}`}
          <button type="button" class="btn btn-ghost btn-sm" data-s="close">Cancelar</button>
        </div>
      </div>`;
    if (days) {
      const ds = $('#shDays'), on = ds.querySelector('.pick') || ds.querySelector('button:not([disabled])');
      if (on) ds.scrollLeft = Math.max(0, on.offsetLeft - 16);
    }
  }
  function openSheetFor(item, cb) {
    R.sheet = { item, cb, m: null, y: null, day: false };
    renderSheet();
    requestAnimationFrame(() => $('#recSheet').classList.add('open'));
  }
  function pickDate(ymdv) {
    const s = R.sheet;
    if (s.cb) { if (ymdv) R.lastDate = ymdv; closeSheet(); s.cb(ymdv); return; }
    const l = R.rec.lines[s.i];
    if (s.split && ymdv) {
      // Varias fechas: cuántas cajas traen esta fecha
      const tot = l.estado === 'parcial' ? Number(l.recibido) || 0 : Number(l.cantidad) || 0;
      const falta = tot - (s.parts || []).reduce((a, x) => a + x.q, 0);
      const n = Math.round(Number(prompt(`¿Cuántas cajas vencen el ${fmtLong(ymdv)}?`, String(Math.max(1, falta)))) || 0);
      if (n > 0) { const ex = s.parts.find((x) => x.f === ymdv); if (ex) ex.q += n; else s.parts.push({ f: ymdv, q: n }); s.parts.sort((a, b) => (a.f < b.f ? -1 : 1)); }
      s.m = null; s.y = null; s.day = false; R.lastDate = ymdv;
      if (s.parts.reduce((a, x) => a + x.q, 0) >= tot && s.parts.length) { guardarPartes(); return; }
      renderSheet(); return;
    }
    l.fechas = null;
    l.caducidad = ymdv;
    if (ymdv) R.lastDate = ymdv;
    touchRec();
    closeSheet();
    if (s.adv && s.i === R.cur) { R.noteOpen = false; nextCard(); }
    renderRecibo(); toCard();
  }
  function guardarPartes() {
    const s = R.sheet, l = R.rec.lines[s.i];
    l.fechas = s.parts.length > 1 ? s.parts.map((x) => ({ f: x.f, q: x.q })) : null;
    l.caducidad = s.parts.length ? s.parts[0].f : ''; // la más próxima
    touchRec(); closeSheet();
    if (s.adv && s.i === R.cur) { R.noteOpen = false; nextCard(); }
    renderRecibo(); toCard();
  }
  // Con mes y año: si vence en más de ~9 meses se guarda el fin de mes; si no, se pide el día
  function monthYearReady() {
    const sh = R.sheet;
    if (sh.m == null || sh.y == null) { renderSheet(); return; }
    const end = mkYmd(sh.y, sh.m, 0);
    if (daysTo(end) > SHORT_DAYS) { pickDate(end); return; }
    sh.day = true; renderSheet();
  }
  $('#recSheet').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]'); if (!b || !R.sheet || b.disabled) return;
    const a = b.dataset.s, sh = R.sheet;
    if (a === 'close') { const cb = R.sheet.cb; closeSheet(); if (!cb) renderRecibo(); return; }
    if (a === 'none') { pickDate(''); return; }
    if (a === 'split') { const l = R.rec.lines[sh.i]; sh.split = true; sh.parts = (l.fechas || []).map((x) => ({ ...x })); sh.m = null; sh.y = null; sh.day = false; renderSheet(); return; }
    if (a === 'rm') { sh.parts.splice(+b.dataset.k, 1); renderSheet(); return; }
    if (a === 'splitok') { guardarPartes(); return; }
    if (a === 'm') { sh.m = +b.dataset.m; sh.day = false; monthYearReady(); return; }
    if (a === 'y') { sh.y = +b.dataset.y; sh.day = false; monthYearReady(); return; }
    if (a === 'd') pickDate(mkYmd(sh.y, sh.m, +b.dataset.d));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && R.sheet) { const cb = R.sheet.cb; closeSheet(); if (!cb) renderRecibo(); } });

  // Lleva la vista al principio de la tarjeta (debajo de la barra de arriba)
  function toCard() {
    const c = $('#recWork .rec-n') || $('#recWork');
    const top = c.getBoundingClientRect().top + window.scrollY - ($('.topbar').offsetHeight + 12);
    if (Math.abs(window.scrollY - top) > 8) window.scrollTo({ top, behavior: 'smooth' });
  }
  $('#recWork').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]'); if (!b || !R.rec) return;
    const a = b.dataset.r, L = R.rec.lines, l = L[R.cur];
    if (a === 'close') { if (R.sheet) closeSheet(); R.rec = null; store.del(K_REC); renderRecibo(); window.scrollTo({ top: 0 }); return; }
    if (a === 'go') { R.noteOpen = false; R.cur = Number(b.dataset.i); renderRecibo(); toCard(); return; }
    if (a === 'add') {
      // Sobrante: llegó y no viene en la factura. Solo por SKU (el código del producto en InSitu, ej. 23 o CTD-1352)
      const q = (prompt('SKU del producto que llegó de más (ej. 23 o CTD-1352):') || '').trim();
      if (!q) return;
      const list = await recProducts();
      const k = q.toUpperCase().replace(/\s+/g, '');
      const hits = list.filter((p) => String(p.id).toUpperCase() === k || String(p.upc || '').toUpperCase().replace(/\s+/g, '') === k);
      if (!hits.length) { alert(`No encontré el SKU "${q}" en el sistema.`); return; }
      const p = hits.length === 1 ? hits[0] : hits[Number(prompt(hits.map((x, i) => `${i + 1}. ${x.name} (SKU ${x.id}${x.upc ? ' · ' + x.upc : ''})`).join('\n') + '\n\nEscribe el número:', '1')) - 1];
      if (!p) return;
      const n = Number(String(prompt(`${p.name}\n\n¿Cuántas cajas llegaron?`, '') || '').replace(',', '.'));
      if (!(n > 0)) return;
      if (L.some((x) => x.how === 'agregado' && String(x.sku) === String(p.id)) && !confirm('Ese producto ya está agregado como sobrante. ¿Agregarlo otra vez?')) return;
      L.push({ producto: p.name, upc: p.ean || '', codigo_proveedor: '', cantidad: n, empaque: p.pack || '', unidades_por_caja: null, costo_caja: 0, total_linea: 0,
        sku: String(p.id), nombre: p.name, how: 'agregado', photo: p.photo || '', upcSis: p.upc || '', estado: '', recibido: null, caducidad: '', leida: '', nota: 'Sobrante: llegó y no viene en la factura' });
      R.noteOpen = false; R.cur = L.length - 1; touchRec(); renderRecibo(); toCard();
      toast('Agregado como sobrante: marca si llegó completo y su caducidad');
      return;
    }
    if (a === 'quitar') {
      const i = Number(b.dataset.i), x = L[i];
      if (!x || x.how !== 'agregado' || !confirm(`¿Quitar "${x.nombre || x.producto}" de este recibo?`)) return;
      L.splice(i, 1); R.cur = Math.min(i, L.length); touchRec(); renderRecibo(); return;
    }
    if (a === 'prev') { R.noteOpen = false; R.cur = Math.max(0, R.cur - 1); renderRecibo(); toCard(); return; }
    if (a === 'next') { R.noteOpen = false; nextCard(); renderRecibo(); toCard(); return; }
    if (a === 'finish') {
      const pend = L.filter((x) => !x.estado).length;
      if (pend && !confirm(`Hay ${pend} productos sin revisar. ¿Mandar a Costeo de todos modos? (quedan como "sin revisar")`)) return;
      b.disabled = true;
      try {
        const st = await saveRecibo(true);
        const iv = st && st.inv;
        const invTxt = iv ? (iv.errores && iv.errores.length ? ` · inventario: ${Object.keys(iv.aplicado || {}).length} productos, ${iv.errores.length} con problema (ver en la lista)` : ` · inventario actualizado en InSitu (${Object.keys(iv.aplicado || {}).length} productos)`) : '';
        toast((st && st.costeoId ? 'Recibo listo ✓ · ya estaba costeada: le avisamos a Costeo las diferencias' : 'Recibo listo ✓ · ya lo ve Costeo') + invTxt);
        const hecho = { ...R.rec, doneAt: R.rec.doneAt || Date.now(), updatedBy: S.who };
        R.rec = null; store.del(K_REC); await loadLotes(true);
        if (confirm('¿Descargar el formato de Receiving en Excel?')) formatoReceiving(hecho).catch((err) => toast('No se pudo: ' + err.message));
        if (esCortes(hecho) && novFilas(hecho).length && confirm(`Hay ${novFilas(hecho).length} cosas para reportar a Cortes (faltantes, dañados, fecha corta…). ¿Descargar el Formato de Novedad?`)) formatoNovedad({ ...hecho, id: st.id }).catch((err) => toast('No se pudo: ' + err.message));
      } catch (err) { toast('No se pudo guardar: ' + err.message); b.disabled = false; return; }
      renderRecibo(); window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (!l) return;
    const go = () => { R.noteOpen = false; nextCard(); renderRecibo(); toCard(); };
    if (a === 'ok') { setEstado(R.cur, 'ok'); if (l.caducidad) go(); else openSheet(R.cur, true); return; }
    if (a === 'parcialok') { if (l.caducidad) go(); else openSheet(R.cur, true); return; }
    if (a === 'sheet') { openSheet(R.cur, false); return; }
    if (a === 'parcial') { setEstado(R.cur, 'parcial'); renderRecibo(); return; }
    if (a === 'no' || a === 'pendiente') { setEstado(R.cur, a); l.caducidad = ''; go(); return; }
    if (a === 'minus' || a === 'plus') { l.recibido = Math.max(0, Math.min(l.cantidad, (l.recibido || 0) + (a === 'plus' ? 1 : -1))); touchRec(); renderRecibo(); return; }
    if (a === 'date') { l.caducidad = b.dataset.d; touchRec(); renderRecibo(); return; }
    if (a === 'nodate') { l.caducidad = ''; touchRec(); renderRecibo(); return; }
    if (a === 'note') { R.noteOpen = true; renderRecibo(); const n = $('#recNote'); if (n) n.focus(); }
    if (a === 'nov') { l.nov = l.nov || { tipo: 'damaged', cant: 1, um: 'case', nota: '', fotos: [] }; touchRec(); renderRecibo(); return; }
    if (a === 'novquitar') { if (confirm('¿Quitar el reporte de este producto?')) { l.nov = null; touchRec(); renderRecibo(); } return; }
    if (a === 'novfotoquitar') { l.nov.fotos.splice(Number(b.dataset.k), 1); touchRec(); renderRecibo(); return; }
    if (a === 'novfoto') { const f = $('#novFile'); if (f) f.click(); return; }
    if (a === 'fcfoto') { const f = $('#fcFile'); if (f) f.click(); return; }
    if (a === 'fcfotoquitar') { (l.fcFotos || []).splice(Number(b.dataset.k), 1); touchRec(); renderRecibo(); return; }
  });
  $('#recWork').addEventListener('change', async (e) => {
    const el = e.target, l = R.rec && R.rec.lines[R.cur]; if (!l) return;
    if (el.matches('[data-agcost]') && l.how === 'agregado') {
      const v = Math.max(0, Math.round((parseFloat(el.value) || 0) * 100) / 100);
      l.costo_caja = v; l.total_linea = Math.round(v * (Number(l.recibido ?? l.cantidad) || 0) * 100) / 100;
      l.nota = v > 0 ? 'Sobrante: llegó y no viene en la factura (cobrado en el total)' : 'Sobrante: llegó y no viene en la factura';
      touchRec(); toast(v > 0 ? `Costo ${money(v)} por caja guardado` : 'Sin costo'); return;
    }
    if (el.id === 'fcFile') {
      for (const file of [...el.files].slice(0, 3 - (l.fcFotos || []).length)) {
        try { l.fcFotos = [...(l.fcFotos || []), await fotoChica(file)]; } catch (err) { toast('No se pudo leer la foto'); }
      }
      touchRec(); renderRecibo(); return;
    }
    if (!l.nov) return;
    if (el.id === 'novFile') {
      for (const file of [...el.files].slice(0, 3 - (l.nov.fotos || []).length)) {
        try { l.nov.fotos = [...(l.nov.fotos || []), await fotoChica(file)]; } catch (err) { toast('No se pudo leer la foto'); }
      }
      touchRec(); renderRecibo(); return;
    }
    if (el.dataset.nov) { l.nov[el.dataset.nov] = el.dataset.nov === 'cant' ? Math.max(0, Number(el.value) || 0) : el.value; touchRec(); }
  });

  // ---- Lista de recibos (en curso / en Costeo / costeados) ----
  async function renderRecList() {
    const box = $('#recRecent');
    if (!box) return;
    if (!R.list) {
      box.innerHTML = '<p class="data-info">Cargando…</p>';
      try { R.list = (await cosCall('recibo_list')).list || []; } catch (e) { box.innerHTML = `<p class="data-info">${esc(e.message)}</p>`; return; }
    }
    const ST = { borrador: 'por revisar', revisado: 'en Costeo', costeado: 'costeado' };
    const order = (f) => (f.status === 'borrador' ? 0 : 1);
    R.list.sort((a, b) => order(a) - order(b) || (b.updated || b.ts) - (a.updated || a.ts));
    box.innerHTML = R.list.length ? R.list.map((f) => `
      <div class="hist-item" data-rid="${esc(f.id)}"><div class="hi-txt"><b>${esc(f.proveedor)} · #${esc(f.factura)}</b>
        ${f.lines} productos${f.parcial ? ` · ${f.parcial} llegaron menos` : ''}${f.no ? ` · ${f.no} no llegaron` : ''}${f.pendiente ? ` · ${f.pendiente} pendientes` : ''} · ${f.fechas} con fecha · ${f.origen === 'costeo' ? 'subió ' + esc(f.by || '') + ' en Costeo' : esc(f.by || '')} · ${fmtTs(f.updated || f.ts)}</div>
        <span class="st${f.status === 'costeado' ? ' sent' : ''}">${ST[f.status] || f.status}</span>
        ${f.po ? `<span class="pill ok">Orden QB ${esc(f.po.doc || f.po.id)} creada</span>` : ''}${['revisado', 'costeado'].includes(f.status) ? `<button class="btn ${f.po ? 'btn-ghost' : 'btn-oro'} btn-sm" data-c="bill" type="button">Crear Orden QB</button>` : ''}
        ${PAUSA_QB ? '' : f.po ? `<span class="pill ok">QuickBooks: orden ${esc(f.po.doc || f.po.id)} lista para recibir</span>` : `${f.bill ? `<span class="pill warn">QuickBooks: Bill ${esc(f.bill.doc || f.bill.id)}</span>` : ''}${['revisado', 'costeado'].includes(f.status) ? `<button class="btn btn-oro btn-sm" data-c="bill" data-tenia="${f.bill ? 1 : ''}" type="button">Mandar a QuickBooks para recibir</button>` : ''}`}
        ${PAUSA_QB ? '' : f.insitu ? `<span class="pill ok">InSitu: recepción ${esc(f.insitu.id || '')} ✓</span>` : ['revisado', 'costeado'].includes(f.status) ? '<button class="btn btn-ghost btn-sm" data-c="insitu" type="button">Recepción en InSitu (prueba)</button>' : ''}
        ${['revisado', 'costeado'].includes(f.status) && /cortes/i.test(f.proveedor || '') ? `<button class="btn btn-ghost btn-sm" data-c="nov" type="button">${f.novedad ? `Novedad #${f.novedad.num}` : 'Formato Novedad'}</button>` : ''}
        ${['revisado', 'costeado'].includes(f.status) ? `<button class="btn btn-ghost btn-sm" data-c="xls" type="button">${icon('download')}Formato Excel</button>` : ''}
        ${PAUSA_QB ? '' : f.invManual ? '<span class="pill">inventario: metido a mano</span>' : ['revisado', 'costeado'].includes(f.status) ? '<button class="btn-link sm" data-c="invman" type="button">¿Ya se metió a mano?</button>' : ''}
        ${PAUSA_QB || f.invManual ? '' : f.inv ? (f.inv.errores.length ? `<span class="pill warn" title="${esc(f.inv.errores.join('\n'))}">inventario: ${f.inv.errores.length} con problema</span><button class="btn btn-ghost btn-sm" data-c="inv" type="button">Reintentar inventario</button>` : `<span class="pill ok">inventario ✓ ${f.inv.hechos}</span>`) : ''}
        ${f.status !== 'costeado' ? `<button class="btn ${f.status === 'borrador' ? 'btn-oro' : 'btn-ghost'} btn-sm" data-c="open" type="button">${f.status === 'borrador' ? 'Revisar' : 'Abrir'}</button>` : ''}</div>`).join('')
      : '<p class="data-info">Todavía no hay recibos.</p>';
  }
  document.addEventListener('change', (e) => { if (e.target.id === 'recInvMan' && R.rec) { R.rec.invManual = e.target.checked; touchRec(); } });
  document.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.recv; if (k && R.rec) { R.rec.recv = { ...(R.rec.recv || {}), [k]: e.target.value }; touchRec(); } });

  /* ---- Factura del proveedor (Bill) en QuickBooks desde la IA: mete el inventario (InSitu lo toma de QB) ---- */
  const PAUSA_QB = true; // pausado (10 oct 2026): recepción en InSitu, Bill y ajustes de inventario. Solo queda "Crear Orden QB".
  async function crearBill(ids, tipo) {
    if (tipo === 'insitu') {
      if (!confirm('PRUEBA: ¿Crear la recepción de mercancía de esta factura en InSitu?\n\nSi InSitu la manda a QuickBooks, aparecerá como "Recibo de artículo". Asegúrate de que en QuickBooks NO haya ya un Recibo de artículo ni una orden de compra de esta factura.')) return null;
      try {
        const d = await cosCall('qb_bill', { ...ids, tipo: 'insitu' });
        if (d.ya) { toast('Ya se había mandado a InSitu'); return { ...d.bill, tipo: 'insitu' }; }
        alert(`Listo ✓ Recepción creada en InSitu${d.bill.id ? ' (#' + d.bill.id + ')' : ''} · ${d.bill.lineas} productos · ${money(d.bill.total)}\n\nAhora esperen la sincronización de InSitu con QuickBooks y revisen si aparece en "Recibo de artículo".`);
        return { ...d.bill, tipo: 'insitu' };
      } catch (e) { alert('No se pudo crear en InSitu:\n\n' + e.message); return null; }
    }
    if (!confirm('¿Mandar esta factura a QuickBooks para recibirla?\n\nSe crea una Orden de compra abierta con el proveedor, productos, cantidades recibidas y costos (no mueve inventario todavía).\nDespués, en QuickBooks → Recibo de artículo, eliges el proveedor, le das "Agregar" a la orden y Guardar.')) return null;
    let extra = {};
    for (let intento = 0; intento < 2; intento++) {
      try {
        const d = await cosCall('qb_bill', { ...ids, ...extra });
        if (d.ya) { toast(`Ya estaba en QuickBooks (${d.tipo === 'bill' ? 'Bill' : 'Orden de compra'} ${d.bill.doc || d.bill.id}): no se creó otra`); return { ...d.bill, tipo: d.tipo }; }
        alert(`Listo ✓ Orden de compra ${d.bill.doc || d.bill.id} en QuickBooks · ${d.bill.lineas} productos · ${money(d.bill.total)}${d.bill.recibido ? '' : ' (con cantidades de la factura)'}\n\nAhora en QuickBooks: + Nuevo → Recibo de artículo → elige el proveedor → "Agregar" la orden ${d.bill.doc || ''} → pon la fecha → Guardar.`);
        return { ...d.bill, tipo: d.tipo };
      } catch (e) {
        if (e.code === 'no_vendor' && e.data && e.data.vendors) {
          const vs = e.data.vendors, q = normTxt(prompt(`${e.message}\n\nEscribe parte del nombre del proveedor en QuickBooks:`, '') || '');
          if (!q) return null;
          const res = vs.filter((v) => normTxt(v.name).includes(q)).slice(0, 12);
          if (!res.length) { toast('No encontré ese proveedor'); return null; }
          const k = Number(prompt(res.map((v, i) => `${i + 1}. ${v.name}`).join('\n') + '\n\nEscribe el número:', '1'));
          if (!res[k - 1]) return null;
          extra = { vendorId: res[k - 1].id }; continue;
        }
        alert('No se pudo crear la factura en QuickBooks:\n\n' + e.message); return null;
      }
    }
    return null;
  }

  /* ---- Formato de control y verificación de productos (Receiving), en Excel con el formato de CTD ---- */
  const FRIO = /refriger|congel|frio|frío|frozen|dairy|lacte|lácte|queso|crema|chilled/i;
  async function formatoReceiving(rec) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    const prods = await recProducts();
    const pOf = (l) => prods.find((x) => String(x.id) === String(l.sku)) || {};
    // Un renglón por fecha (si un producto trae varias fechas, va con sus cajas)
    const filas = [];
    (rec.lines || []).forEach((l) => {
      const cajas = l.estado === 'ok' ? Number(l.recibido ?? l.cantidad) || 0 : l.estado === 'parcial' ? Number(l.recibido) || 0 : 0;
      const sku = l.upcSis || pOf(l).upc || l.sku || l.codigo_proveedor || '';
      const desc = (l.nombre || l.producto || '') + (l.how === 'agregado' ? '  (SOBRANTE: no viene en la factura)' : '') + (l.estado === 'no' ? '  (NO LLEGÓ)' : l.estado === 'parcial' ? `  (llegaron ${cajas} de ${l.cantidad})` : l.estado === 'pendiente' ? '  (PENDIENTE)' : '');
      const fds = Array.isArray(l.fechas) && l.fechas.length > 1 ? l.fechas : [{ f: l.caducidad || '', q: cajas }];
      fds.forEach((x) => filas.push({ sku, desc, q: x.q, f: x.f ? fmtLong(x.f) : '' })); // con nombre del mes (lo pidió Jonathan)
    });
    const frio = (rec.lines || []).some((l) => FRIO.test(`${pOf(l).cat || ''} ${l.nombre || l.producto || ''}`));
    const seco = (rec.lines || []).some((l) => !FRIO.test(`${pOf(l).cat || ''} ${l.nombre || l.producto || ''}`));
    const totalCajas = filas.reduce((a, x) => a + (Number(x.q) || 0), 0);
    const rv = rec.recv || {};
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Receiving', { pageSetup: { paperSize: 1, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0, footer: 0 } } });
    ws.columns = [{ width: 7 }, { width: 16 }, { width: 52 }, { width: 11 }, { width: 22 }];
    const thin = { style: 'thin', color: { argb: 'FF000000' } }, box = { top: thin, left: thin, bottom: thin, right: thin };
    ws.getCell('E1').value = `Receipt no. ${rec.factura || ''}`; ws.getCell('E1').font = { size: 11 };
    ws.mergeCells('B2:D2'); ws.getCell('B2').value = 'FORMATO DE CONTROL Y VERIFICACION DE PRODUCTOS RECIVING'; ws.getCell('B2').font = { size: 12 };
    const logo = await logoData();
    if (logo) ws.addImage(wb.addImage({ base64: logo, extension: 'png' }), { tl: { col: 0.3, row: 2.2 }, ext: { width: 150, height: 80 } });
    for (let r = 3; r <= 7; r++) ws.getRow(r).height = 16;
    const H = 8;
    ['ITEM', 'SKU', 'DESCIPCION DE  LOS PRODUCTOS', 'CANTIDAD', 'FECHA DE EXPIRACION'].forEach((h, k) => {
      const c = ws.getRow(H).getCell(k + 1); c.value = h; c.border = box; c.alignment = { horizontal: 'center', vertical: 'middle' }; c.font = { size: 11 };
    });
    const n = Math.max(30, filas.length);
    for (let k = 0; k < n; k++) {
      const row = ws.getRow(H + 1 + k), x = filas[k] || {};
      [k + 1, x.sku || '', x.desc || '', x.q != null && x.desc ? x.q : '', x.f || ''].forEach((v, j) => { const c = row.getCell(j + 1); c.value = v; c.border = box; c.font = { size: 10 }; c.alignment = { horizontal: j === 0 || j === 3 || j === 4 ? (j === 0 ? 'right' : 'center') : 'left', vertical: 'middle', wrapText: j === 2 }; });
    }
    let r = H + n + 2;
    const put = (addr, v, opts = {}) => { const c = ws.getCell(addr); c.value = v; c.font = { size: 11, ...(opts.font || {}) }; if (opts.align) c.alignment = opts.align; };
    const chk = (on) => (on ? '☒' : '☐');
    put(`A${r}`, chk(seco)); put(`B${r}`, 'PRODUCTO SECO'); put(`C${r}`, `DESCARGADO POR :  ${rv.por || label(rec.updatedBy || rec.by || '')}`, { align: { horizontal: 'center' } }); put(`E${r}`, `# PALLET´S TOTAL :  ${rv.pallets || ''}`, { align: { horizontal: 'right' } });
    r++; put(`A${r}`, chk(frio)); put(`B${r}`, 'PRODUCTO FRIO O CONGELADO'); put(`E${r}`, `# PALLET´S  COMBINADOS:  ${rv.combinados || ''}`, { align: { horizontal: 'right' } });
    r++; put(`E${r}`, `TEMPERATURA:  ${rv.temp || ''}`, { align: { horizontal: 'right' } });
    const fr = rec.doneAt ? new Date(rec.doneAt) : new Date();
    r++; put(`B${r}`, `FECHA DE RECIVING :  ${fmtLong(ymd(fr))}`); put(`E${r}`, `# DE CAJAS:  ${nfmt(totalCajas)}`, { align: { horizontal: 'right' } });
    r++; put(`B${r}`, `PROOVEDOR :  ${rec.proveedor || ''}`); put(`E${r}`, 'FIRMA Y SELLO', { align: { horizontal: 'right' } });
    if (rec.nota) { r += 2; put(`B${r}`, `NOTAS: ${rec.nota}`, { align: { wrapText: true } }); ws.mergeCells(`B${r}:E${r}`); ws.getRow(r).height = 30; }
    const buf = await wb.xlsx.writeBuffer();
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Receiving-${normTxt(rec.proveedor || '').replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${String(rec.factura || '').replace(/[^\w-]+/g, '')}.xlsx`);
  }
  $('#recRecent').addEventListener('click', async (e) => {
    const bi2 = e.target.closest('[data-c="insitu"]');
    if (bi2) { bi2.disabled = true; const r = await crearBill({ reciboId: bi2.closest('.hist-item').dataset.rid }, 'insitu'); if (r) { R.list = null; renderRecList(); } else bi2.disabled = false; return; }
    const bb = e.target.closest('[data-c="bill"]');
    if (bb) {
      if (bb.dataset.tenia && !confirm('Esta factura ya tiene un Bill creado por la IA en QuickBooks.\n\nBórralo primero en QuickBooks; si no, al recibir la orden el inventario se DUPLICA.\n\n¿Ya lo borraste?')) return;
      bb.disabled = true; const r = await crearBill({ reciboId: bb.closest('.hist-item').dataset.rid }); if (r) { R.list = null; renderRecList(); } else bb.disabled = false; return; }
    const bn = e.target.closest('[data-c="nov"]');
    if (bn) {
      bn.disabled = true;
      try { const { recibo } = await cosCall('recibo_get', { id: bn.closest('.hist-item').dataset.rid }); await formatoNovedad(recibo); R.list = null; renderRecList(); } catch (err) { toast('No se pudo: ' + err.message); }
      bn.disabled = false; return;
    }
    const bx = e.target.closest('[data-c="xls"]');
    if (bx) {
      bx.disabled = true;
      try { const { recibo } = await cosCall('recibo_get', { id: bx.closest('.hist-item').dataset.rid }); await formatoReceiving(recibo); toast('Formato de Receiving descargado'); } catch (err) { toast('No se pudo: ' + err.message); }
      bx.disabled = false; return;
    }
    const bm = e.target.closest('[data-c="invman"]');
    if (bm) {
      if (!confirm('¿El inventario de esta factura ya se había metido a mano en InSitu?\n\nLa IA no lo meterá, y si ya lo metió, lo regresa (para que no quede doble).')) return;
      bm.disabled = true;
      try { const { inv } = await cosCall('recibo_inventario', { id: bm.closest('.hist-item').dataset.rid, manual: true }); toast(inv && inv.errores && inv.errores.length ? `Hecho con ${inv.errores.length} problema(s)` : 'Listo: esta factura queda como metida a mano'); } catch (err) { toast(err.message); }
      R.list = null; renderRecList(); return;
    }
    const bi = e.target.closest('[data-c="inv"]');
    if (bi) {
      const row = bi.closest('.hist-item'), f = (R.list || []).find((x) => x.id === row.dataset.rid);
      if (f && f.inv && f.inv.errores.length) alert('Lo que no entró al inventario:\n\n' + f.inv.errores.join('\n'));
      bi.disabled = true;
      try {
        const { inv } = await cosCall('recibo_inventario', { id: row.dataset.rid });
        toast(inv && inv.errores && inv.errores.length ? `Todavía ${inv.errores.length} con problema` : 'Inventario actualizado en InSitu ✓');
      } catch (err) { toast(err.message); }
      R.list = null; renderRecList(); return;
    }
    const b = e.target.closest('[data-c="open"]'); if (!b) return;
    try {
      const { recibo } = await cosCall('recibo_get', { id: b.closest('.hist-item').dataset.rid });
      await loadLotes();
      R.rec = { ...recibo, lines: recibo.lines || [] };
      const list = await recProducts();
      R.rec.lines.forEach((l) => { if (l.sku && !l.photo) { const p = list.find((x) => String(x.id) === String(l.sku)); if (p) { l.photo = p.photo || ''; l.upcSis = l.upcSis || p.upc || ''; } } });
      R.cur = 0; nextCard(); if (R.cur >= R.rec.lines.length && R.rec.lines.some((l) => !lineDone(l))) R.cur = 0;
      store.set(K_REC, R.rec);
      renderRecibo(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { toast(err.message); }
  });

  // ---- Caducidades: lo que vence primero. Cuántas quedan de cada fecha se estima con el stock real
  // (lo más viejo se vende primero); sin stock de InSitu en este dispositivo se muestra lo que llegó. ----
  function lotRows() {
    const out = [];
    Object.entries(R.lotes || {}).forEach(([sku, v]) => {
      const p = (S.products.length ? S.products : (R.cat || [])).find((x) => skuKey(x.id) === sku);
      const dates = Object.entries(v.fechas).map(([d, x]) => ({ d, q: x.q })).sort((a, b) => (a.d < b.d ? 1 : -1)); // nuevo → viejo
      let left = p && p.stock != null ? Math.max(0, p.stock) : null;
      dates.forEach((x) => {
        const quedan = left == null ? null : Math.min(x.q, left);
        if (left != null) left -= quedan;
        if (quedan === 0) return;
        const perDay = p && p.st ? (p.st.u90 || 0) / 90 : 0;
        const dias = daysTo(x.d);
        const venta = perDay > 0 && quedan != null ? Math.ceil(quedan / perDay) : null;
        out.push({ sku, nombre: p ? p.name : v.nombre, d: x.d, recibido: x.q, quedan, dias, venta, riesgo: dias >= 0 && venta != null && venta > dias });
      });
    });
    return out.sort((a, b) => (a.d < b.d ? -1 : 1));
  }
  /* ---- Avisos a tiendas: el lote que se llevó una tienda ya va a vencer y no ha vuelto a comprar ---- */
  const AV = { list: null, at: 0, busy: null, all: false };
  const avOk = () => !ONLY[S.who] || ONLY[S.who].includes('cred'); // Jonathan (bodega) no
  function loadAvisos(force) {
    if (!avOk()) return Promise.resolve([]);
    if (!force && AV.list && Date.now() - AV.at < 30 * 60000) return Promise.resolve(AV.list);
    if (AV.busy) return AV.busy;
    AV.busy = cosCall('avisos_tienda', { force: !!force })
      .then((d) => { AV.list = d.list || []; AV.at = Date.now(); AV.srvAt = d.at; AV.err = ''; return AV.list; })
      .catch((e) => { AV.err = e.message; AV.list = AV.list || []; return AV.list; })
      .finally(() => { AV.busy = null; });
    return AV.busy;
  }
  const avCuando = (a) => (a.dias < 0 ? `ya venció (${fmtLong(a.caduca)})` : a.dias === 0 ? 'vence hoy' : `vence el ${fmtLong(a.caduca)} (en ${a.dias} ${a.dias === 1 ? 'día' : 'días'})`);
  const avLinea = (a) => `${a.tienda}: ${a.nombre} — ${avCuando(a)}. Compró ${nfmt(a.cajas)} ${a.cajas === 1 ? 'caja' : 'cajas'} el ${fmtLong(a.fecha)}${a.factura ? ` (#${a.factura})` : ''}.`;
  function avWhats(list, nombre, tel) {
    const first = String(nombre || '').split(' ')[0];
    const txt = `Hola ${first}, revisa por favor con estas tiendas el producto que se les va a vencer (no han vuelto a comprar):\n\n${list.map((a, i) => `${i + 1}. ${avLinea(a)}`).join('\n')}\n\nSi todavía lo tienen, que lo pongan al frente o lo ofrezcan antes de que venza. Avísame qué te dicen.`;
    const ph = String(tel || '').replace(/\D/g, ''), num = ph.length === 10 ? '1' + ph : ph;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(txt)}`, '_blank', 'noopener');
    if (!num) toast('No tengo su teléfono en InSitu: elige el chat en WhatsApp');
  }
  function avHTML(list, max) {
    const show = max ? list.slice(0, max) : list;
    return show.map((a) => `
      <div class="av-r${a.dias < 0 ? ' dead' : a.dias <= 10 ? ' hot' : ''}">
        <div><b>${esc(a.tienda)}</b> · ${esc(a.nombre)}
          <p>Su lote ${esc(avCuando(a))} · compró ${nfmt(a.cajas)} ${a.cajas === 1 ? 'caja' : 'cajas'} el ${esc(fmtLong(a.fecha))}${a.factura ? ` (#${esc(a.factura)})` : ''} y no ha vuelto a comprar${a.vendedor ? ` · vendedor ${esc(a.vendedor)}` : ''}</p></div>
        <button type="button" class="btn btn-ghost btn-sm" data-avwa="${esc(a.cid + '|' + a.sku)}">${icon('send')}Avisar${a.vendedor ? ' a ' + esc(a.vendedor.split(' ')[0]) : ''}</button>
      </div>`).join('');
  }
  async function renderAvisos() {
    const box = $('#fechAvisos'); if (!box) return;
    if (!avOk()) { box.hidden = true; return; }
    await loadAvisos();
    const list = AV.list.filter((a) => !F.dep || depOf(a.sku) === F.dep);
    box.hidden = !list.length && !AV.err;
    if (box.hidden) return;
    if (AV.err && !list.length) { box.innerHTML = `<p class="lbl">Avisos a tiendas</p><p class="data-info">${esc(AV.err)}</p>`; return; }
    box.innerHTML = `<p class="lbl">Avisos a tiendas <small>(${list.length})</small></p>
      <p class="status">Tiendas que se llevaron un lote que ya vence y no han vuelto a comprar. Verifica con el vendedor.</p>
      ${avHTML(list, AV.all ? 0 : 5)}
      ${list.length > 5 ? `<button type="button" class="btn-link sm" data-avmore>${AV.all ? 'ver menos' : `ver los ${list.length}`}</button>` : ''}`;
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-avmore]')) { AV.all = !AV.all; renderAvisos(); return; }
    const b = e.target.closest('[data-avwa]'); if (!b) return;
    const a = (AV.list || []).find((x) => x.cid + '|' + x.sku === b.dataset.avwa); if (!a) return;
    avWhats([a], a.vendedor, a.tel);
  });

  /* ---- Pestaña Fechas: todas las caducidades por producto (de los recibos y puestas a mano) ---- */
  const F = { q: '', f: 'all', dep: '', add: null };
  const fechProds = () => (S.products.length ? S.products : (R.cat || []));
  const fechProd = (sku) => fechProds().find((x) => skuKey(x.id) === sku) || null;
  // SKU de CTD (CTD-####): InSitu lo tiene en Barcode (copia del SKU de QuickBooks)
  const skuFech = (sku) => { const p = fechProd(sku) || {}; return ctdDe(p.upc, p.qbSku); };
  const depOf = (sku) => { const p = fechProd(sku); return (p && p.cat) || 'Otros'; };
  const canMoney = () => !onlyView() && S.products.some((p) => p.cost > 0); // el dinero solo lo ven Oscar, Luis y Diego
  // Filas con los filtros de la pantalla (departamento, cuándo vence, búsqueda)
  function fechRows(ignoreDep) {
    const q = normTxt(F.q).trim();
    let rows = lotRows().map((r) => ({ ...r, dep: depOf(r.sku) }));
    if (F.f === '60') rows = rows.filter((r) => r.dias >= 0 && r.dias <= 60);
    if (F.f === 'old') rows = rows.filter((r) => r.dias < 0);
    if (q) rows = rows.filter((r) => { const p = fechProd(r.sku) || {}; const tx = normTxt(`${r.nombre} ${skuFech(r.sku)} ${skuFech(r.sku).replace('-', '')} ${p.ean || ''} ${p.upc || ''} ${r.sku}`); return q.split(/\s+/).every((w) => tx.includes(w)); });
    if (F.dep && !ignoreDep) rows = rows.filter((r) => r.dep === F.dep);
    return rows;
  }
  const cajasDe = (r) => (r.quedan != null ? r.quedan : r.recibido);
  const valorDe = (r) => { const p = fechProd(r.sku); return p && p.cost > 0 ? cajasDe(r) * p.cost : 0; };
  async function renderFechas(reload) {
    const box = $('#fechList'); if (!box) return;
    const ro = soloVer('fech');
    $('#fechAdd').hidden = ro; if (ro) $('#fechAddBox').hidden = true;
    if (reload || !R.lotes) {
      box.innerHTML = '<p class="data-info">Cargando…</p>';
      if (!S.products.length && R.catAt && Date.now() - R.catAt > 15 * 60000) R.cat = null; // copia nueva (el servidor la renueva cada hora)
      if (!S.products.length && !R.catAt) R.cat = null;
      await Promise.all([loadLotes(true), recProducts()]);
    }
    if (ro) $('#bodega').hidden = true; else renderBodega();
    renderTips(); renderAvisos();
    const total = Object.keys(R.lotes || {}).length;
    $('#fechInfo').textContent = ro ? (total ? `${total} productos con fecha (solo consulta).` : 'Todavía no hay fechas.')
      : total ? `${total} productos con fecha. Las fechas salen de los recibos; también puedes ponerlas a mano.` : 'Todavía no hay fechas. Se llenan al revisar facturas en Recibo, o agrégalas a mano.';
    // Departamentos (con cuántos productos hay en cada uno con los otros filtros)
    const all = fechRows(true), cnt = {};
    all.forEach((r) => { cnt[r.dep] = (cnt[r.dep] || 0) + 1; });
    if (F.dep && !cnt[F.dep]) F.dep = '';
    const deps = Object.keys(cnt).sort();
    $('#fechDeps').innerHTML = deps.length > 1 || F.dep ? `<button type="button" data-dep="" class="${F.dep ? '' : 'on'}">Todos<small>${all.length}</small></button>`
      + deps.map((d) => `<button type="button" data-dep="${esc(d)}" class="${F.dep === d ? 'on' : ''}">${esc(d)}<small>${cnt[d]}</small></button>`).join('') : '';
    $('#fechDepsWrap').hidden = !$('#fechDeps').innerHTML;
    const rows = fechRows();
    // Resumen: cuántos productos/cajas (y dinero, si aplica) vencen por plazo
    const money_ = canMoney();
    const bucket = (lo, hi) => rows.filter((r) => r.dias >= lo && r.dias <= hi);
    const tiles = [['Vencidas', rows.filter((r) => r.dias < 0), 'dead'], ['En 30 días', bucket(0, 30), 'hot'], ['En 31–60 días', bucket(31, 60), 'warm'], ['En 61–90 días', bucket(61, 90), '']];
    $('#fechSum').innerHTML = rows.length ? tiles.map(([l, rs, cls]) => `<div class="fs ${cls}"><span class="lbl">${l}</span><b>${rs.length}</b><small>${nfmt(rs.reduce((a, r) => a + cajasDe(r), 0))} cajas${money_ ? ' · ' + money(rs.reduce((a, r) => a + valorDe(r), 0)) : ''}</small></div>`).join('') : '';
    const soon = rows.filter((r) => r.dias >= 0 && (r.dias <= 60 || r.riesgo));
    $('#fechActs').hidden = !rows.length;
    $('#fechEsp').hidden = !!onlyView() || !soon.length; // (los usuarios de una sección no mandan a especiales)
    $('#fechEsp').innerHTML = `${icon('sparkles')}Mandar a especiales (${soon.length})`;
    $('#fechXls').hidden = !rows.length;
    box.innerHTML = rows.length ? rows.map((r) => {
      const info = (R.lotes[r.sku] || { fechas: {} }).fechas[r.d] || {};
      const p = fechProd(r.sku), ph = p ? p.photo : '';
      return `<div class="lot-row fr${r.dias < 0 ? ' dead' : r.dias <= 60 || r.riesgo ? ' hot' : r.dias <= 120 ? ' warm' : ''}">
        <div class="lot-d"><b>${esc(fmtD(r.d))}</b><small>${parseYmd(r.d).getFullYear()}</small></div>
        <div class="fr-ph">${ph ? `<img src="${esc(ph)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="lot-m">${skuFech(r.sku) ? `<small class="rec-row-sku">${esc(skuFech(r.sku))}</small>` : ''}<div class="ol-name">${esc(r.nombre)}</div>
          <div class="meta">${esc(r.dep)} · ${r.dias < 0 ? `venció hace ${-r.dias} días` : `vence en ${r.dias} días`} · ${r.quedan != null ? `quedan ~${nfmt(r.quedan)} de ${nfmt(r.recibido)}` : `${nfmt(r.recibido)} ${r.recibido === 1 ? 'caja' : 'cajas'}`}${info.man ? ' · puesta a mano' : ''}${r.venta != null ? ` · se venden en ~${r.venta} días` : ''}${r.riesgo ? ' · <b>no alcanza a venderse: ponlo en especial</b>' : ''}</div></div>
        ${info.man && !ro ? `<button type="button" class="g-x" data-fdel="${esc(r.sku)}" data-d="${r.d}" title="Quitar la fecha puesta a mano" aria-label="Quitar">×</button>` : ''}
      </div>`;
    }).join('') : `<p class="data-info">${total ? 'Nada con esos filtros.' : ''}</p>`;
  }
  $('#fechQ').addEventListener('input', (e) => { F.q = e.target.value; renderFechas(false); });
  // Con la página abierta, cada 30 min se vuelve a traer existencia y fechas
  setInterval(() => { if (S.view === 'fech' && !document.hidden && S.who) { R.cat = null; renderFechas(true); } }, 30 * 60000);
  $('#fechF').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    F.f = b.dataset.f; $$('#fechF button').forEach((x) => x.classList.toggle('on', x === b)); renderFechas(false);
  });
  $('#fechDeps').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dep]'); if (!b) return;
    F.dep = F.dep === b.dataset.dep ? '' : b.dataset.dep; renderFechas(false);
  });
  /* ---- "Ponle fecha a la bodega": por departamento, solo lo que hay en existencia; tocar producto → mes + año ---- */
  F.bdep = null; F.bAll = false;
  function bodegaProds() {
    // Solo producto empacado: con UPC (11+ dígitos) o código propio CTD-####. Lo que va por libra no caduca.
    // Lleva fecha todo lo que hay en existencia, menos el produce a granel sin código (frutas, verduras, raíces por libra)
    const conCodigo = (p) => [p.upc, p.ean].some((c) => String(c || '').replace(/\D/g, '').length >= 11) || /^\s*CTD-\d+/i.test(p.upc || '');
    const granel = (p) => /\b(po vida|produce|fruta|frutas|fruit|fruits|verdura|verduras|vegetal|vegetales|vegetable|vegetables)\b/.test(normTxt(p.cat || ''));
    const empacado = (p) => conCodigo(p) || !granel(p);
    // Tampoco llevan fecha las veladoras / velas
    const noCaduca = (p) => /\bvel(a|as|adora|adoras)\b/.test(normTxt(`${p.name} ${p.cat || ''}`));
    const list = fechProds().filter((p) => !isCredito(p) && !EXCLUDE_CATS.includes(p.cat) && p.price > 0 && empacado(p) && !noCaduca(p));
    const conStock = list.some((p) => p.stock != null);
    return conStock ? list.filter((p) => p.stock > 0) : [];
  }
  // Cajas con fecha por producto; un producto está "listo" si lo que tiene fecha cubre su existencia
  function conFecha() {
    const m = {};
    Object.entries(R.lotes || {}).forEach(([sku, v]) => { m[sku] = Object.values(v.fechas).reduce((a, f) => a + f.q, 0); });
    return m;
  }
  function fechadas() {
    const cf = conFecha(), s = new Set();
    fechProds().forEach((p) => { const k = skuKey(p.id); if (cf[k] > 0 && (p.stock == null || cf[k] >= p.stock - 0.5)) s.add(k); });
    return s;
  }
  function renderBodega() {
    const box = $('#bodega'); if (!box) return;
    if (!$('#bdBus')) {
      box.insertAdjacentHTML('beforebegin', '<div id="bdBusWrap" class="rec-bus bd-bus" hidden><input id="bdBus" type="search" placeholder="Buscar en la bodega: SKU, nombre o código de barras" autocomplete="off" enterkeyhint="search"></div>');
      $('#bdBus').addEventListener('input', (e) => { F.bq = e.target.value; renderBodega(); });
    }
    const prods = bodegaProds();
    $('#bdBusWrap').hidden = !prods.length;
    const done0 = fechadas(), cf0 = conFecha();
    const tile = (p) => {
      const has = done0.has(skuKey(p.id));
      const nx = has ? lotRows().find((r) => r.sku === skuKey(p.id)) : null;
      return `<button type="button" class="bd-p${has ? ' done' : ''}" data-bp="${esc(p.id)}">
          <span class="bd-ph">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
          ${skuFech(p.id) ? `<span class="bd-sku">${esc(skuFech(p.id))}</span>` : ''}
          <span class="bd-n">${esc(p.name)}</span>
          <span class="bd-s">${has && nx ? '✓ vence ' + esc(fmtD(nx.d)) + ' ' + String(parseYmd(nx.d).getFullYear()).slice(2) : (cf0[skuKey(p.id)] > 0 ? `${nfmt(Math.max(0, p.stock - cf0[skuKey(p.id)]))} sin fecha (llegó nuevo)` : nfmt(p.stock) + ' en existencia')}</span>
        </button>`;
    };
    // Con algo escrito: resultados de toda la bodega (todos los departamentos)
    const bq = normTxt(F.bq || '').trim();
    if (bq && prods.length) {
      const hits = prods.filter((p) => { const tx = normTxt(`${p.name} ${skuFech(p.id)} ${skuFech(p.id).replace('-', '')} ${p.ean || ''} ${p.upc || ''} ${p.id}`); return bq.split(/\s+/).every((w) => tx.includes(w)); }).slice(0, 40);
      box.hidden = false;
      box.innerHTML = `<p class="status bd-help">${hits.length ? `${hits.length} ${hits.length === 1 ? 'producto' : 'productos'} · toca uno para ponerle fecha` : 'Nada en existencia con esa búsqueda.'}</p><div class="bd-grid">${hits.map(tile).join('')}</div>`;
      return;
    }
    if (!prods.length) {
      // Sin existencia no se puede saber qué falta: se dice por qué (en vez de esconderlo)
      const sinStock = !fechProds().some((p) => p.stock != null);
      box.hidden = !sinStock;
      if (sinStock) box.innerHTML = `<p class="hud">Ponle fecha a la bodega</p><p class="status">Todavía no llega la existencia de InSitu a este teléfono${R.catAt ? ` (última copia: ${esc(fmtTs(R.catAt))})` : ''}. Que Oscar, Luis o Diego abran la IA o toquen "actualizar de InSitu", y luego recarga esta página.</p>`;
      return;
    }
    const done = fechadas(), byDep = {};
    prods.forEach((p) => { const d = p.cat || 'Otros'; (byDep[d] = byDep[d] || []).push(p); });
    const nDone = prods.filter((p) => done.has(skuKey(p.id))).length, pct0 = Math.round((nDone / prods.length) * 100);
    if (nDone === prods.length && !F.bdep) { box.hidden = false; box.innerHTML = '<p class="bd-ok">✓ Todo lo que hay en existencia ya tiene fecha. Lo nuevo entra con Recibo.</p>'; return; }
    box.hidden = false;
    const bar = (n, of) => `<div class="bd-bar"><span style="width:${of ? (n / of) * 100 : 0}%"></span></div>`;
    if (!F.bdep) {
      const deps = Object.keys(byDep).sort((a, b) => {
        const fa = byDep[a].filter((p) => !done.has(skuKey(p.id))).length, fb = byDep[b].filter((p) => !done.has(skuKey(p.id))).length;
        return (fb > 0) - (fa > 0) || a.localeCompare(b);
      });
      box.innerHTML = `
        <div class="bd-top"><div class="bd-h"><div><p class="hud">Ponle fecha a la bodega</p><p class="bd-t">Llevas <b>${pct0}%</b><span class="bd-sep"> · </span>${nDone} de ${prods.length} productos en existencia</p></div></div>
        ${bar(nDone, prods.length)}</div>
        <div class="bd-deps">${deps.map((d) => {
          const all = byDep[d], n = all.filter((p) => done.has(skuKey(p.id))).length, pc = Math.round((n / all.length) * 100);
          return `<button type="button" class="bd-dep${n === all.length ? ' full' : ''}" data-bdep="${esc(d)}"><b>${esc(d)}</b><span>${n === all.length ? '✓ completo' : `${pc}% · faltan ${all.length - n}`}</span>${bar(n, all.length)}</button>`;
        }).join('')}</div>`;
      return;
    }
    const all = (byDep[F.bdep] || []).sort((a, b) => a.name.localeCompare(b.name));
    const n = all.filter((p) => done.has(skuKey(p.id))).length;
    const show = F.bAll ? all : all.filter((p) => !done.has(skuKey(p.id)));
    box.innerHTML = `
      <div class="bd-h"><button type="button" class="btn-back" data-bback><span aria-hidden="true">←</span> Departamentos</button></div>
      <div class="bd-h"><div><p class="hud">${esc(F.bdep)}</p><p class="bd-t">Llevas <b>${Math.round((n / (all.length || 1)) * 100)}%</b> · ${n} de ${all.length} con fecha</p></div>
        <button type="button" class="btn-link sm" data-ball>${F.bAll ? 'ver solo los que faltan' : 'ver todos'}</button></div>
      ${bar(n, all.length)}
      <p class="status bd-help">Toca un producto y escoge día, mes y año. Se guarda con las cajas que hay en existencia.</p>
      <div class="bd-grid">${show.map(tile).join('') || '<p class="bd-ok">✓ Este departamento ya tiene todas sus fechas.</p>'}</div>`;
  }
  $('#bodega').addEventListener('click', (e) => {
    const dep = e.target.closest('[data-bdep]');
    if (dep) { F.bdep = dep.dataset.bdep; F.bAll = false; renderBodega(); $('#bodega').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (e.target.closest('[data-bback]')) { F.bdep = null; renderBodega(); return; }
    if (e.target.closest('[data-ball]')) { F.bAll = !F.bAll; renderBodega(); return; }
    const b = e.target.closest('[data-bp]'); if (!b) return;
    const p = fechProds().find((x) => String(x.id) === b.dataset.bp); if (!p) return;
    const ya = conFecha()[skuKey(p.id)] || 0;
    const q = Math.max(1, Math.round((p.stock || 1) - ya)); // solo las cajas que todavía no tienen fecha
    openSheetFor({ sku: String(p.id), nombre: p.name, photo: p.photo || '', caducidad: '', leida: '' }, async (fecha) => {
      if (!fecha) return;
      // Se marca al instante y se guarda en el servidor
      const k = skuKey(p.id);
      R.lotes = R.lotes || {};
      R.lotes[k] = R.lotes[k] || { nombre: p.name, fechas: {} };
      const prev = R.lotes[k].fechas[fecha] || { q: 0, man: 0 };
      R.lotes[k].fechas[fecha] = { q: prev.q + q, ts: Date.now(), man: (prev.man || 0) + 1 };
      R.lotesV = (R.lotesV || 0) + 1;
      renderFechas(false);
      try { await cosCall('lote_add', { sku: String(p.id), nombre: p.name, fecha, q }); toast(`✓ ${p.name} · vence ${fmtLong(fecha)}`); }
      catch (err) { toast('No se guardó: ' + err.message); renderFechas(true); }
    });
  });
  /* ---- Consejos: cruzan las fechas con lo que se vende por semana y a quién ---- */
  F.tipsAll = false;
  function renderTips() {
    const box = $('#fechTips'); if (!box) return;
    const full = !onlyView(); // ventas y dinero solo para Oscar, Luis y Diego
    const rows = lotRows().map((r) => ({ ...r, dep: depOf(r.sku) })).filter((r) => !F.dep || r.dep === F.dep);
    const tips = [];
    // 1) Ya venció
    const dead = rows.filter((r) => r.dias < 0);
    if (dead.length) tips.push({ lvl: 'dead', t: `Ya vencieron ${dead.length} ${dead.length === 1 ? 'producto' : 'productos'} (${nfmt(dead.reduce((a, r) => a + cajasDe(r), 0))} cajas)`,
      d: `Sácalos del piso y separa para reclamar crédito al proveedor: ${dead.slice(0, 4).map((r) => esc(r.nombre)).join(', ')}${dead.length > 4 ? '…' : ''}.` });
    // 2) No alcanza a venderse antes de su fecha
    if (full) {
      const rk = riskMap(), buyers = (S.sales && S.sales.buyers) || {}, sellers = (S.sales && S.sales.sellers) || [];
      Object.entries(rk).filter(([sku]) => !F.dep || depOf(sku) === F.dep).sort((a, b) => b[1].sobran - a[1].sobran).forEach(([sku, k]) => {
        const p = S.products.find((x) => skuKey(x.id) === sku); if (!p) return;
        const bs = (buyers[String(p.id)] || []).slice(0, 3);
        const who = bs.map((b) => { const s = sellers.find((x) => x.id === b.seller); return `${esc(b.name)}${s ? ` <small>(${esc(s.name)})</small>` : ''}`; }).join(', ');
        tips.push({ lvl: 'hot', sku, t: `${esc(p.name)}: no alcanza a venderse`,
          d: `Vencen ~${nfmt(k.quedan)} cajas el ${esc(fmtLong(k.d))} (en ${k.dias} días) y se venden ~${nfmt(k.rate)} por semana: sobran ~${nfmt(k.sobran)}${p.cost ? ` (${money(k.sobran * p.cost)})` : ''}. Ponlo en especial${who ? ` y ofréceselo a quien más lo compra: ${who}` : ''}. No pidas más hasta que baje.`,
          act: `<button type="button" class="btn btn-oro btn-sm" data-tesp="${esc(sku)}">${icon('sparkles')}Mandar a especial</button>` });
      });
      // 3) Parado: con fecha y sin venderse en 60+ días
      rows.filter((r) => r.dias >= 0).forEach((r) => {
        const p = S.products.find((x) => skuKey(x.id) === r.sku);
        if (!p || !p.st || rk[r.sku] || tips.some((x) => x.sku === r.sku) || esNuevo(p, r.sku)) return;
        const sin = p.st.days == null ? 365 : p.st.days;
        if (sin >= 60) tips.push({ lvl: 'warm', sku: r.sku, t: `${esc(p.name)}: parado`, d: `Lleva ${p.st.days == null ? 'más de un año' : sin + ' días'} sin venderse y vence en ${r.dias} días. Especial fuerte o pregunta al proveedor si lo cambia.`,
          act: `<button type="button" class="btn btn-ghost btn-sm" data-tesp="${esc(r.sku)}">${icon('sparkles')}Mandar a especial</button>` });
      });
    }
    // 4) Dos fechas del mismo producto: sacar primero la más próxima
    const bySku = {};
    rows.filter((r) => r.dias >= 0).forEach((r) => { (bySku[r.sku] = bySku[r.sku] || []).push(r); });
    Object.values(bySku).filter((l) => l.length > 1).forEach((l) => {
      l.sort((a, b) => (a.d < b.d ? -1 : 1));
      tips.push({ lvl: '', t: `${esc(l[0].nombre)}: vende primero el más próximo`, d: `Hay ${l.length} fechas. Saca primero el que vence el ${esc(fmtLong(l[0].d))}${l[0].quedan != null ? ` (~${nfmt(l[0].quedan)} cajas)` : ''} antes que el del ${esc(fmtLong(l[1].d))}.` });
    });
    box.hidden = !tips.length;
    if (!tips.length) return;
    const show = F.tipsAll ? tips : tips.slice(0, 5);
    box.innerHTML = `<p class="lbl">Consejos <small>(${tips.length})</small></p>` + show.map((x) => `
      <div class="tip ${x.lvl}"><i aria-hidden="true">${icon(x.lvl === 'dead' || x.lvl === 'hot' ? 'alert' : x.lvl === 'warm' ? 'moon' : 'check')}</i>
        <div><b>${x.t}</b><p>${x.d}</p>${x.act ? `<div class="tip-a">${x.act}</div>` : ''}</div></div>`).join('')
      + (tips.length > 5 ? `<button type="button" class="btn-link sm" data-tmore>${F.tipsAll ? 'ver menos' : `ver los ${tips.length}`}</button>` : '');
  }
  $('#fechTips').addEventListener('click', (e) => {
    if (e.target.closest('[data-tmore]')) { F.tipsAll = !F.tipsAll; renderTips(); return; }
    const b = e.target.closest('[data-tesp]'); if (!b) return;
    const p = S.products.find((x) => skuKey(x.id) === b.dataset.tesp); if (!p) return;
    if (S.cards.some((c) => c.items.some((i) => String(i.id) === String(p.id)))) { toast('Ya está en especiales'); return; }
    if (!(p.price > 0 && p.cost > 0 && p.cost < p.price)) { toast('Sin precio o costo para hacerle especial'); return; }
    const k = (S.risk = riskMap())[skuKey(p.id)];
    const s = specialPrice(p.price, p.cost, 'caduca') || r2(Math.max(psychUp(minPrice(p.cost)), p.price * 0.95));
    const c = makeCard([p], p.price, p.cost, Math.min(s, p.price));
    c.pinned = true; c.manual = true;
    if (k) { c.items[0].why = 'caduca'; c.items[0].exp = k; }
    if (c.nx) unsetNx(c); c.tag = tagFor(c);
    S.cards.unshift(c);
    S.view = 'esp'; store.set(K_VIEW, S.view); applyView(); render(true);
    toast('Mandado a especiales (queda fijado)');
    window.scrollTo({ top: $('#grid').offsetTop - 80, behavior: 'smooth' });
  });
  const fechFilterTxt = () => [F.dep || 'Todos los departamentos', F.f === '60' ? 'vencen en 60 días' : F.f === 'old' ? 'vencidas' : '', F.q ? `"${F.q}"` : ''].filter(Boolean).join(' · ');
  // Informe PDF (con fotos, por departamento; sin dinero) — misma vista de hojas que los especiales
  $('#fechPdf').addEventListener('click', () => {
    const rows = fechRows(); if (!rows.length) return;
    sheetReport = { rows, filtro: fechFilterTxt() }; sheetCards = []; sheetCat = null; sheetTheme = 'ctd';
    buildSheet(); openModal('#clientModal'); fitPages();
  });
  // Excel (con costo y valor para Oscar, Luis y Diego)
  $('#fechXls').addEventListener('click', () => {
    const rows = fechRows(); if (!rows.length || !window.XLSX) return;
    const m = canMoney();
    const data = rows.map((r) => {
      const p = fechProd(r.sku) || {};
      const o = { Departamento: r.dep, SKU: skuFech(r.sku) || r.sku, Producto: r.nombre, UPC: p.ean || (/^\d{8,14}$/.test(p.upc || '') ? p.upc : ''), Vence: fmtLong(r.d), 'Días': r.dias, Cajas: cajasDe(r), 'Llegaron': r.recibido };
      if (m) { o['Costo caja'] = p.cost || 0; o.Valor = r2(valorDe(r)); }
      o.Nota = r.riesgo ? 'No alcanza a venderse' : r.dias < 0 ? 'Vencido' : '';
      return o;
    });
    const ws = XLSX.utils.json_to_sheet(data), wb = XLSX.utils.book_new();
    ws['!cols'] = Object.keys(data[0]).map((k) => ({ wch: k === 'Producto' ? 44 : k === 'Departamento' ? 18 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws, 'Caducidades');
    const d = new Date();
    XLSX.writeFile(wb, `Caducidades-CTD-${d.getDate()}${MES[d.getMonth()]}-${d.getFullYear()}.xlsx`);
    toast('Excel guardado');
  });
  // Lo que vence pronto → especiales de la semana (fijados, con su precio especial sugerido)
  $('#fechEsp').addEventListener('click', () => {
    const rows = fechRows().filter((r) => r.dias >= 0 && (r.dias <= 60 || r.riesgo));
    const inCards = new Set(S.cards.flatMap((c) => c.items.map((i) => String(i.id))));
    let n = 0, skip = 0;
    rows.forEach((r) => {
      const p = S.products.find((x) => skuKey(x.id) === r.sku);
      if (!p || inCards.has(String(p.id)) || !(p.price > 0 && p.cost > 0 && p.cost < p.price) || isCredito(p)) { skip++; return; }
      const s = specialPrice(p.price, p.cost, 'caduca') || r2(Math.max(psychUp(minPrice(p.cost)), p.price * 0.95));
      const c = makeCard([p], p.price, p.cost, Math.min(s, p.price));
      c.pinned = true; c.manual = true;
      const rk = (S.risk = riskMap())[r.sku];
      c.items[0].why = 'caduca'; c.items[0].exp = rk || { d: r.d, dias: r.dias, quedan: cajasDe(r), sobran: cajasDe(r), rate: 0 };
      if (c.nx) unsetNx(c); c.tag = tagFor(c);
      S.cards.unshift(c); inCards.add(String(p.id)); n++;
    });
    if (!n) { toast(skip ? 'Ya están en especiales o no tienen precio/costo' : 'Nada que mandar'); return; }
    S.view = 'esp'; store.set(K_VIEW, S.view); applyView(); render(true);
    toast(`${n} ${n === 1 ? 'producto mandado' : 'productos mandados'} a especiales (quedan fijados)${skip ? ` · ${skip} ya estaban o sin precio` : ''}`);
    window.scrollTo({ top: $('#grid').offsetTop - 80, behavior: 'smooth' });
  });
  $('#fechList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-fdel]'); if (!b) return;
    if (!confirm('¿Quitar esta fecha puesta a mano?')) return;
    try { await cosCall('lote_del', { sku: b.dataset.fdel, fecha: b.dataset.d }); toast('Fecha quitada'); renderFechas(true); } catch (err) { toast(err.message); }
  });
  // Agregar fecha a mano: buscar producto → cajas → mes + año (misma hoja de Recibo)
  $('#fechAdd').addEventListener('click', async () => { const box = $('#fechAddBox'); box.hidden = !box.hidden; if (!box.hidden) { await recProducts(); $('#fechAddQ').focus(); } });
  $('#fechAddQ').addEventListener('input', (e) => {
    const q = normTxt(e.target.value.trim()), res = $('#fechAddRes');
    if (q.length < 2) { res.innerHTML = ''; return; }
    const list = S.products.length ? S.products : (R.cat || []);
    const hits = list.filter((p) => { const tx = normTxt(`${p.name} ${p.brand || ''} ${p.id} ${p.upc || ''}`); return q.split(/\s+/).every((w) => tx.includes(w)); }).slice(0, 10);
    res.innerHTML = hits.map((p) => `<button type="button" data-fp="${esc(p.id)}">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>SKU ${esc(p.id)}${p.stock != null ? ' · stock ' + nfmt(p.stock) : ''}</small></span></button>`).join('') || '<p class="data-info" style="padding:10px">Sin resultados</p>';
  });
  $('#fechAddRes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fp]'); if (!b) return;
    const list = S.products.length ? S.products : (R.cat || []);
    const p = list.find((x) => String(x.id) === b.dataset.fp); if (!p) return;
    const def = p.stock > 0 ? Math.round(p.stock) : 1;
    const raw = prompt(`¿Cuántas cajas de ${p.name} tienen esta fecha?`, String(def));
    const q = Number(raw); if (!(q > 0)) return;
    openSheetFor({ sku: String(p.id), nombre: p.name, photo: p.photo || '', caducidad: '', leida: '' }, async (fecha) => {
      if (!fecha) return;
      try {
        await cosCall('lote_add', { sku: String(p.id), nombre: p.name, fecha, q });
        toast(`Guardado: ${p.name} · vence ${fmtLong(fecha)} · ${nfmt(q)} cajas`);
        $('#fechAddQ').value = ''; $('#fechAddRes').innerHTML = ''; $('#fechAddBox').hidden = true;
        renderFechas(true);
      } catch (err) { toast('No se pudo guardar: ' + err.message); }
    });
  });

  // Riesgo por producto: el lote más próximo que no alcanza a venderse antes de su fecha (vendiendo primero lo más viejo).
  // { d, dias, quedan, sobran, rate (cajas/semana) } — solo si hay ventas y stock para estimarlo
  let riskMemo = null;
  // Producto nuevo: llegó hace poco y todavía no tiene historia de ventas (no se puede saber si alcanza a venderse)
  function esNuevo(p, sku) {
    const lot = (R.lotes || {})[sku];
    const llego = lot ? Math.max(0, ...Object.values(lot.fechas || {}).map((x) => x.ts || 0)) : 0;
    if (!llego || Date.now() - llego > 60 * DAY) return false;
    const st = p && p.st;
    if (!st || !(st.u365 > 0)) return true; // nunca se ha vendido
    const dias = Object.keys(st.d || {}).sort();
    return dias.length > 0 && daysTo(dias[0]) > -45; // empezó a venderse hace menos de 45 días
  }
  function riskMap() {
    const key = `${R.lotesV || 0}|${S.products.length}|${S.meta ? S.meta.at : ''}`;
    if (riskMemo && riskMemo.key === key) return riskMemo.val;
    const out = {}, rows = lotRows();
    rows.forEach((r) => {
      if (r.dias < 0 || out[r.sku]) return;
      const p = S.products.find((x) => skuKey(x.id) === r.sku);
      if (!p || !p.st || r.quedan == null || esNuevo(p, r.sku)) return;
      const rate = (p.st.u90 || 0) / 13, sold = (rate / 7) * r.dias;
      const sobran = Math.round(r.quedan - sold);
      if (sobran > 0) out[r.sku] = { d: r.d, dias: r.dias, quedan: r.quedan, sobran, rate: r2(rate) };
    });
    riskMemo = { key, val: out };
    return out;
  }
  const whyEff = (p) => (S.risk && S.risk[skuKey(p.id)] ? 'caduca' : p.why);

  // Caducidad más próxima de un producto (para Especiales / Costeo)
  function nextExpiry(sku) {
    const r = lotRows().filter((x) => x.sku === skuKey(sku));
    return r.length ? r[0] : null;
  }

  /* ================= INVENTARIO =================
   * Lo que hay en existencia según InSitu (se actualiza cada hora), por departamento, con buscador.
   * Sin dinero: solo producto, SKU, cajas y la fecha que vence primero. */
  const INV = { q: '', dep: '', soloStock: true, n: 60 };
  async function renderInventario(reload) {
    const box = $('#invList'); if (!box) return;
    if (reload) {
      box.innerHTML = '<p class="data-info">Cargando…</p>';
      if (!S.products.length && R.catAt && Date.now() - R.catAt > 15 * 60000) R.cat = null;
      await Promise.all([recProducts(), loadLotes()]);
    }
    const prods = fechProds().filter((p) => !isCredito(p));
    if (!prods.some((p) => p.stock != null)) { box.innerHTML = '<p class="data-info">Todavía no llega la existencia de InSitu a este dispositivo. Recarga en unos minutos.</p>'; return; }
    const proxima = {};
    lotRows().forEach((r) => { if (r.dias >= 0 && (!proxima[r.sku] || r.d < proxima[r.sku])) proxima[r.sku] = r.d; });
    let rows = prods.filter((p) => !INV.soloStock || p.stock > 0);
    const deps = {};
    rows.forEach((p) => { const d = p.cat || 'Otros'; deps[d] = (deps[d] || 0) + 1; });
    if (INV.dep && !deps[INV.dep]) INV.dep = '';
    $('#invDeps').innerHTML = [`<button type="button" class="${INV.dep ? '' : 'on'}" data-idep="">Todos <small>${rows.length}</small></button>`]
      .concat(Object.keys(deps).sort().map((d) => `<button type="button" class="${INV.dep === d ? 'on' : ''}" data-idep="${esc(d)}">${esc(d)} <small>${deps[d]}</small></button>`)).join('');
    if (INV.dep) rows = rows.filter((p) => (p.cat || 'Otros') === INV.dep);
    const q = normTxt(INV.q).trim();
    if (q) rows = rows.filter((p) => { const sku = skuFech(p.id); const tx = normTxt(`${p.name} ${sku} ${sku.replace('-', '')} ${p.upc || ''} ${p.ean || ''} ${p.id} ${p.brand || ''}`); return q.split(/\s+/).every((w) => tx.includes(w)); });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const cajas = rows.reduce((a, p) => a + Math.max(0, Number(p.stock) || 0), 0);
    $('#invInfo').textContent = `${rows.length} ${rows.length === 1 ? 'producto' : 'productos'} · ${nfmt(cajas)} cajas${R.catAt ? ` · existencia de InSitu de las ${fmtTs(R.catAt).split(' ').pop()}` : ''}`;
    const show = rows.slice(0, INV.n);
    box.innerHTML = show.map((p) => {
      const sku = skuFech(p.id), d = proxima[skuKey(p.id)], dd = d ? daysTo(d) : null;
      return `<div class="inv-r${p.stock > 0 ? '' : ' cero'}">
        <span class="inv-ph">${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
        <div class="inv-m">${sku ? `<small class="rec-row-sku">${esc(sku)}</small>` : ''}<b>${esc(p.name)}</b>
          <span class="meta">${esc(p.cat || 'Otros')}${p.pack ? ' · ' + esc(p.pack) : ''}${d ? ` · vence ${esc(fmtLong(d))}${dd <= 60 ? ` <span class="warn">(${dd} días)</span>` : ''}` : ''}</span></div>
        <div class="inv-q"><b>${nfmt(Math.max(0, Number(p.stock) || 0))}</b><small>${Number(p.stock) === 1 ? 'caja' : 'cajas'}</small></div>
      </div>`;
    }).join('') + (rows.length > INV.n ? `<button type="button" class="btn btn-ghost" data-imore>Ver más (${rows.length - INV.n})</button>` : '') || '<p class="data-info">Nada con esa búsqueda.</p>';
  }
  $('#invQ').addEventListener('input', (e) => { INV.q = e.target.value; INV.n = 60; renderInventario(false); });
  $('#invStock').addEventListener('change', (e) => { INV.soloStock = e.target.checked; renderInventario(false); });
  $('#invDeps').addEventListener('click', (e) => { const b = e.target.closest('[data-idep]'); if (!b) return; INV.dep = b.dataset.idep; INV.n = 60; renderInventario(false); });
  $('#invList').addEventListener('click', (e) => { if (e.target.closest('[data-imore]')) { INV.n += 120; renderInventario(false); } });
  $('#invXls').addEventListener('click', async () => {
    if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    const proxima = {};
    lotRows().forEach((r) => { if (r.dias >= 0 && (!proxima[r.sku] || r.d < proxima[r.sku])) proxima[r.sku] = r.d; });
    const data = fechProds().filter((p) => !isCredito(p) && (!INV.soloStock || p.stock > 0) && (!INV.dep || (p.cat || 'Otros') === INV.dep))
      .sort((a, b) => (a.cat || '').localeCompare(b.cat || '') || a.name.localeCompare(b.name))
      .map((p) => ({ Departamento: p.cat || 'Otros', SKU: skuFech(p.id) || '', Producto: p.name, 'Código de barras': p.ean || (/^\d{8,14}$/.test(p.upc || '') ? p.upc : ''), Empaque: p.pack || '', Existencia: Math.max(0, Number(p.stock) || 0), 'Vence primero': proxima[skuKey(p.id)] ? fmtLong(proxima[skuKey(p.id)]) : '' }));
    const ws = XLSX.utils.json_to_sheet(data), wb = XLSX.utils.book_new();
    ws['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 46 }, { wch: 16 }, { wch: 10 }, { wch: 11 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    const d = new Date();
    XLSX.writeFile(wb, `Inventario-CTD-${d.getDate()}${MES[d.getMonth()]}${d.getFullYear()}.xlsx`);
  });

  /* ================= CRÉDITOS A CLIENTES =================
   * Rocío (o Oscar/Luis/Diego) captura el crédito que pide el vendedor: cliente + productos CR- en piezas.
   * La IA revisa con las facturas de InSitu (12 meses) cuántas veces y a qué precio se le vendió, avisa si
   * algo no cuadra, sugiere el precio correcto y arma la hoja para imprimir. La nota se hace en InSitu
   * y aquí se marca con su número. */
  const CR = { list: null, ed: null, clientes: null, hist: {}, q: '' };
  const MOTIVOS = ['Caducado', 'Dañado', 'Cambio', 'Faltante', 'Otro'];
  const crProds = () => (S.products.length ? S.products : (R.cat || []));
  const baseName = (n) => String(n || '').replace(/^\s*CR\s*-\s*/i, '');
  // Producto original de un CR- (mismo nombre sin "CR-"); si no es exacto, el más parecido de la misma presentación
  function origDe(p) {
    if (!isCredito(p)) return p;
    const list = crProds().filter((x) => !isCredito(x)), b = normTxt(baseName(p.name)).replace(/\s+/g, ' ').trim();
    const ex = list.find((x) => normTxt(x.name).replace(/\s+/g, ' ').trim() === b);
    if (ex) return ex;
    let best = null;
    list.forEach((x) => { if (!sameSize(baseName(p.name), x.name)) return; const s = nameScore(baseName(p.name), x.name); if (s >= 0.75 && (!best || s > best.s)) best = { x, s }; });
    return best ? best.x : null;
  }
  // Versión CR- de un producto normal (para el precio por pieza)
  const crDe = (p) => (isCredito(p) ? p : crProds().find((x) => isCredito(x) && normTxt(baseName(x.name)).trim() === normTxt(p.name).trim()) || null);
  // Piezas por caja: "Caja 12", "CJ 12", "12/14OZ"
  function piezasPorCaja(p) {
    if (!p) return 1;
    const a = String(p.pack || '').match(/caja\s*(\d+)/i) || String(p.name || '').match(/\bcj\.?\s*(\d+)/i) || String(p.name || '').match(/(?:^|\s)(\d{1,3})\s*\/\s*\d/);
    return a ? Math.max(1, Number(a[1])) : 1;
  }

  async function crLoadList() {
    try { CR.list = (await cosCall('cr_list')).list || []; } catch (e) { CR.list = []; toast(e.message); }
    renderCreditos();
  }
  function renderCreditos() {
    const ed = CR.ed;
    $('#crHero').hidden = !!ed; $('#crEdit').hidden = !ed; $('#crListWrap').hidden = !!ed;
    if (ed) { renderCrEdit(); return; }
    if (!CR.list) { $('#crList').innerHTML = '<p class="data-info">Cargando…</p>'; crLoadList(); return; }
    const q = normTxt(CR.q).trim();
    const list = CR.list.filter((c) => !q || normTxt(`${c.cliente.name} ${c.vendedor} ${c.numero} ${(c.lineas || []).map((l) => l.nombre).join(' ')}`).includes(q));
    const pend = CR.list.filter((c) => c.status !== 'aplicado').length;
    $('#crInfo').textContent = CR.list.length ? `${CR.list.length} créditos · ${pend} pendientes en InSitu` : 'Todavía no hay créditos capturados.';
    $('#crList').innerHTML = list.map((c) => `
      <div class="hist-item hist-prop" data-crid="${esc(c.id)}">
        <div class="hi-top"><div class="hi-txt"><b>${esc(c.cliente.name)} · ${crM(c.total || 0)}</b>
          ${(c.lineas || []).reduce((a, l) => a + (l.piezas || 0), 0)} piezas · ${(c.lineas || []).length} ${(c.lineas || []).length === 1 ? 'producto' : 'productos'} · vendedor ${esc(c.vendedor || '—')} · ${esc(LABEL[c.by] || c.by || '')} · ${fmtTs(c.updated || c.ts)}</div></div>
        <div class="hi-acts">
          ${c.status === 'aplicado' ? `<span class="st sent">Aplicado · ${esc(c.numero)}</span>` : '<span class="st">Pendiente en InSitu</span>'}
          <button class="btn btn-ghost btn-sm" data-cr="open" type="button">Abrir</button>
          <button class="btn btn-ghost btn-sm" data-cr="pdf" type="button">${icon('printer')}Hoja</button>
          ${c.status === 'aplicado' ? '' : '<button class="btn btn-oro btn-sm" data-cr="qb" type="button">Crear nota en QuickBooks</button><button class="btn-link sm" data-cr="apl" type="button">ya la hice a mano</button>'}
          <button class="icon-btn" data-cr="del" type="button" title="Borrar" aria-label="Borrar">${icon('trash')}</button>
        </div></div>`).join('') || '<p class="data-info">Nada con esa búsqueda.</p>';
  }
  $('#crQ').addEventListener('input', (e) => { CR.q = e.target.value; renderCreditos(); });
  $('#crNew').addEventListener('click', () => { CR.ed = { cliente: null, vendedor: '', nota: '', lineas: [] }; renderCreditos(); window.scrollTo({ top: 0 }); });
  $('#crList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cr]'); if (!b) return;
    const c = CR.list.find((x) => x.id === b.closest('[data-crid]').dataset.crid); if (!c) return;
    const a = b.dataset.cr;
    if (a === 'open') { CR.ed = JSON.parse(JSON.stringify(c)); renderCreditos(); crCargarHist(); window.scrollTo({ top: 0 }); }
    if (a === 'pdf') { if (c.cliente.code && !CR.hist[c.cliente.code]) await crCargarHist(c); crPdf(c); }
    if (a === 'qb') {
      if (!confirm(`¿Crear la nota de crédito (Credit Memo) en QuickBooks?\n\n${c.cliente.name} · ${crM(c.total || 0)}\n${(c.lineas || []).map((l) => `• ${l.nombre}: ${l.piezas} pzas a ${money(l.precio)} (${l.motivo || ''})`).join('\n')}`)) return;
      if (c.cliente.code && !CR.hist[c.cliente.code]) await crCargarHist(c);
      const h = CR.hist[c.cliente.code];
      // Las compras de cada producto (con número de factura) van en la nota
      const compras = (c.lineas || []).map((l) => { const rv = crRevision(l, h && !h.error ? h : null); return rv.compras.slice(0, 4).map((x) => `${fmtLong(x.fecha)} · ${rv.cuanto(x)}${x.factura ? ' · #' + x.factura : ''}`).join('; '); });
      let extra = {};
      for (let k = 0; k < 2; k++) {
        try {
          b.disabled = true;
          const d = await cosCall('cr_qb', { id: c.id, compras, ...extra });
          alert(d.ya ? `Ya estaba en QuickBooks (nota ${d.qb.doc || d.qb.id}).` : `Listo ✓ Nota de crédito ${d.qb.doc || d.qb.id} en QuickBooks · ${crM(d.qb.total || 0)}`);
          crLoadList(); return;
        } catch (err) {
          b.disabled = false;
          if (err.code === 'no_customer' && err.data && err.data.customers) {
            const q = normTxt(prompt(`${err.message}\n\nEscribe parte del nombre del cliente en QuickBooks:`, c.cliente.name.split(' ').slice(0, 2).join(' ')) || '');
            if (!q) return;
            const res = err.data.customers.filter((x) => normTxt(x.name).includes(q)).slice(0, 12);
            if (!res.length) { alert('No encontré ese cliente en QuickBooks.'); return; }
            const n = Number(prompt(res.map((x, i) => `${i + 1}. ${x.name}`).join('\n') + '\n\nEscribe el número:', '1'));
            if (!res[n - 1]) return;
            extra = { customerId: res[n - 1].id }; continue;
          }
          alert('No se pudo crear en QuickBooks:\n\n' + err.message); return;
        }
      }
    }
    if (a === 'apl') {
      const n = prompt('Número de la nota de crédito que se hizo en InSitu (ej. HM102):', ''); if (!n) return;
      try { await cosCall('cr_aplicar', { id: c.id, numero: n.trim() }); toast('Nota de crédito registrada'); crLoadList(); } catch (err) { toast(err.message); }
    }
    if (a === 'del') {
      if (!confirm(`¿Borrar el crédito de ${c.cliente.name}?`)) return;
      try { await cosCall('cr_borrar', { id: c.id }); crLoadList(); } catch (err) { toast(err.message); }
    }
  });

  // ---- Editor ----
  const crM = (v) => (v > 0 ? '-' : '') + money(Math.abs(v)); // el crédito se muestra en negativo, como en InSitu
  const crTotal = (ed) => ed.lineas.reduce((a, l) => a + (l.piezas || 0) * (l.precio || 0), 0);
  function crRevision(l, h) {
    // Lo que dice el historial de ese cliente para esta línea
    const o = crProds().find((x) => String(x.id) === String(l.skuOrig)), ppc = piezasPorCaja(o);
    // ¿Esa factura vendió piezas o cajas? Muchos productos (Doña Nita, pan, mayonesa…) se venden por pieza aunque el nombre diga "CJ 12"
    const crP = crProds().find((x) => String(x.id) === String(l.sku));
    const refPz = crP && isCredito(crP) && crP.price > 0 ? crP.price : o && o.pack === 'Pieza' && o.price > 0 ? o.price : null;
    const fac = (x) => {
      const u = String(x.unidades || '');
      if (/each|pieza|pza|unidad|\bea\b|\bpc\b|^\s*1\s*$/i.test(u)) return 1;
      if (/case|caja|\bcs\b|\bcj\b/i.test(u)) return ppc;
      const mem = (CR.pz || {})[String(l.skuOrig || '').replace(/[.#$/[\]\s]+/g, '_')]; // lo que aprendió Costeo
      if (mem != null) return mem > 1 ? 1 : ppc;
      if (o && o.pack === 'Pieza') return 1;
      if (refPz && x.precio > 0 && Math.abs(x.precio - refPz) / refPz < 0.3) return 1;
      return ppc;
    };
    const cuanto = (x) => { const f = fac(x), n = Math.abs(x.cant); return `${nfmt(n)} ${f === 1 ? (n === 1 ? 'pieza' : 'piezas') : (n === 1 ? 'caja' : 'cajas')} a ${money(x.precio)}`; };
    const todas = (h ? h.lineas : []).filter((x) => x.sku === String(l.skuOrig) && x.cant > 0); // 3 años
    const hoy = Date.now(), compras = todas.filter((x) => hoy - Date.parse(x.fecha) <= 365 * 864e5);
    const previos = (h ? h.lineas : []).filter((x) => x.sku === String(l.sku) && x.cant < 0);
    const seis = compras.filter((x) => hoy - Date.parse(x.fecha) <= 183 * 864e5);
    const pzas6 = seis.reduce((a, x) => a + x.cant * fac(x), 0);
    const ult = compras[0] || todas[0], ppPagado = ult && ult.precio != null ? r2(ult.precio / fac(ult)) : null;
    const lista = ult && o && o.price > 0 ? (o.pack === 'Pieza' ? (fac(ult) === 1 ? o.price : o.price * ppc) : (fac(ult) === 1 ? (refPz || o.price / ppc) : o.price)) : 0;
    const especial = ult && lista > 0 && ult.precio < lista * 0.97;
    const alertas = [];
    if (!h) return { compras, previos, ppc, fac, cuanto, ppPagado, alertas, cargando: true };
    if (!l.skuOrig) alertas.push('No encontré el producto original de este CR-: revisa a mano.');
    else if (!compras.length) {
      const v = todas[0];
      if (v) alertas.push(`No se le ha vendido en 12 meses. La última vez fue el ${fmtLong(v.fecha)}${v.factura ? ` (#${v.factura})` : ''}: ${cuanto(v)}.`);
      else alertas.push(`No se le ha vendido este producto en 3 años (revisé sus ${h.facturas} facturas desde el ${fmtLong(h.desde)}).`);
      const par = crParecidos(l, h);
      if (par.length) alertas.push(`Lo más parecido que sí compró: ${par.map((x) => `${x.nombre} el ${fmtLong(x.fecha)}${x.factura ? ` (#${x.factura})` : ''}`).join('; ')}. Revisa si el vendedor se equivocó de producto.`);
    }
    else {
      const dias = Math.round((hoy - Date.parse(ult.fecha)) / 864e5);
      if (dias > 180) alertas.push(`La última compra fue hace ${dias} días (${fmtLong(ult.fecha)}).`);
      if (l.piezas > pzas6) alertas.push(`Pide ${l.piezas} piezas y en 6 meses compró ${nfmt(pzas6)}.`);
      if (ppPagado != null && l.precio > ppPagado + 0.01) alertas.push(`Se lo vendiste a ${money(ppPagado)} la pieza${especial ? ' (en especial)' : ''} el ${fmtLong(ult.fecha)}; el crédito va a ${money(l.precio)}.`);
    }
    if (previos.length) alertas.push(`Ya se le dio crédito de este producto: ${previos.slice(0, 2).map((x) => `${nfmt(-x.cant)} pzas el ${fmtLong(x.fecha)}`).join(', ')}.`);
    return { compras, previos, ppc, fac, cuanto, ppPagado, alertas, especial };
  }
  // Productos de la misma marca que el cliente sí compró (por si el vendedor reportó el producto equivocado)
  function crParecidos(l, h) {
    const n = (s) => normTxt(baseName(s)).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^\d/.test(w));
    const mio = n(l.nombreOrig || l.nombre); if (!mio.length) return [];
    const nombre = {}; crProds().forEach((p) => { nombre[String(p.id)] = p.name; });
    const vistos = {}, out = [];
    h.lineas.forEach((x) => {
      if (x.cant <= 0 || x.sku === String(l.skuOrig) || x.sku === String(l.sku) || vistos[x.sku] || !nombre[x.sku] || isCredito({ name: nombre[x.sku] })) return;
      const w = n(nombre[x.sku]);
      const comun = mio.filter((a) => w.includes(a)).length;
      if (w[0] === mio[0] || comun >= 2) { vistos[x.sku] = 1; out.push({ nombre: nombre[x.sku], fecha: x.fecha, factura: x.factura, s: comun }); }
    });
    return out.sort((a, b) => b.s - a.s || (a.fecha < b.fecha ? 1 : -1)).slice(0, 3);
  }
  function renderCrEdit() {
    const ed = CR.ed, h = ed.cliente ? CR.hist[ed.cliente.code] : null;
    $('#crCliSel').innerHTML = ed.cliente ? `<b>${esc(ed.cliente.name)}</b> <button type="button" class="btn-link sm" data-crx="cli">cambiar</button>` : '';
    $('#crCliBox').hidden = !!ed.cliente;
    $('#crVend').value = ed.vendedor || '';
    $('#crNota').value = ed.nota || '';
    $('#crHistInfo').textContent = !ed.cliente ? '' : !h ? 'Revisando sus facturas en InSitu…' : h.error ? `No se pudo revisar: ${h.error}` : `Revisé sus ${h.facturas} facturas de los últimos 3 años.`;
    $('#crLineas').innerHTML = ed.lineas.map((l, i) => {
      const rv = crRevision(l, h && !h.error ? h : null);
      return `<div class="cr-l" data-i="${i}">
        <div class="cr-lh"><div><b>${esc(l.nombre)}</b>${l.nombreOrig && l.nombreOrig !== l.nombre ? `<small>Original: ${esc(l.nombreOrig)} ${rv.compras.length && rv.compras.every((x) => rv.fac(x) === 1) ? ' · se vende por pieza' : ` · ${rv.ppc} piezas por caja`}</small>` : ''}</div>
          <button type="button" class="g-x" data-crx="rm" aria-label="Quitar">×</button></div>
        <div class="cr-lf">
          <label class="field"><span>Piezas</span><input type="number" inputmode="numeric" min="1" step="1" data-f="piezas" value="${l.piezas || 1}"></label>
          <label class="field"><span>Precio por pieza</span><input type="number" inputmode="decimal" min="0" step="0.01" data-f="precio" value="${(l.precio || 0).toFixed(2)}"></label>
          <label class="field"><span>Motivo</span><select data-f="motivo">${MOTIVOS.map((m) => `<option${l.motivo === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
          <div class="cr-sub"><span class="lbl">Subtotal</span><b>${crM((l.piezas || 0) * (l.precio || 0))}</b></div>
        </div>
        <div class="cr-rev">
          ${rv.cargando ? '<p class="status">Revisando historial…</p>' : ''}
          ${rv.alertas.map((a) => `<p class="cr-al">${icon('alert')}${esc(a)}</p>`).join('')}
          ${rv.ppPagado != null && Math.abs(rv.ppPagado - l.precio) > 0.01 ? `<button type="button" class="btn btn-ghost btn-sm" data-crx="usar" data-p="${rv.ppPagado}">Usar ${money(rv.ppPagado)} (lo que pagó)</button>` : ''}
          ${l.precioAuto && rv.ppPagado != null ? `<p class="cr-ok">Precio = lo que pagó por pieza en su última compra.</p>` : ''}
          ${rv.compras.length ? `<p class="lbl cr-hl">Compras de este producto (12 meses)</p><div class="cr-h">${rv.compras.slice(0, 8).map((x) => `<span>${esc(fmtLong(x.fecha))} · ${esc(rv.cuanto(x))}${rv.fac(x) > 1 ? ` <small>(${money(x.precio / rv.fac(x))}/pza)</small>` : ''}${x.factura ? ` · #${esc(x.factura)}` : ''}</span>`).join('')}</div>` : ''}
          ${!rv.cargando && !rv.alertas.length ? '<p class="cr-ok">✓ Cuadra con lo que se le vendió.</p>' : ''}
        </div></div>`;
    }).join('') || '<p class="data-info">Agrega los productos del crédito.</p>';
    $('#crTotal').textContent = crM(crTotal(ed));
    $('#crSave').disabled = !ed.cliente || !ed.lineas.length;
    $('#crPdfBtn').disabled = !ed.cliente || !ed.lineas.length;
  }
  async function crCargarHist(c) {
    const ed = c || CR.ed; if (!ed || !ed.cliente) return;
    if (!CR.pz) { try { CR.pz = (await cosCall('map', { proveedor: '' })).pz || {}; } catch (e) { CR.pz = {}; } }
    const code = ed.cliente.code;
    const skus = [...new Set(ed.lineas.flatMap((l) => [l.sku, l.skuOrig]).filter(Boolean))];
    try {
      const d = await cosCall('cr_historial', { code, skus });
      CR.hist[code] = d;
      // Sin producto CR-, el precio de la pieza es lo que pagó en su última compra (no el precio de lista)
      if (CR.ed && CR.ed.cliente && CR.ed.cliente.code === code) CR.ed.lineas.forEach((l) => {
        if (!l.precioAuto) return;
        const rv = crRevision(l, d); if (rv.ppPagado != null) l.precio = rv.ppPagado;
      });
      if (CR.ed && CR.ed.cliente && CR.ed.cliente.code === code && !CR.ed.vendedor && d.vendedor) CR.ed.vendedor = d.vendedor;
    } catch (e) { CR.hist[code] = { error: e.message, lineas: [] }; }
    if (CR.ed && !c) renderCrEdit();
  }
  // Clientes (de InSitu, vía servidor)
  $('#crCli').addEventListener('input', async (e) => {
    const q = normTxt(e.target.value.trim()), box = $('#crCliRes');
    if (q.length < 2) { box.innerHTML = ''; return; }
    if (!CR.clientes) { box.innerHTML = '<p class="data-info" style="padding:10px">Cargando clientes…</p>'; try { CR.clientes = (await cosCall('cr_clientes')).clientes || []; } catch (err) { box.innerHTML = `<p class="data-info" style="padding:10px">${esc(err.message)}</p>`; return; } }
    const res = CR.clientes.filter((c) => q.split(/\s+/).every((w) => normTxt(`${c.name} ${c.code} ${c.city}`).includes(w))).slice(0, 12);
    box.innerHTML = res.map((c) => `<button type="button" data-cli="${esc(c.code)}"><span>${esc(c.name)}<small>${esc(c.city || '')}${c.seller ? ' · ' + esc(c.seller) : ''}</small></span></button>`).join('') || '<p class="data-info" style="padding:10px">Sin resultados</p>';
  });
  $('#crCliRes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cli]'); if (!b) return;
    const c = CR.clientes.find((x) => x.code === b.dataset.cli); if (!c) return;
    CR.ed.cliente = { code: c.code, name: c.name };
    $('#crCli').value = ''; $('#crCliRes').innerHTML = '';
    delete CR.hist[c.code];
    renderCrEdit(); crCargarHist();
  });
  // Productos (CR- primero)
  $('#crProd').addEventListener('input', async (e) => {
    const q = normTxt(e.target.value.trim()), box = $('#crProdRes');
    if (q.length < 2) { box.innerHTML = ''; return; }
    if (!S.products.length && !R.cat) await recProducts();
    const res = crProds().filter((p) => q.split(/\s+/).every((w) => normTxt(`${p.name} ${p.id} ${p.upc || ''}`).includes(w)))
      .sort((a, b) => isCredito(b) - isCredito(a)).slice(0, 12);
    box.innerHTML = res.map((p) => `<button type="button" data-crp="${esc(p.id)}">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>SKU ${esc(p.id)} · ${money(p.price || 0)}${isCredito(p) ? ' por pieza' : ''}</small></span></button>`).join('') || '<p class="data-info" style="padding:10px">Sin resultados</p>';
  });
  $('#crProdRes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-crp]'); if (!b) return;
    const p = crProds().find((x) => String(x.id) === b.dataset.crp); if (!p) return;
    const o = origDe(p), cr = crDe(p) || p;
    const precio = isCredito(cr) && cr.price > 0 ? cr.price : o && o.price ? r2(o.price / piezasPorCaja(o)) : 0;
    CR.ed.lineas.unshift({ sku: String(cr.id), nombre: cr.name, skuOrig: o ? String(o.id) : '', nombreOrig: o ? o.name : '', piezas: 1, precio: r2(precio), motivo: 'Caducado', precioAuto: !isCredito(cr) });
    $('#crProd').value = ''; $('#crProdRes').innerHTML = '';
    renderCrEdit();
    if (CR.ed.cliente) crCargarHist();
  });
  $('#crEdit').addEventListener('input', (e) => {
    const el = e.target, row = el.closest('.cr-l');
    if (el.id === 'crVend') { CR.ed.vendedor = el.value; return; }
    if (el.id === 'crNota') { CR.ed.nota = el.value; return; }
    if (!row || !el.dataset.f) return;
    const l = CR.ed.lineas[Number(row.dataset.i)];
    if (el.dataset.f === 'piezas') l.piezas = Math.max(0, Math.round(Number(el.value) || 0));
    if (el.dataset.f === 'precio') { l.precio = r2(Number(el.value) || 0); l.precioAuto = false; }
    if (el.dataset.f === 'motivo') l.motivo = el.value;
    row.querySelector('.cr-sub b').textContent = crM((l.piezas || 0) * (l.precio || 0));
    $('#crTotal').textContent = crM(crTotal(CR.ed));
  });
  $('#crEdit').addEventListener('change', (e) => {
    const f = e.target.dataset.f; if (!f) return;
    if (f === 'motivo') CR.ed.lineas[Number(e.target.closest('.cr-l').dataset.i)].motivo = e.target.value;
    else renderCrEdit(); // revisa de nuevo con las piezas/precio ya escritos
  });
  $('#crEdit').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-crx]'); if (!b) return;
    const a = b.dataset.crx, row = b.closest('.cr-l'), i = row ? Number(row.dataset.i) : -1;
    if (a === 'cli') { CR.ed.cliente = null; CR.ed.vendedor = ''; renderCrEdit(); $('#crCli').focus(); }
    if (a === 'rm') { CR.ed.lineas.splice(i, 1); renderCrEdit(); }
    if (a === 'usar') { CR.ed.lineas[i].precio = Number(b.dataset.p); CR.ed.lineas[i].precioAuto = false; renderCrEdit(); }
  });
  $('#crCancel').addEventListener('click', () => { CR.ed = null; renderCreditos(); });
  async function crGuardar() {
    const ed = CR.ed;
    ed.lineas.forEach((l) => { const rv = crRevision(l, CR.hist[ed.cliente.code]); l.alerta = rv.alertas.join(' '); });
    const d = await cosCall('cr_save', { credito: ed });
    ed.id = d.id;
    return ed;
  }
  $('#crSave').addEventListener('click', async () => {
    try { await crGuardar(); toast('Crédito guardado'); CR.ed = null; CR.list = null; renderCreditos(); } catch (e) { toast('No se pudo guardar: ' + e.message); }
  });
  $('#crPdfBtn').addEventListener('click', async () => {
    try { const c = await crGuardar(); CR.list = null; crPdf({ ...c, total: crTotal(c), updated: Date.now() }); } catch (e) { toast(e.message); }
  });

  // ---- Hoja de crédito para imprimir ----
  async function crPdf(c) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const logo = await logoData();
    if (logo) doc.addImage(logo, 'PNG', 40, 34, 84, 45);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(20, 18, 12);
    doc.text('Hoja de crédito', W - 40, 52, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90, 84, 74);
    const d = new Date(c.updated || Date.now());
    doc.text(`${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}  ·  Capturó ${LABEL[c.by || S.who] || c.by || S.who}${c.numero ? `  ·  Nota InSitu ${c.numero}` : ''}`, W - 40, 68, { align: 'right' });
    doc.setTextColor(20, 18, 12); doc.setFontSize(11);
    doc.setFont('helvetica', 'bold'); doc.text('Cliente:', 40, 104); doc.setFont('helvetica', 'normal'); doc.text(c.cliente.name || '', 92, 104);
    doc.setFont('helvetica', 'bold'); doc.text('Vendedor:', 40, 120); doc.setFont('helvetica', 'normal'); doc.text(c.vendedor || '—', 102, 120);
    const h = CR.hist[c.cliente.code];
    doc.autoTable({
      startY: 136, margin: { left: 40, right: 40 },
      head: [['Producto', 'Motivo', 'Piezas', 'Precio pza', 'Subtotal']],
      body: c.lineas.map((l) => [l.nombre, l.motivo || '', l.piezas, money(l.precio), crM(l.piezas * l.precio)]),
      foot: [['', '', c.lineas.reduce((a, l) => a + l.piezas, 0), 'Total', crM(c.lineas.reduce((a, l) => a + l.piezas * l.precio, 0))]],
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [20, 18, 12] },
      headStyles: { fillColor: [15, 13, 10], textColor: [242, 163, 30], fontStyle: 'bold' },
      footStyles: { fillColor: [246, 242, 233], textColor: [20, 18, 12], fontStyle: 'bold' },
      columnStyles: { 2: { halign: 'right', cellWidth: 50 }, 3: { halign: 'right', cellWidth: 70 }, 4: { halign: 'right', cellWidth: 76, fontStyle: 'bold' } },
    });
    let y = doc.lastAutoTable.finalY + 22;
    // Revisión: compras del cliente y avisos por producto
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Revisión con facturas de InSitu (12 meses)', 40, y); y += 6;
    const rows = [];
    c.lineas.forEach((l) => {
      const rv = crRevision(l, h && !h.error ? h : null);
      const compras = rv.compras.slice(0, 6).map((x) => `${fmtLong(x.fecha)} · ${rv.cuanto(x)}${rv.fac(x) > 1 ? ` (${money(x.precio / rv.fac(x))}/pza)` : ''}${x.factura ? ` · #${x.factura}` : ''}`).join('\n') || 'Sin compras en 12 meses';
      rows.push([l.nombreOrig || l.nombre, compras, (rv.alertas.length ? rv.alertas : ['Cuadra con lo que se le vendió.']).join('\n')]);
    });
    doc.autoTable({
      startY: y + 6, margin: { left: 40, right: 40 },
      head: [['Producto original', 'Compras', 'Revisión']],
      body: rows,
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 5, textColor: [20, 18, 12], valign: 'top' },
      headStyles: { fillColor: [246, 242, 233], textColor: [20, 18, 12], fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 150 } },
    });
    y = doc.lastAutoTable.finalY + 20;
    if (c.nota) { doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(doc.splitTextToSize(`Notas: ${c.nota}`, W - 80), 40, y); y += 30; }
    if (y > 690) { doc.addPage(); y = 80; }
    doc.setDrawColor(150); doc.line(60, y + 50, 250, y + 50); doc.line(W - 250, y + 50, W - 60, y + 50);
    doc.setFontSize(9); doc.setTextColor(90, 84, 74);
    doc.text('Vendedor', 155, y + 64, { align: 'center' }); doc.text('Recibió / Autorizó', W - 155, y + 64, { align: 'center' });
    download(doc.output('blob'), `Credito-CTD-${normTxt(c.cliente.name).replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${d.getDate()}${MES[d.getMonth()]}.pdf`);
    toast('Hoja de crédito guardada');
  }

  /* ================= VENDEDORES =================
   * De las facturas de 12 meses: ventas por vendedor, sus clientes, a quién ya le toca pedir
   * (días desde el último pedido vs. cada cuánto compra) y qué dejó de comprar. */
  function parseInvDate(s) {
    const t = String(s || '');
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
    if (m) return new Date(+m[3], +m[1] - 1, +m[2]).getTime();
    const x = Date.parse(t.replace(' ', 'T'));
    return isFinite(x) ? x : NaN;
  }
  function computeSales(invs, today, items) {
    const T = today.getTime();
    const names = {};
    (items || []).forEach((p) => { names[String(p.id)] = p.name; });
    const sellers = {}, clients = {};
    for (const inv of invs) {
      if (inv.cancelled === true || inv.cancelled === 1 || /cancel|void|anulad/i.test(inv.status || '')) continue;
      const t = parseInvDate(inv.invoice_date || inv.invoice_ship_date);
      if (!isFinite(t)) continue;
      const age = Math.floor((T - t) / DAY);
      const mu = inv.mobile_user || {};
      const sid = String(inv.mobile_user_login || mu.login || inv.mobile_user_id || 'sin-vendedor');
      const s = (sellers[sid] = sellers[sid] || { id: sid, name: mu.name || inv.mobile_user_login || 'Sin vendedor', phone: mu.phone || '', s30: 0, p30: 0, s90: 0, inv30: 0, clients90: {} });
      if (!s.phone && mu.phone) s.phone = mu.phone;
      const net = Number(inv.invoice_netvalue) || 0;
      if (age <= 30) { s.s30 += net; s.inv30++; } else if (age <= 60) s.p30 += net;
      const cid = String(inv.client_nit || inv.account_number || inv.client_branch_code || inv.client_branch_name || '?');
      if (age <= 90) { s.s90 += net; s.clients90[cid] = 1; }
      const c = (clients[cid] = clients[cid] || { id: cid, name: inv.client_branch_name || cid, seller: sid, days: {}, last: 0, s90: 0, prods: {} });
      if (t >= c.last) { c.last = t; c.seller = sid; }
      c.days[ymd(new Date(t))] = 1;
      if (age <= 90) c.s90 += net;
      for (const l of inv.invoiceDetailList || []) {
        const code = String(l.product_code || '').trim(); const q = Number(l.quantity) || 0;
        if (!code || q <= 0) continue;
        const pr = (c.prods[code] = c.prods[code] || { recent: 0, before: 0, n: 0, last: 0 });
        if (age <= 45) pr.recent += q; else if (age <= 180) { pr.before += q; pr.n++; }
        if (t > pr.last) pr.last = t;
      }
    }
    const clientList = Object.values(clients).map((c) => {
      const d = Object.keys(c.days).sort();
      const gaps = [];
      for (let i = 1; i < d.length; i++) gaps.push(Math.round((Date.parse(d[i]) - Date.parse(d[i - 1])) / DAY));
      const g = gaps.filter((x) => x > 0).sort((a, b) => a - b);
      const every = g.length >= 2 ? g[Math.floor(g.length / 2)] : null;
      const since = Math.floor((T - c.last) / DAY);
      // "Dejó de comprar": lo compró 2+ veces entre 45 y 180 días atrás y nada en los últimos 45
      const lost = Object.entries(c.prods).filter(([, x]) => x.n >= 2 && x.recent === 0).sort((a, b) => b[1].before - a[1].before).slice(0, 5)
        .map(([code, x]) => ({ code, name: names[code] || code, before: r2(x.before) }));
      return { id: c.id, name: c.name, seller: c.seller, orders: d.length, last: ymd(new Date(c.last)), since, every, s90: r2(c.s90),
        due: every != null && since >= Math.max(3, Math.round(every * 1.15)), late: every != null ? since - every : null, lost };
    });
    const sellerList = Object.values(sellers).map((s) => ({
      id: s.id, name: s.name, phone: s.phone, s30: r2(s.s30), p30: r2(s.p30), s90: r2(s.s90), inv30: s.inv30,
      active90: Object.keys(s.clients90).length, due: clientList.filter((c) => c.seller === s.id && c.due).length,
    })).sort((a, b) => b.s30 - a.s30);
    // Los 5 clientes que más compran cada producto (últimos 6 meses)
    const buyers = {};
    Object.values(clients).forEach((c) => Object.entries(c.prods).forEach(([code, x]) => {
      const q = x.recent + x.before; if (!(q > 0)) return;
      (buyers[code] = buyers[code] || []).push({ id: c.id, name: c.name, seller: c.seller, q: r2(q) });
    }));
    Object.keys(buyers).forEach((k) => { buyers[k] = buyers[k].sort((a, b) => b.q - a.q).slice(0, 5); });
    return { at: Date.now(), sellers: sellerList, clients: clientList, buyers };
  }

  /* ---- Comportamiento del vendedor (InSitu: visitas, pedidos y rastreo) ---- */
  const VA = { data: {}, busy: {}, err: {}, rango: 'hoy' };
  const vaFechas = (r) => { const d = new Date(); const hoy = ymd(d); if (r === 'ayer') { const y = ymd(new Date(d.getTime() - DAY)); return [y, y]; } if (r === '7') return [ymd(new Date(d.getTime() - 6 * DAY)), hoy]; return [hoy, hoy]; };
  const vaKey = (r) => vaFechas(r).join('|');
  async function vaLoad(r) {
    const k = vaKey(r); if (VA.busy[k]) return VA.busy[k];
    const [desde, hasta] = vaFechas(r);
    VA.busy[k] = cosCall('vend_actividad', { desde, hasta }).then((d) => { VA.data[k] = d; delete VA.err[k]; }).catch((e) => { VA.err[k] = e.message; }).finally(() => { delete VA.busy[k]; });
    return VA.busy[k];
  }
  const vaDe = (r, login) => { const d = VA.data[vaKey(r)]; return d ? (d.vendedores || []).find((v) => v.login === login) || { dias: [], tot: { visitas: 0, conPedido: 0, pedidos: 0, venta: 0, cortas: 0 } } : null; };
  const h12 = (hm) => { if (!hm) return '—'; const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
  const pctV = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  function vaHoyLinea(login) {
    const v = vaDe('hoy', login); if (!v) return '';
    const x = v.dias[0];
    if (!x || !(x.visitas.length || x.pedidos)) return '<span class="vm va-hoy">Hoy: sin visitas registradas</span>';
    return `<span class="vm va-hoy">Hoy: ${x.visitas.length} visitas · ${x.conPedido} con pedido · ${money(x.venta)}${x.inicio ? ` · empezó ${h12(x.inicio)}` : ''}${x.cortas ? ` · <em class="dn">${x.cortas} muy cortas</em>` : ''}</span>`;
  }
  function renderVA(s, mine) {
    const box = $('#vaBox'); if (!box) return;
    const k = vaKey(VA.rango), v = vaDe(VA.rango, s.id);
    const tabs = `<div class="va-tabs">${[['hoy', 'Hoy'], ['ayer', 'Ayer'], ['7', '7 días']].map(([r, n]) => `<button type="button" data-va="${r}" class="${VA.rango === r ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    let body = '';
    if (!v) {
      if (VA.err[k]) body = `<p class="data-info">No se pudo leer InSitu: ${esc(VA.err[k])} <button type="button" class="btn-link" data-va="${VA.rango}">reintentar</button></p>`;
      else { body = '<p class="data-info">Leyendo visitas y pedidos de InSitu…</p>'; vaLoad(VA.rango).then(() => { if (venSel === s.id) renderVA(s, mine); }); }
    } else if (!v.dias.some((x) => x.visitas.length || x.pedidos)) {
      body = '<p class="data-info">Sin visitas ni pedidos registrados en InSitu en estas fechas.</p>';
    } else if (VA.rango !== '7') {
      const x = v.dias[v.dias.length - 1];
      body = `<div class="va-kpis">
          <span><small>Jornada</small><b>${h12(x.inicio)} – ${h12(x.fin)}</b>${x.horas != null ? `<em>${nfmt(x.horas)} h en la calle</em>` : ''}</span>
          <span><small>Visitas</small><b>${x.visitas.length}</b><em>${x.tiendas} tiendas</em></span>
          <span><small>Con pedido</small><b>${pctV(x.conPedido, x.visitas.length)}</b><em>${x.conPedido} de ${x.visitas.length}</em></span>
          <span><small>Pedidos</small><b>${money(x.venta)}</b><em>${x.pedidos} pedidos${x.pedidosSinVisita ? ` · ${x.pedidosSinVisita} sin visita` : ''}</em></span>
          <span><small>Tiempo por tienda</small><b>${x.minProm != null ? x.minProm + ' min' : '—'}</b>${x.cortas ? `<em class="dn">${x.cortas} de menos de 3 min</em>` : '<em>promedio</em>'}</span>
        </div>
        <div class="va-list">${x.visitas.map((w) => `<div class="va-v${w.pedido ? '' : ' sin'}${w.min != null && w.min < 3 ? ' corta' : ''}">
          <span class="va-h">${h12(w.hora)}</span>
          <span class="va-t"><b>${esc(w.tienda)}</b>${w.motivo ? `<small>${esc(w.motivo)}</small>` : ''}</span>
          <span class="va-d">${w.min != null ? w.min + ' min' : ''}</span>
          <span class="va-p">${w.pedido ? money(w.pedido) : 'sin pedido'}</span></div>`).join('')}</div>`;
    } else {
      const T = v.tot;
      body = `<div class="va-kpis">
          <span><small>Días trabajados</small><b>${T.dias}</b></span>
          <span><small>Visitas</small><b>${T.visitas}</b><em>${T.dias ? nfmt(r2(T.visitas / T.dias)) : 0} por día</em></span>
          <span><small>Con pedido</small><b>${pctV(T.conPedido, T.visitas)}</b><em>${T.conPedido} de ${T.visitas}</em></span>
          <span><small>Pedidos</small><b>${money(T.venta)}</b><em>${T.pedidos} pedidos</em></span>
          <span><small>Visitas muy cortas</small><b>${T.cortas}</b><em>menos de 3 min</em></span>
        </div>
        <div class="va-tabla"><div class="va-r va-hd"><span>Día</span><span>Jornada</span><span>Visitas</span><span>Con pedido</span><span>Pedidos</span></div>
        ${v.dias.map((x) => `<div class="va-r"><span>${esc(fmtD(x.dia))}</span><span>${h12(x.inicio)} – ${h12(x.fin)}</span><span>${x.visitas.length}${x.cortas ? ` <em class="dn">(${x.cortas} cortas)</em>` : ''}</span><span>${pctV(x.conPedido, x.visitas.length)}</span><span>${money(x.venta)}</span></div>`).join('')}</div>`;
      // A quién ya le toca pedir y no visitó en la semana
      const vis = new Set(v.dias.flatMap((x) => x.visitas.map((w) => normTxt(w.tienda))));
      const falt = (mine || []).filter((c) => c.due && !vis.has(normTxt(c.name))).slice(0, 12);
      if (falt.length) body += `<p class="lbl va-lbl">Ya les toca pedir y no los visitó en 7 días <small>(${falt.length})</small></p><p class="va-falt">${falt.map((c) => esc(c.name)).join(' · ')}</p>`;
    }
    box.innerHTML = `<div class="va-head"><p class="lbl">Cómo trabajó <small>(visitas y pedidos de InSitu)</small></p>${tabs}</div>${body}`;
    box.querySelectorAll('[data-va]').forEach((b) => b.addEventListener('click', () => { VA.rango = b.dataset.va; delete VA.err[vaKey(VA.rango)]; renderVA(s, mine); }));
  }

  let venSel = null;
  function renderVendors() {
    const sd = S.sales;
    if (!sd || !sd.sellers || !sd.sellers.length) {
      $('#venInfo').innerHTML = 'Faltan los datos de vendedores. Dale <button id="venSync" class="btn-link" type="button">actualizar de InSitu</button> (se sacan de las facturas).';
      const b = $('#venSync'); if (b) b.addEventListener('click', () => syncInsitu({ silent: true }).then(renderVendors, () => {}));
      $('#venGrid').innerHTML = ''; $('#venDetail').hidden = true;
      return;
    }
    $('#venInfo').textContent = `Según ${S.meta && S.meta.invoices ? S.meta.invoices + ' facturas' : 'las facturas'} de InSitu · actualizado ${fmtTs(sd.at)}`;
    if (avOk() && !AV.list && !AV.busy) loadAvisos().then(() => { if (S.view === 'ven') renderVendors(); });
    if (venSel) { renderVenDetail(); return; }
    $('#venDetail').hidden = true; $('#venGrid').hidden = false;
    const kh = vaKey('hoy'); if (!VA.data[kh] && !VA.busy[kh] && !VA.err[kh]) vaLoad('hoy').then(() => { if (S.view === 'ven' && !venSel) renderVendors(); });
    $('#venGrid').innerHTML = sd.sellers.map((s) => {
      const ch = s.p30 ? (s.s30 - s.p30) / s.p30 : null;
      return `<button type="button" class="vcard" data-sid="${esc(s.id)}">
        ${s.due ? `<span class="due">${s.due} por pedir</span>` : ''}
        ${(() => { const n = (AV.list || []).filter((a) => a.vendedorId === s.id).length; return n ? `<span class="due av">${n} por vencer en tiendas</span>` : ''; })()}
        <span class="vn">${esc(s.name)}</span>
        <span class="vs"><b>${money(s.s30)}</b> en 30 días${ch != null ? ` <em class="${ch >= 0 ? 'up' : 'dn'}">${ch >= 0 ? '▲' : '▼'} ${pct(Math.abs(ch), 0)}</em>` : ''}</span>
        <span class="vm">${s.inv30} facturas · ticket ${money(s.inv30 ? s.s30 / s.inv30 : 0)} · ${s.active90} clientes activos (90 días)</span>
        ${vaHoyLinea(s.id)}
      </button>`;
    }).join('');
  }
  $('#venGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sid]'); if (!b) return;
    venSel = b.dataset.sid; renderVendors(); window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  function renderVenDetail() {
    const sd = S.sales, s = sd.sellers.find((x) => x.id === venSel);
    if (!s) { venSel = null; renderVendors(); return; }
    const mine = sd.clients.filter((c) => c.seller === s.id).sort((a, b) => (b.due - a.due) || ((b.late ?? -999) - (a.late ?? -999)) || (b.s90 - a.s90));
    $('#venGrid').hidden = true;
    const box = $('#venDetail'); box.hidden = false;
    const promos = (vigData || []).filter((e) => e.status === 'activo');
    const avs = (AV.list || []).filter((a) => a.vendedorId === s.id);
    box.innerHTML = `
      <button id="venBack" class="btn-back" type="button"><span aria-hidden="true">←</span> Todos los vendedores</button>
      <div class="cos-h1"><div><p class="hud">Vendedor</p><h2 class="ven-h">${esc(s.name)}</h2>
        <p class="status">${money(s.s30)} en 30 días · ${money(s.s90)} en 90 · ${mine.length} clientes · <b>${s.due}</b> ya les toca pedir</p></div>
        <button id="venSend" class="btn btn-oro" type="button"><i data-icon="send"></i>Mandar a ${esc(s.name.split(' ')[0])}</button></div>
      <div id="vaBox" class="va-box"></div>
      ${avs.length ? `<div class="av-box"><p class="lbl">Producto por vencer en sus tiendas <small>(${avs.length})</small></p>${avHTML(avs)}</div>` : ''}
      <div class="ven-list">${mine.map((c) => `
        <div class="ven-c${c.due ? ' due' : ''}">
          <div class="ven-top"><b>${esc(c.name)}</b>${c.due ? `<span class="pill warn">le toca pedir${c.late > 0 ? ` · ${c.late} días tarde` : ''}</span>` : ''}</div>
          <div class="meta">Último pedido ${fmtD(c.last)} (hace ${c.since} ${c.since === 1 ? 'día' : 'días'})${c.every ? ` · compra cada ~${c.every} días` : ''} · ${c.orders} pedidos · ${money(c.s90)} en 90 días</div>
          ${c.lost.length ? `<div class="ven-lost"><small>Dejó de comprar:</small> ${c.lost.map((x) => esc(x.name)).join(' · ')}</div>` : ''}
        </div>`).join('') || '<p class="data-info">Sin clientes en las facturas.</p>'}</div>`;
    fillIcons(box);
    renderVA(s, mine);
    $('#venBack').addEventListener('click', () => { venSel = null; renderVendors(); });
    $('#venSend').addEventListener('click', async () => {
      const due = mine.filter((c) => c.due).slice(0, 15);
      const lines = due.map((c, i) => `${i + 1}. ${c.name} — último pedido hace ${c.since} días${c.every ? ` (compra cada ~${c.every})` : ''}${c.lost.length ? `\n   Ofrécele (dejó de comprar): ${c.lost.slice(0, 3).map((x) => x.name).join(', ')}` : ''}`);
      const txt = `Hola ${s.name.split(' ')[0]}, clientes que ya les toca pedir:\n\n${lines.join('\n') || '(ninguno por ahora)'}` +
        (avs.length ? `\n\nRevisa con estas tiendas, se les va a vencer (no han vuelto a comprar):\n${avs.slice(0, 10).map((a) => `• ${avLinea(a)}`).join('\n')}` : '') +
        (promos.length ? `\n\nPromos vigentes:\n${promos.map((e) => `• ${e.name}: ${money(e.special)}${e.original ? ` (antes ${money(e.original)})` : ''} hasta ${fmtD(e.to)}`).join('\n')}` : '');
      const phone = String(s.phone || '').replace(/\D/g, '');
      const num = phone.length === 10 ? '1' + phone : phone;
      if (window.matchMedia('(pointer: coarse)').matches && navigator.share && !num) { try { await navigator.share({ text: txt }); } catch (e) { /* cancelado */ } return; }
      window.open(`https://wa.me/${num}?text=${encodeURIComponent(txt)}`, '_blank', 'noopener');
      if (!num) toast('No tengo su teléfono en InSitu: elige el chat en WhatsApp');
    });
  }

  /* ================= VISTAS: Especiales | Órdenes ================= */
  S.view = store.get(K_VIEW, 'esp');
  function applyView() {
    if ($('#workspace').hidden) return;
    const ov = onlyView();
    if (ov && !ov.includes(S.view)) S.view = ov[0];
    const ord = S.view === 'ord', cos = S.view === 'cos', ven = S.view === 'ven', rec = S.view === 'rec', fech = S.view === 'fech', cat = S.view === 'cat', cred = S.view === 'cred', inv = S.view === 'inv';
    $$('#viewTabs button').forEach((b) => { const on = b.dataset.v === S.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    // En el celular las pestañas se deslizan: la activa siempre a la vista (y el botón de salir fijo a la derecha)
    const act = $('#viewTabs button.on'), bar = $('#viewTabs');
    if (act) bar.scrollLeft = Math.max(0, act.offsetLeft - (bar.clientWidth - act.offsetWidth) / 2);
    $('#espView').hidden = ord || cos || ven || rec || fech || cat || cred || inv;
    $('#invView').hidden = !inv;
    if (ord && !onlyView()) pushOrdenes(); // la copia para Órdenes de Jonathan se renueva al entrar a Órdenes
    if (inv) renderInventario(true);
    $('#credView').hidden = !cred;
    if (cred) { CR.list = null; renderCreditos(); }
    $('#catView').hidden = !cat;
    if (cat) renderCatalogo();
    $('#venView').hidden = !ven;
    $('#recView').hidden = !rec;
    $('#fechView').hidden = !fech;
    if (fech) renderFechas(true);
    if (rec) { R.list = null; renderRecibo(); recAlDia(); }
    $('#ordView').hidden = !ord;
    $('#cosView').hidden = !cos;
    $('#dock').hidden = ord || cos || ven || rec || fech || cat || cred || inv;
    $('#ordDock').hidden = !ord || O.vendor === null;
    $('#cosDock').hidden = !cos;
    if (cos) renderCosteo();
    if (!ord && !cos && !ven && !rec && !fech && !cat && !cred && !inv) loadVigentes();
    if (ven) renderVendors();
    if (ord) {
      if (!O.lines.length && !O.touched) suggestOrder(); else renderOrders();
      // Datos viejos sin compras (de antes de Órdenes): se bajan solas
      if (S.meta && S.meta.source === 'InSitu' && !S.meta.receipts && Insitu.token() && !syncing) syncInsitu({ silent: true }).then(() => {}, () => {});
    }
  }
  $('#viewTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.view = b.dataset.v; store.set(K_VIEW, S.view);
    applyView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ================= ÓRDENES DE COMPRA ================= */
  // Cuánto pedir = venta por día × (cada cuánto le compras + días de entrega) × (1 + colchón) − stock.
  // "Cada cuánto" sale de las recepciones reales en InSitu (por producto; si no, del proveedor; si no, 21 días).
  // vendor: null = todavía no se elige proveedor (pantalla "¿A quién le vas a pedir?"), '' = todos
  const O = Object.assign({ vendor: null, lines: [], id: null, status: 'borrador', touched: false }, store.get(K_ORD, {}));
  if (!O.lines.length && !O.touched) O.vendor = null;
  const OS = Object.assign({ lead: 3, safety: 25 }, store.get(K_ORDSET, {}));
  const saveDraft = () => store.set(K_ORD, { vendor: O.vendor, lines: O.lines, id: O.id, status: O.status, touched: O.touched });
  O.recent = [];
  let unOrd = null;

  const weeklyRate = (st) => (0.6 * (st.u30 / 30) + 0.4 * (st.u90 / 90)) * 7; // pesa más lo reciente
  // Productos que están en un especial guardado vigente → se venderá más
  function inSpecial() {
    const today = ymd(new Date());
    const ids = new Set();
    (S.hist || []).forEach((h) => { if ((h.to || '') >= today) (h.cards || []).forEach((c) => (c.items || []).forEach((i) => ids.add(String(i.id)))); });
    return ids;
  }

  // Productos que se venden por pieza pero se compran por caja (ej. Mayonesa BB, CJ 32 UNDS): la orden va en cajas
  function pzPorCaja(p) {
    if (!/pieza/i.test(p.pack || '') && !/each|count/i.test(p.units || '')) return 0;
    const mem = store.get(PZ_KEY, {})[String(p.id)];
    if (mem > 1) return mem;
    const s = String(p.name || '');
    const m = s.match(/\bCJ\.?\s*(\d{1,3})\b/i) || s.match(/\b(\d{1,3})\s*(?:UNDS?|UDS|UNIDADES|PZAS?|PIEZAS|PCS|CT)\b/i);
    const n = m ? Number(m[1]) : 0;
    return n > 1 ? n : 0;
  }
  function lineFor(p, special) {
    const st = p.st;
    if (!st) return null;
    const pzc = pzPorCaja(p), f = pzc > 1 ? pzc : 1; // ventas y existencia vienen en piezas → se pasan a cajas
    const rate = weeklyRate(st) / f;
    const cycle = Math.min(42, (p.buy && p.buy.cycle) || 21); // tope 6 semanas: compras muy espaciadas no disparan órdenes enormes
    const days = cycle + OS.lead;
    const boost = special.has(String(p.id)) ? 1.3 : 1;
    const need = (rate / 7) * days * (1 + OS.safety / 100) * boost;
    const stock = p.stock != null ? Math.max(0, p.stock) / f : 0;
    const qty = Math.ceil(need - stock - 1e-9);
    const left = rate > 0 ? stock / (rate / 7) : Infinity;
    return {
      id: String(p.id), name: p.name, upc: p.upc || '', pack: pzc > 1 ? `Caja ${pzc} (se vende por pieza)` : p.pack || '', photo: p.photo || '',
      vendor: (p.buy && p.buy.vendor) || p.vendor || 'Sin proveedor',
      cost: ((p.buy && p.buy.lastCost) || p.cost || 0) * f, pzCaja: pzc > 1 ? pzc : 0,
      qty, sug: qty, rate: r2(rate), stock: p.stock != null ? r2(p.stock / f) : p.stock, left: isFinite(left) ? Math.round(left) : null,
      cycle, cycleOwn: !!(p.buy && p.buy.cycleOwn), lastBuy: p.buy ? p.buy.last : null, boost: boost > 1,
    };
  }

  // ---- Explicación de cada renglón (se recalcula al cambiar la cantidad) ----
  const stockOf = (l) => Math.max(0, Number(l.stock) || 0); // InSitu a veces marca stock negativo
  const coverDays = (l, qty) => (l.rate > 0 ? Math.round((stockOf(l) + qty) / (l.rate / 7)) : null);
  const span = (d) => (d < 14 ? `~${d} ${d === 1 ? 'día' : 'días'}` : `~${Math.round(d / 7)} semanas`);
  const until = (d) => { const t = new Date(); t.setDate(t.getDate() + d); return fmtD(ymd(t)) + (t.getFullYear() !== new Date().getFullYear() ? ' ' + t.getFullYear() : ''); };
  const targetDays = (l) => (l.cycle || 21) + OS.lead;
  const isShort = (l) => { const c = coverDays(l, l.qty); return c != null && c < targetDays(l); };

  function whyLine(l) {
    const rk = R.lotes ? riskMap()[skuKey(l.id)] : null;
    if (rk) return `⚠ No pidas todavía: tienes ~${cajas(rk.quedan)} que vencen el ${fmtLong(rk.d)} y se venden ~${nfmt(rk.rate)} por semana; sobran ~${cajas(rk.sobran)}. ` + whyLine0(l);
    return whyLine0(l);
  }
  function whyLine0(l) {
    const st = Number(l.stock) || 0;
    const left = l.rate > 0 && st > 0 ? Math.round(st / (l.rate / 7)) : 0;
    const stockTxt = st < 0 ? `no hay (InSitu marca ${nfmt(st)})` : st === 0 ? 'ya no hay' : `quedan ${cajas(st)} (${span(left)})`;
    const base = l.rate > 0 ? (l.pzCaja ? `Vendes ~${nfmt(l.rate * l.pzCaja)} piezas/semana (~${nfmt(l.rate)} cajas de ${l.pzCaja}) y ${stockTxt}.` : `Vendes ~${nfmt(l.rate)} cajas/semana y ${stockTxt}.`) : '';
    if (l.manual && !base) return `Agregado a mano. Con ${cajas(l.qty)}.`;
    const cyc = l.cycleOwn ? `Le compras cada ~${l.cycle} días` : `Se compra cada ~${l.cycle} días (${l.lastBuy ? 'promedio del proveedor' : 'estimado'})`;
    if (!l.manual && l.qty === l.sug) {
      return `${base} ${cyc} + ${OS.lead} de entrega + ${OS.safety}% colchón → pide ${l.sug}.` + (l.boost ? ' Incluye +30% porque está en un especial vigente.' : '');
    }
    if (l.qty === 0) return `${base} Sin pedir, ${st > 0 ? `solo te alcanza para ${span(left)}` : 'te quedas sin producto'}.`;
    const c = coverDays(l, l.qty);
    let txt = `${base} Con ${cajas(l.qty)} te alcanza para ${span(c)} (hasta ${until(c)}).`;
    if (!l.manual) {
      const diff = l.qty - l.sug;
      if (diff > 0) {
        const extra = c - coverDays(l, l.sug);
        txt += ` Son ${diff} más de lo sugerido: ${span(extra)} extra de inventario${canMoney() ? ` (+${money(diff * (l.cost || 0))})` : ''}.`;
      } else {
        const falta = targetDays(l) - c;
        txt += ` Son ${-diff} menos de lo sugerido: ` + (falta > 0 ? `te quedas corto ~${falta} días antes de que llegue el siguiente pedido.` : 'todavía alcanza para el siguiente pedido.');
      }
    } else if (c < targetDays(l)) {
      txt += ` Se acaba ~${targetDays(l) - c} días antes de que llegue el siguiente pedido.`;
    }
    return txt;
  }

  function kHTML(l) {
    if (!(l.rate > 0) && l.manual) return '';
    const st = Number(l.stock) || 0;
    const c = coverDays(l, l.qty);
    return `<span><b>${nfmt(Math.max(0, st))}</b> stock${st < 0 ? ` (InSitu ${nfmt(st)})` : ''}</span><span><b>${nfmt(l.rate)}</b> /semana</span>` +
      `<span><b>${l.cycle}</b> días entre compras</span>${l.lastBuy ? `<span>última compra <b>${fmtD(l.lastBuy)}</b></span>` : ''}` +
      (c != null && l.qty > 0 ? `<span>con la orden alcanza <b>${span(c)}</b></span>` : '');
  }

  function refreshLine(el, l) {
    const w = el.querySelector('.ol-why');
    w.textContent = whyLine(l);
    w.classList.toggle('hot', isShort(l));
    w.classList.toggle('over', !l.manual && l.qty > l.sug);
    const k = el.querySelector('.ol-k');
    if (k) k.innerHTML = kHTML(l);
    el.classList.toggle('edited', l.qty !== l.sug);
  }

  function allSuggestions() {
    const special = inSpecial();
    const risk = R.lotes ? riskMap() : {};
    O.expSkip = [];
    return S.products
      .filter((p) => { const k = risk[skuKey(p.id)]; if (k) O.expSkip.push({ p, k }); return !k; }) // tiene producto por caducar: no pedir
      .filter((p) => p.st && p.st.u90 > 0 && !EXCLUDE_CATS.includes(p.cat) && !isCredito(p)) // CR- (crédito) no se sugiere
      .map((p) => lineFor(p, special))
      .filter((l) => l && l.qty > 0);
  }

  function suggestOrder() {
    if (O.vendor === null) { renderOrders(); return; }
    const manual = O.lines.filter((l) => l.manual);
    const sug = allSuggestions().filter((l) => !O.vendor || l.vendor === O.vendor);
    const ids = new Set(sug.map((l) => l.id));
    O.lines = [...sug, ...manual.filter((l) => !ids.has(l.id))];
    O.id = null; O.status = 'borrador'; O.touched = false;
    saveDraft();
    renderOrders();
  }

  // Proveedores con productos comprados: cuándo fue el último pedido y cada cuánto se les compra
  function vendorSummary() {
    const sug = allSuggestions();
    const V = {};
    const get = (v) => (V[v] = V[v] || { name: v, n: 0, cajas: 0, last: null, cycles: [] });
    S.products.forEach((p) => {
      if (!p.buy || !p.buy.vendor) return;
      const x = get(p.buy.vendor);
      if (!x.last || p.buy.last > x.last) x.last = p.buy.last;
      if (p.buy.cycle) x.cycles.push(p.buy.cycle);
    });
    sug.forEach((l) => { const x = get(l.vendor); x.n++; x.cajas += l.qty; });
    const today = Date.parse(ymd(new Date()));
    return Object.values(V).map((x) => {
      const cycle = median(x.cycles);
      const since = x.last ? Math.round((today - Date.parse(x.last)) / DAY) : null;
      return { ...x, cycle, since, due: x.n > 0 && cycle != null && since != null && since >= cycle * 0.9 };
    });
  }

  function renderPicker() {
    const vs = vendorSummary();
    const real = vs.filter((v) => v.name !== 'Sin proveedor').sort((a, b) => (b.due - a.due) || (b.n - a.n) || a.name.localeCompare(b.name));
    const sinProv = vs.find((v) => v.name === 'Sin proveedor');
    const total = vs.reduce((a, v) => a + v.n, 0);
    const m = S.meta || {};
    $('#ordPickInfo').innerHTML = onlyView() && !S.ordAt ? 'Todavía no llegan las ventas y compras para calcular las órdenes: que Oscar, Luis o Diego abran la IA una vez y luego recarga.' : S.ordAt ? `Según las ventas, el inventario y las compras de InSitu · datos de las ${esc(fmtTs(S.ordAt))}.` : m.receipts
      ? `Según tus ventas, inventario y <b>${m.receipts} compras</b> registradas en InSitu.`
      : (syncing ? 'Bajando tus compras de InSitu…' : 'Todavía no se bajan tus compras de InSitu, por eso no salen tus proveedores.') +
        (Insitu.token() && !syncing ? ' <button id="ordSync" class="btn-link" type="button">Bajar compras ahora</button>' : '');
    const os = $('#ordSync');
    if (os) os.addEventListener('click', () => syncInsitu({ silent: true }).catch(() => {}));
    const card = (v, cls = '') => `<button type="button" class="vcard ${cls}" data-v="${esc(v.name)}">
        ${v.due ? '<span class="due">Toca pedir</span>' : ''}
        <span class="vn">${esc(v.name)}</span>
        <span class="vs">${v.n ? `<b>${v.n}</b> productos por pedir · <b>${nfmt(v.cajas)}</b> cajas` : 'Nada urgente por pedir'}</span>
        ${v.last ? `<span class="vm">Último pedido ${fmtD(v.last)} (hace ${v.since} ${v.since === 1 ? 'día' : 'días'})${v.cycle ? ` · le compras cada ~${v.cycle} días` : ''}</span>` : ''}
      </button>`;
    $('#ordVendorGrid').innerHTML = real.map((v) => card(v)).join('') +
      (sinProv && sinProv.n ? card({ ...sinProv, due: false }, 'all') : '') +
      `<button type="button" class="vcard all" data-v=""><span class="vn">Todos los proveedores</span><span class="vs"><b>${total}</b> productos · una orden agrupada por proveedor</span></button>`;
  }
  $('#ordVendorGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.vcard'); if (!b) return;
    O.vendor = b.dataset.v; O.lines = []; O.touched = false; O.id = null; O.no = null;
    $('#ordReviewOut').hidden = true;
    suggestOrder();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#ordChange').addEventListener('click', () => {
    if (O.touched && O.lines.length && O.status !== 'enviada' && !confirm('¿Cambiar de proveedor? Esta orden se descarta (dale Guardar antes si la quieres conservar).')) return;
    O.vendor = null; O.lines = []; O.touched = false; O.id = null; O.no = null;
    $('#ordReviewOut').hidden = true;
    saveDraft(); renderOrders();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  function renderOrders() {
    const picking = O.vendor === null;
    $('#ordPicker').hidden = !picking;
    $('#ordEditor').hidden = picking;
    if (S.view === 'ord') $('#ordDock').hidden = picking;
    if (picking) { renderPicker(); return; }
    $('#ordTitle').textContent = O.vendor || 'Todos los proveedores';
    const m = S.meta || {};
    $('#ordInfo').innerHTML = onlyView() && !S.ordAt ? 'Todavía no llegan las ventas y compras: que Oscar, Luis o Diego abran la IA una vez.' : S.ordAt ? `Calculado con las ventas y compras de InSitu · datos de las ${esc(fmtTs(S.ordAt))}` : m.receipts
      ? `Calculado con tus ventas y <b>${m.receipts} recepciones</b> de InSitu · stock al ${fmtTs(m.at)}`
      : (syncing ? 'Bajando tus compras de InSitu…' : 'Todavía no se bajan tus compras de InSitu, por eso todo sale "Sin proveedor".') +
        (Insitu.token() && !syncing ? ' <button id="ordSync" class="btn-link" type="button">Bajar compras ahora</button>' : '');
    const os = $('#ordSync');
    if (os) os.addEventListener('click', () => syncInsitu({ silent: true }).catch(() => {}));
    $('#ordLead').value = OS.lead;
    $('#ordSafety').value = OS.safety;

    const skip = (O.expSkip || []).filter((x) => !O.vendor || ((x.p.buy && x.p.buy.vendor) || x.p.vendor || 'Sin proveedor') === O.vendor);
    if (skip.length) $('#ordInfo').insertAdjacentHTML('beforeend', `<span class="ord-exp"> · <b>No pidas todavía:</b> ${skip.slice(0, 4).map((x) => `${esc(x.p.name)} (sobran ~${nfmt(x.k.sobran)} que vencen el ${esc(fmtLong(x.k.d))})`).join(', ')}${skip.length > 4 ? ` y ${skip.length - 4} más` : ''}.</span>`);
    const list = $('#ordList');
    if (!O.lines.length) {
      list.innerHTML = `<div class="empty"><p class="hud">Nada que pedir</p>Con el stock actual no hace falta pedir${O.vendor ? ' a ' + esc(O.vendor) : ''}. Puedes agregar productos con el buscador.</div>`;
    } else {
      const groups = {};
      O.lines.forEach((l) => { (groups[l.vendor] = groups[l.vendor] || []).push(l); });
      list.innerHTML = Object.entries(groups).map(([v, ls]) => {
        ls.sort((a, b) => (a.left ?? 1e9) - (b.left ?? 1e9));
        const cj = ls.reduce((a, l) => a + (Number(l.qty) || 0), 0);
        return `<div class="ord-group"><div class="ord-gh"><h3>${esc(v)}</h3><span>${ls.length} productos · ${nfmt(cj)} cajas</span></div>${ls.map(lineHTML).join('')}</div>`;
      }).join('');
    }
    renderOrdTotals();
  }

  function lineHTML(l) {
    const img = l.photo ? `<img src="${esc(l.photo)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<article class="ol${l.qty !== l.sug ? ' edited' : ''}" data-id="${esc(l.id)}">
      <div class="ol-ph">${img}</div>
      <div class="ol-main">
        <div class="ol-name">${esc(l.name)}</div>
        <div class="meta">SKU ${esc(l.id)}${l.upc ? ' · UPC ' + esc(l.upc) : ''}${l.pack ? ' · ' + esc(l.pack) : ''}</div>
        <p class="ol-why${isShort(l) ? ' hot' : ''}${!l.manual && l.qty > l.sug ? ' over' : ''}">${esc(whyLine(l))}</p>
        <div class="ol-k">${kHTML(l)}</div>
      </div>
      <div class="ol-qty">
        <div class="stepper"><button type="button" data-q="-1" aria-label="Menos">−</button><input type="number" inputmode="numeric" min="0" step="1" value="${l.qty}" aria-label="Cajas de ${esc(l.name)}"><button type="button" data-q="1" aria-label="Más">+</button></div>
        ${l.manual ? '' : `<span class="ol-sug">sugerido ${l.sug}</span>`}
        <button class="icon-btn ol-del" type="button" data-del aria-label="Quitar ${esc(l.name)}">${icon('trash')}</button>
      </div>
    </article>`;
  }

  function renderOrdTotals() {
    const ls = O.lines.filter((l) => l.qty > 0);
    const cj = ls.reduce((a, l) => a + l.qty, 0);
    const cost = ls.reduce((a, l) => a + l.qty * (l.cost || 0), 0);
    const nv = new Set(ls.map((l) => l.vendor)).size;
    $('#ordKpis').hidden = !O.lines.length;
    $('#ordKpis').innerHTML = `
      <div class="kpi"><span class="lbl">Productos</span><div class="kpi-v">${ls.length}</div></div>
      <div class="kpi"><span class="lbl">Cajas</span><div class="kpi-v">${nfmt(cj)}</div></div>
      ${canMoney() ? `<div class="kpi"><span class="lbl">Costo estimado</span><div class="kpi-v">${money(cost)}</div></div>` : ''}
      <div class="kpi"><span class="lbl">Proveedores</span><div class="kpi-v">${nv}</div></div>`;
    const has = ls.length > 0;
    $('#ordSend').disabled = !has; $('#ordSave').disabled = !has; $('#ordPdf').disabled = !has;
    $('#ordReview').disabled = !has || reviewing;
  }

  $('#ordRecalc').addEventListener('click', () => {
    if (O.touched && !confirm('¿Recalcular? Se pierden los cambios de cantidades (los productos agregados a mano se quedan).')) return;
    suggestOrder();
    toast('Orden recalculada');
  });
  ['#ordLead', '#ordSafety'].forEach((id) => $(id).addEventListener('change', () => {
    OS.lead = Math.max(0, parseFloat($('#ordLead').value) || 0);
    OS.safety = Math.max(0, parseFloat($('#ordSafety').value) || 0);
    store.set(K_ORDSET, OS);
    if (!O.touched) suggestOrder(); else { renderOrders(); toast('Dale Recalcular para aplicar'); }
  }));

  function setQty(el, q) {
    const l = O.lines.find((x) => x.id === el.dataset.id); if (!l) return;
    l.qty = Math.max(0, Math.round(q) || 0);
    O.touched = true;
    const inp = el.querySelector('.stepper input');
    if (document.activeElement !== inp) inp.value = l.qty;
    refreshLine(el, l);
    saveDraft();
    renderOrdTotals();
  }
  $('#ordList').addEventListener('click', (e) => {
    const el = e.target.closest('.ol'); if (!el) return;
    const l = O.lines.find((x) => x.id === el.dataset.id); if (!l) return;
    const b = e.target.closest('[data-q]');
    if (b) { setQty(el, l.qty + Number(b.dataset.q)); return; }
    if (e.target.closest('[data-del]')) {
      O.lines = O.lines.filter((x) => x !== l);
      O.touched = true; saveDraft(); renderOrders();
    }
  });
  // Al escribir la cantidad, el texto se recalcula al momento
  $('#ordList').addEventListener('input', (e) => {
    const inp = e.target.closest('.stepper input'); if (!inp || inp.value === '') return;
    setQty(inp.closest('.ol'), parseFloat(inp.value));
  });
  $('#ordList').addEventListener('change', (e) => {
    const inp = e.target.closest('.stepper input'); if (!inp) return;
    setQty(inp.closest('.ol'), parseFloat(inp.value));
  });

  // Buscador para agregar productos a mano
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  $('#ordSearch').addEventListener('input', (e) => {
    const q = norm(e.target.value.trim());
    const box = $('#ordResults');
    if (q.length < 2) { box.hidden = true; return; }
    const words = q.split(/\s+/);
    const res = S.products.filter((p) => { const t = norm(`${p.name} ${p.id} ${p.upc} ${p.brand}`); return words.every((w) => t.includes(w)); }).slice(0, 12);
    box.innerHTML = res.length ? res.map((p) => `<button type="button" role="option" data-add="${esc(p.id)}">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>SKU ${esc(p.id)}${p.stock != null ? ' · stock ' + nfmt(p.stock) : ''}${isCredito(p) ? ' · crédito (CR-)' : ''}</small></span></button>`).join('')
      : '<p class="data-info" style="padding:10px">Sin resultados</p>';
    box.hidden = false;
  });
  $('#ordResults').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    const p = S.products.find((x) => String(x.id) === b.dataset.add); if (!p) return;
    const ex = O.lines.find((l) => l.id === String(p.id));
    if (ex) { toast('Ya está en la orden'); }
    else {
      const base = lineFor(p, inSpecial()) || {};
      const q = Math.max(1, Math.round((p.buy && p.buy.typQty) || base.qty || 1));
      O.lines.push({ ...base, id: String(p.id), name: p.name, upc: p.upc || '', pack: p.pack || '', photo: p.photo || '',
        vendor: (p.buy && p.buy.vendor) || p.vendor || O.vendor || 'Sin proveedor', cost: (p.buy && p.buy.lastCost) || p.cost || 0,
        qty: q, sug: q, manual: true });
      O.touched = true; saveDraft(); renderOrders();
      toast('Agregado: ' + p.name);
    }
    $('#ordSearch').value = ''; $('#ordResults').hidden = true;
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.ord-search')) $('#ordResults').hidden = true; });

  // ---- Revisar con Claude ----
  let reviewing = false;
  $('#ordReview').addEventListener('click', async () => {
    if (!auth || !auth.currentUser) { toast('Entra de nuevo para usar Claude'); return; }
    const ls = O.lines.filter((l) => l.qty > 0);
    if (!ls.length) return;
    const out = $('#ordReviewOut');
    reviewing = true; $('#ordReview').disabled = true;
    out.hidden = false;
    out.innerHTML = '<p class="ai-sum">Claude está revisando la orden…</p>';
    // Contexto: lo que más se vende de esos proveedores y no está en la orden
    const inOrder = new Set(ls.map((l) => l.id));
    const vendors = new Set(ls.map((l) => l.vendor));
    const context = S.products
      .filter((p) => p.st && p.st.u90 > 0 && !inOrder.has(String(p.id)) && vendors.has((p.buy && p.buy.vendor) || p.vendor || 'Sin proveedor'))
      .map((p) => ({ sku: String(p.id), name: p.name, vendor: (p.buy && p.buy.vendor) || p.vendor || 'Sin proveedor', stock: p.stock, rate: r2(weeklyRate(p.st)), cycle: p.buy ? p.buy.cycle : null }))
      .sort((a, b) => b.rate - a.rate).slice(0, 60);
    try {
      const token = await auth.currentUser.getIdToken();
      const r = await fetch(REVIEW_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          order: { lead: OS.lead, safety: OS.safety, today: ymd(new Date()),
            lines: ls.map((l) => ({ sku: l.id, name: l.name, vendor: l.vendor, qty: l.qty, sug: l.sug, stock: l.stock, rate: l.rate, cycle: l.cycle, lastBuy: l.lastBuy, manual: !!l.manual })) },
          context,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || `Error ${r.status}`);
      renderReview(data);
    } catch (e) {
      out.innerHTML = `<p class="ai-sum">No se pudo revisar: ${esc(e.message)}</p>`;
    } finally {
      reviewing = false; renderOrdTotals();
    }
  });

  const TIPO = { subir: 'Subir', bajar: 'Bajar', quitar: 'Quitar', agregar: 'Agregar', revisar: 'Revisar' };
  let lastReview = [];
  function renderReview(data) {
    lastReview = data.alertas || [];
    const nameOf = (sku) => { const l = O.lines.find((x) => x.id === sku); if (l) return l.name; const p = S.products.find((x) => String(x.id) === sku); return p ? p.name : 'SKU ' + sku; };
    const canApply = (a) => (a.tipo === 'quitar') || (a.cantidad_sugerida != null && ['subir', 'bajar', 'agregar'].includes(a.tipo));
    $('#ordReviewOut').innerHTML = `<p class="ai-sum">${esc(data.resumen || '')}</p>` +
      lastReview.map((a, i) => `<div class="ai-alert" data-i="${i}">
        <span class="ai-t ${esc(a.tipo)}">${esc(TIPO[a.tipo] || a.tipo)}</span>
        <p><b>${esc(nameOf(String(a.sku)))}${a.cantidad_sugerida != null ? ' → ' + a.cantidad_sugerida + ' cajas' : ''}</b>${esc(a.mensaje)}</p>
        ${canApply(a) ? '<button class="btn btn-ghost" type="button" data-apply>Aplicar</button>' : '<span></span>'}
      </div>`).join('') +
      `<span class="ai-meta">Revisado por Claude${data.modelo ? ' (' + esc(data.modelo) + ')' : ''} · son sugerencias, tú decides</span>`;
  }
  $('#ordReviewOut').addEventListener('click', (e) => {
    const b = e.target.closest('[data-apply]'); if (!b) return;
    const box = b.closest('.ai-alert');
    const a = lastReview[Number(box.dataset.i)]; if (!a) return;
    const sku = String(a.sku);
    let line = O.lines.find((l) => l.id === sku);
    if (a.tipo === 'agregar' && !line) {
      const p = S.products.find((x) => String(x.id) === sku);
      if (!p) { toast('No encontré ese producto'); return; }
      const base = lineFor(p, inSpecial()) || {};
      line = { ...base, id: sku, name: p.name, upc: p.upc || '', pack: p.pack || '', photo: p.photo || '',
        vendor: (p.buy && p.buy.vendor) || p.vendor || 'Sin proveedor', cost: (p.buy && p.buy.lastCost) || p.cost || 0, qty: 0, sug: 0, manual: true };
      O.lines.push(line);
    }
    if (!line) { toast('Ese producto ya no está en la orden'); return; }
    line.qty = a.tipo === 'quitar' ? 0 : Math.max(0, Math.round(a.cantidad_sugerida));
    if (line.qty === 0) O.lines = O.lines.filter((l) => l !== line);
    O.touched = true; saveDraft(); renderOrders();
    box.classList.add('done'); b.remove();
    const el = $(`.ol[data-id="${CSS.escape(sku)}"]`);
    if (el) { el.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });

  // ---- Guardar (compartido) ----
  const ordNo = (ts) => { const d = new Date(ts); return `OC-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`; };
  function orderPayload(status) {
    const ts = Date.now();
    if (!O.id) O.id = ts.toString(36) + uid();
    const ls = O.lines.filter((l) => l.qty > 0);
    return {
      ts, no: O.no || (O.no = ordNo(ts)), by: S.who, status, vendor: O.vendor || '',
      cajas: ls.reduce((a, l) => a + l.qty, 0), costo: r2(ls.reduce((a, l) => a + l.qty * (l.cost || 0), 0)),
      lines: ls.map((l) => ({ id: l.id, name: l.name, upc: l.upc || '', pack: l.pack || '', photo: l.photo || '', vendor: l.vendor, qty: l.qty, sug: l.sug ?? l.qty, cost: l.cost || 0, manual: !!l.manual })),
    };
  }
  async function saveOrder(status) {
    const p = orderPayload(status);
    O.status = status; saveDraft();
    // Jonathan (sin permiso directo en la base) guarda por el servidor de la IA
    if (onlyView()) { await cosCall('ord_save', { id: O.id, orden: p }); loadOrdenesSrv(); return p; }
    if (!db) return p;
    await withTimeout(db.ref('ordenes/' + O.id).set(p));
    return p;
  }
  $('#ordSave').addEventListener('click', async () => {
    try { await saveOrder(O.status === 'enviada' ? 'enviada' : 'borrador'); toast('Orden guardada · ya la ve ' + PEOPLE.filter((x) => x !== S.who).join(', ')); }
    catch (e) { toast('No se pudo guardar (' + (e.code || e.message) + ')'); }
  });

  // Órdenes recientes por el servidor (usuarios sin acceso directo a la base, como Jonathan)
  let ordPoll = null;
  async function loadOrdenesSrv() {
    try { O.recent = (await cosCall('ord_list')).list || []; renderRecent(); }
    catch (e) { $('#ordRecent').innerHTML = `<p class="data-info">No se pudo leer (${esc(e.message)}).</p>`; }
  }
  function listenOrders() {
    if (onlyView()) {
      loadOrdenesSrv();
      clearInterval(ordPoll); ordPoll = setInterval(() => { if (S.view === 'ord' && !document.hidden) loadOrdenesSrv(); }, 60000);
      return;
    }
    try {
      if (unOrd) unOrd();
      const ref = db.ref('ordenes').orderByChild('ts').limitToLast(15);
      const onVal = ref.on('value', (snap) => {
        const arr = [];
        snap.forEach((c) => { arr.push({ id: c.key, ...c.val() }); });
        O.recent = arr.reverse();
        renderRecent();
      }, (err) => { $('#ordRecent').innerHTML = `<p class="data-info">No se pudo leer (${esc(err.code || err.message)}).</p>`; });
      unOrd = () => ref.off('value', onVal);
    } catch (e) { console.warn('Órdenes', e); }
  }
  function renderRecent() {
    $('#ordRecent').innerHTML = O.recent.length ? O.recent.map((o) => `
      <div class="hist-item" data-oid="${esc(o.id)}">
        <div class="hi-thumbs">${(o.lines || []).slice(0, 4).map((l) => `<img src="${esc(l.photo)}" alt="">`).join('')}</div>
        <div class="hi-txt"><b>${esc(o.no || '')} · ${esc(o.vendor || 'Varios proveedores')}</b>${fmtTs(o.ts)} · ${esc(o.by || '')} · ${(o.lines || []).length} productos · ${nfmt(o.cajas || 0)} cajas</div>
        <span class="st${o.status === 'enviada' ? ' sent' : ''}">${o.status === 'enviada' ? 'enviada' : 'borrador'}</span>
        <button class="btn btn-ghost btn-sm" data-o="open" type="button">Abrir</button>
      </div>`).join('') : '<p class="data-info">Todavía no hay órdenes guardadas.</p>';
  }
  $('#ordRecent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-o="open"]'); if (!b) return;
    const o = O.recent.find((x) => x.id === b.closest('.hist-item').dataset.oid); if (!o) return;
    O.id = o.id; O.no = o.no; O.status = o.status; O.vendor = o.vendor || ''; O.touched = true;
    O.lines = (o.lines || []).map((l) => ({ ...l, manual: true }));
    saveDraft(); renderOrders();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ---- PDF (sin imágenes: SKU, UPC, nombre, empaque, cantidad) ----
  const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('No cargó ' + src)); document.head.appendChild(s); });
  async function logoData() {
    try { const b = await (await fetch('ctd-logo.png')).blob(); return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); } catch (e) { return null; }
  }
  async function buildPdf(p) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const logo = await logoData();
    if (logo) doc.addImage(logo, 'PNG', 40, 34, 84, 45);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(20, 18, 12);
    doc.text('Orden de compra', W - 40, 52, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90, 84, 74);
    const d = new Date(p.ts);
    doc.text(`${p.no}  ·  ${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}  ·  Hecha por ${p.by || ''}`, W - 40, 68, { align: 'right' });
    doc.text('Central Trade Distribution · Kansas City', 40, 96);
    let y = 112;
    const groups = {};
    p.lines.forEach((l) => { (groups[l.vendor] = groups[l.vendor] || []).push(l); });
    Object.entries(groups).forEach(([v, ls]) => {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20, 18, 12);
      if (y > 700) { doc.addPage(); y = 50; }
      doc.text(v, 40, y + 14);
      doc.autoTable({
        startY: y + 22, margin: { left: 40, right: 40 },
        head: [['#', 'SKU', 'Producto', 'Cant.']],
        body: ls.map((l, i) => [i + 1, l.id, l.name, l.qty]),
        foot: [['', '', 'Total cajas', ls.reduce((a, l) => a + l.qty, 0)]],
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [20, 18, 12] },
        headStyles: { fillColor: [15, 13, 10], textColor: [242, 163, 30], fontStyle: 'bold' },
        footStyles: { fillColor: [246, 242, 233], textColor: [20, 18, 12], fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 30, halign: 'right', overflow: 'visible' }, 1: { cellWidth: 56 }, 3: { cellWidth: 48, halign: 'right', fontStyle: 'bold' } },
        showFoot: 'lastPage', // el total solo al final, no en cada hoja
        alternateRowStyles: { fillColor: [250, 248, 243] },
      });
      y = doc.lastAutoTable.finalY + 18;
    });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    if (y > 740) { doc.addPage(); y = 50; }
    doc.text(`Total: ${p.lines.length} productos · ${p.cajas} cajas`, 40, y + 6);
    return doc.output('blob');
  }
  const pdfName = (p) => `Orden-CTD-${p.no}.pdf`;
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function waText(p) {
    const head = `Orden ${p.no} · ${p.vendor || 'Varios proveedores'} · ${p.lines.length} productos · ${p.cajas} cajas (PDF adjunto)`;
    const body = p.lines.map((l) => `${l.qty} × ${l.name} (SKU ${l.id})`).join('\n');
    const full = head + '\n\n' + body;
    return full.length < 1500 ? full : head;
  }
  $('#ordPdf').addEventListener('click', async () => {
    const btn = $('#ordPdf'); btn.disabled = true;
    try { const p = orderPayload(O.status); download(await buildPdf(p), pdfName(p)); }
    catch (e) { toast('No se pudo hacer el PDF (' + e.message + ')'); }
    finally { btn.disabled = false; }
  });
  $('#ordSend').addEventListener('click', async () => {
    const btn = $('#ordSend'); btn.disabled = true;
    try {
      const p = orderPayload('enviada');
      const blob = await buildPdf(p);
      const file = new File([blob], pdfName(p), { type: 'application/pdf' });
      const text = waText(p);
      const phone = window.matchMedia('(pointer: coarse)').matches;
      if (phone && navigator.canShare && navigator.canShare({ files: [file] })) {
        // Celular: menú de compartir con el PDF adjunto → WhatsApp → Luis
        await navigator.share({ files: [file], title: `Orden ${p.no}`, text });
      } else {
        // Compu: se descarga el PDF y se abre el chat de Luis; arrastra el PDF al chat
        download(blob, pdfName(p));
        window.open(`https://wa.me/${WHATSAPP_LUIS}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        toast('Se descargó el PDF: arrástralo al chat de Luis');
      }
      await saveOrder('enviada').catch(() => {});
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('No se pudo mandar (' + (e.message || e) + ')');
    } finally { btn.disabled = false; }
  });

  /* ================= INICIO ================= */
  fillIcons();
  initFirebase();
})();
