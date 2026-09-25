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
  const PEOPLE = ['Oscar', 'Luis'];
  // Firebase Auth pide un correo: cada nombre usa uno interno (no recibe mensajes)
  const emailOf = (name) => name.toLowerCase() + '@ctd-ia.firebaseapp.com';
  const nameOf = (email) => PEOPLE.find((p) => emailOf(p) === String(email || '').toLowerCase()) || null;

  const EXCLUDE_CATS = ['Spoilage', 'Shipping', 'TEST'];
  const MODES = { equilibrado: [6, 12], agresivo: [12, 22], cuidar: [3, 7] };
  const STALE_MS = 3 * 36e5; // si los datos tienen más de 3 h, se actualizan solos al abrir
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
  };
  const STRATS = {
    mixto: ['dormido', 'lento', 'bajando', 'gancho', 'normal'],
    mover: ['dormido', 'lento'],
    bajando: ['bajando'],
    gancho: ['gancho'],
    azar: null,
  };

  /* ================= HELPERS ================= */
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
    $('#whoPick').innerHTML = PEOPLE.map((p) => `<button type="button" data-v="${p}" class="${G.name === p ? 'on' : ''}">${p}<small>${G.name === p ? (G.create ? 'crear contraseña' : 'entrar') : '&nbsp;'}</small></button>`).join('');
    $('#passForm').hidden = !G.name;
    $('#pass2Input').hidden = !G.create;
    $('#pass2Input').required = G.create;
    $('#passInput').autocomplete = G.create ? 'new-password' : 'current-password';
    $('#passInput').placeholder = G.create ? 'Crea tu contraseña (mín. 6)' : 'Tu contraseña';
    $('#passLbl').textContent = G.create ? `Crear contraseña de ${G.name}` : `Contraseña de ${G.name}`;
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
  });

  function showGate() {
    $('#dock').hidden = true;
    $('#ordDock').hidden = true;
    $('#app').hidden = true;
    $('#gate').hidden = false;
    renderGate();
    if (G.name) knownUser(G.name).then((k) => { if (k === false) { G.create = true; renderGate(); } });
  }
  function enterApp(name) {
    S.who = name;
    $('#whoami').innerHTML = 'Hola, <b>' + esc(name) + '</b>';
    $('#gate').hidden = true;
    $('#app').hidden = false;
    listenHist();
    listenOrders();
    if (S.products.length) return;
    const data = store.get(K_DATA, null);
    if (data && Array.isArray(data.items) && data.items.length) {
      S.products = data.items;
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
      if (!items.length) throw new Error('InSitu no regresó productos con precio y costo.');
      S.products = items;
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
        const s = (sales[code] = sales[code] || { last: 0, u30: 0, u90: 0, uPrev90: 0, u365: 0, rev90: 0, clients: new Set(), m: new Array(12).fill(0) });
        if (t > s.last) s.last = t;
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
        price: Number(p.default_price) || 0,
        cost: Number(p.default_cost) || 0,
        photo: String(p.photourl || '').trim(),
        pack: packLabel(p.units),
        vendor: '',
        st: s ? {
          last: s.last ? ymd(new Date(s.last)) : null,
          days: s.last ? Math.floor((T - s.last) / DAY) : null,
          u30: r2(s.u30), u90: r2(s.u90), uPrev90: r2(s.uPrev90), u365: r2(s.u365), rev90: r2(s.rev90),
          clients: s.clients.size, m: s.m.map(r2),
        } : { last: null, days: null, u30: 0, u90: 0, uPrev90: 0, u365: 0, rev90: 0, clients: 0, m: new Array(12).fill(0) },
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
      S.products = items;
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
    $('#ordDock').hidden = true;
    $('#dropzone').hidden = false;
    $('#workspace').hidden = true;
  }

  function showWorkspace() {
    stockTrusted = null;
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
      `<button id="changeSrc" class="btn-link" type="button">${conn ? 'desconectar' : 'conectar InSitu'}</button> <span id="syncInfo"></span>`;
    renderAge();
    const rs = $('#resync');
    if (rs) rs.addEventListener('click', () => { syncInsitu({ silent: true }).catch(() => {}); });
    $('#changeSrc').addEventListener('click', () => {
      if (conn) { store.del(K_TOKEN); toast('InSitu desconectado en este dispositivo'); renderDataInfo(); }
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
    return S.products.filter((p) => p.price > 0 && p.cost > 0 && p.cost < p.price && p.photo && !EXCLUDE_CATS.includes(p.cat) &&
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
      (!whys || whys.includes(p.why || 'normal')));
  }

  // Barajado ponderado: pesa el motivo (si hay ventas) y el margen (más espacio para descontar)
  function weight(p) {
    const m = (p.price - p.cost) / p.price;
    const w = hasSales() && S.set.strat !== 'azar' ? (WHY[p.why] || WHY.normal).w : 1;
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
    why: p.why || 'normal', st: p.st || null, stock: p.stock ?? null, cover: p.cover ?? null,
  });

  function makeCard(items, P, C, s) {
    const c = { uid: uid(), kind: items.length > 1 ? 'combo' : 'single', items: items.map(snap), P: r2(P), C: r2(C), S: s, from: S.set.from, to: S.set.to, pinned: false, open: false, customDates: false };
    c.tag = tagFor(c);
    return c;
  }

  function tagFor(c) {
    const off = (c.P - c.S) / c.P, m0 = (c.P - c.C) / c.P;
    if (c.kind === 'combo') return ['combo', 'Combo'];
    const why = c.items[0].why;
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
          const s = specialPrice(p.price, p.cost, p.why);
          if (s == null) continue;
          used.add(p.key);
          out.push(makeCard([p], p.price, p.cost, s));
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

  /* ================= RENDER ================= */
  const stats = (c) => {
    const m0 = (c.P - c.C) / c.P, m1 = (c.S - c.C) / c.S;
    return { m0, m1, off: (c.P - c.S) / c.P, save: c.P - c.S, g0: c.P - c.C, g1: c.S - c.C };
  };

  function photoHTML(c) {
    const img = (i) => i.photo
      ? `<img src="${esc(i.photo)}" alt="${esc(i.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'noimg',textContent:'sin foto'}))">`
      : '<span class="noimg">sin foto</span>';
    return `<div class="ph${c.kind === 'combo' ? ' combo' : ''}">${c.items.map(img).join('')}<div class="ph-ov"></div></div>`;
  }
  function overlayHTML(c) {
    const st = stats(c);
    return `<span class="tag t-${c.tag[0]}">${esc(c.tag[1])}</span><span class="off">-${Math.round(st.off * 100)}%</span>`;
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
    if (c.kind === 'combo' || !c.items[0].st) return '';
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

  function viewHTML(c) {
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
      </div>
      <div class="prices">
        <span class="p-new">${money(c.S)}</span>
        <span class="p-old">${money(c.P)}</span>
        <span class="p-save">Ahorra ${money(st.save)}</span>
      </div>
      ${salesHTML(c, st.off)}
      <table class="ab">
        <thead><tr><th></th><th>Antes</th><th>Especial</th></tr></thead>
        <tbody>
          <tr><td>Precio</td><td>${money(c.P)}</td><td class="hi">${money(c.S)}</td></tr>
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
    const st = stats(c);
    const maxOff = Math.max(0, Math.floor(((c.P - minPrice(c.C)) / c.P) * 200) / 2);
    return `
      <div class="adj"${c.open ? '' : ' hidden'}>
        <div class="adj-row"><label>Descuento</label>
          <input type="range" data-f="off" min="0" max="${maxOff}" step="0.5" value="${Math.min(maxOff, r2(st.off * 100))}">
          <span class="val" data-v="off">${pct(st.off)}</span></div>
        <div class="adj-row"><label>Especial $</label><input type="number" data-f="price" step="0.01" min="0" value="${c.S.toFixed(2)}"></div>
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
      const k = c.kind === 'combo' ? 'Combo' : c.items[0].st && w !== 'normal' ? WHY[w].label : c.items[0].cat;
      const col = { dormido: 'var(--morado)', lento: 'var(--oro)', bajando: '#ff7a66', gancho: 'var(--verde-2)' }[c.kind === 'combo' ? '' : w] || (c.kind === 'combo' ? 'var(--oro)' : '');
      cats[k] = cats[k] || { n: 0, col };
      cats[k].n++;
    });
    $('#summary').hidden = false;
    $('#summary').innerHTML = `
      <div class="kpi"><span class="lbl">Especiales</span><div class="kpi-v">${n}</div></div>
      <div class="kpi"><span class="lbl">Margen prom.</span><div class="kpi-v">${pct(avg((s) => s.m0), 0)}<span class="arrow">→</span><span class="down">${pct(avg((s) => s.m1), 0)}</span></div></div>
      <div class="kpi"><span class="lbl">Ahorro cliente</span><div class="kpi-v">${pct(avg((s) => s.off))}</div></div>
      <div class="kpi"><span class="lbl">Ganancia / caja</span><div class="kpi-v">${money(avg((s) => s.g1))}</div></div>
      <div class="kpi kpi-mix"><span class="lbl">Mezcla</span><div class="mix">${Object.entries(cats).map(([k, v]) => `<span${v.col ? ` style="--c:${v.col}"` : ''}>${esc(k)} <b>${v.n}</b></span>`).join('')}</div></div>`;
  }

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
    if (typeof firebase === 'undefined') { gateMsg('No cargó Firebase. Revisa tu internet y recarga.', 'err'); return; }
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.database();
    // La sesión queda guardada en el dispositivo (LOCAL): no vuelve a pedir contraseña hasta "Salir"
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
    auth.onAuthStateChanged(async (u) => {
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
      toast('Propuesta guardada 💾 — ya la ve ' + PEOPLE.filter((p) => p !== S.who).join(' y '));
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
      return `<div class="hist-item" data-id="${esc(h.id)}">
        <div class="hi-thumbs">${thumbs}</div>
        <div class="hi-txt"><b>${h.cards.length} especiales · ${fmtD(h.from)} – ${fmtD(h.to)}</b>
          ${fmtTs(h.ts)} · ${esc(h.by || '')} · margen ${pct(h.m1 || 0)}</div>
        <button class="btn btn-oro btn-sm" data-h="open" type="button">Abrir</button>
        <button class="icon-btn" data-h="del" type="button" title="Quitar" aria-label="Quitar">${icon('trash')}</button>
      </div>`;
    }).join('') : '<p class="data-info">Aún no hay propuestas guardadas.</p>';
  }
  $('#histBtn').addEventListener('click', () => { renderHist(); openModal('#histModal'); });
  $('#histList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const id = b.closest('.hist-item').dataset.id;
    const h = (S.hist || []).find((x) => x.id === id); if (!h) return;
    if (b.dataset.h === 'open') {
      if ($('#workspace').hidden) { toast('Conecta InSitu o carga el Excel primero'); return; }
      S.cards = h.cards.map((c) => ({ ...c, uid: uid(), open: false }));
      S.set.from = h.from; S.set.to = h.to;
      syncControls();
      render(true);
      $('#histModal').hidden = true;
    } else if (confirm('¿Quitar esta propuesta del historial? (Oscar y Luis dejan de verla)')) {
      Cloud.del(id).then(renderHist).catch((err) => toast('No se pudo quitar (' + (err.code || err.message) + ')'));
    }
  });

  /* ================= VISTA CLIENTE ================= */
  $('#clientBtn').addEventListener('click', () => {
    const froms = S.cards.map((c) => c.from).sort(), tos = S.cards.map((c) => c.to).sort();
    const range = `${fmtD(froms[0])} – ${fmtD(tos[tos.length - 1])}`;
    const cards = S.cards.map((c) => {
      const st = stats(c);
      const name = c.items.map((i) => i.name).join(' + ');
      const brand = [...new Set(c.items.map((i) => i.brand).filter(Boolean))].join(' · ');
      const imgs = c.items.map((i) => `<img src="${esc(i.photo)}" alt="">`).join('');
      const pack = c.kind === 'combo' ? 'Combo · ' + c.items.length + ' productos' : c.items[0].pack;
      const own = c.from !== froms[0] || c.to !== tos[tos.length - 1] ? ` · ${fmtD(c.from)}–${fmtD(c.to)}` : '';
      return `<div class="sh-card">
        <div class="sh-ph${c.kind === 'combo' ? ' combo' : ''}">${imgs}<span class="sh-off">-${Math.round(st.off * 100)}%</span></div>
        <div class="sh-b">
          <div class="sh-brand">${esc(brand)}</div>
          <div class="sh-name">${esc(name)}</div>
          <div class="sh-old">Antes ${money(c.P)}</div>
          <div class="sh-new">${money(c.S)}</div>
          <div class="sh-pack">${esc(pack || '')}${own}</div>
        </div></div>`;
    }).join('');
    $('#clientSheet').innerHTML = `
      <div class="sh-head">
        <div><p>Central Trade Distribution</p><h2>Especiales de la semana</h2><p>Vigencia ${range}</p></div>
        <img src="ctd-logo.png" alt="CTD">
      </div>
      <div class="sh-grid">${cards}</div>
      <div class="sh-foot"><span>Precios por caja. Sujetos a disponibilidad.</span><span>centraltradedist.com</span></div>`;
    openModal('#clientModal');
  });
  $('#printBtn').addEventListener('click', () => window.print());


  /* ================= VISTAS: Especiales | Órdenes ================= */
  S.view = store.get(K_VIEW, 'esp');
  function applyView() {
    if ($('#workspace').hidden) return;
    const ord = S.view === 'ord';
    $$('#viewTabs button').forEach((b) => { const on = b.dataset.v === S.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $('#espView').hidden = ord;
    $('#ordView').hidden = !ord;
    $('#dock').hidden = ord;
    $('#ordDock').hidden = !ord || O.vendor === null;
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

  function lineFor(p, special) {
    const st = p.st;
    if (!st) return null;
    const rate = weeklyRate(st);
    const cycle = Math.min(42, (p.buy && p.buy.cycle) || 21); // tope 6 semanas: compras muy espaciadas no disparan órdenes enormes
    const days = cycle + OS.lead;
    const boost = special.has(String(p.id)) ? 1.3 : 1;
    const need = (rate / 7) * days * (1 + OS.safety / 100) * boost;
    const stock = p.stock != null ? Math.max(0, p.stock) : 0;
    const qty = Math.ceil(need - stock - 1e-9);
    const left = rate > 0 ? stock / (rate / 7) : Infinity;
    return {
      id: String(p.id), name: p.name, upc: p.upc || '', pack: p.pack || '', photo: p.photo || '',
      vendor: (p.buy && p.buy.vendor) || p.vendor || 'Sin proveedor',
      cost: (p.buy && p.buy.lastCost) || p.cost || 0,
      qty, sug: qty, rate: r2(rate), stock: p.stock, left: isFinite(left) ? Math.round(left) : null,
      cycle, cycleOwn: !!(p.buy && p.buy.cycleOwn), lastBuy: p.buy ? p.buy.last : null, boost: boost > 1,
    };
  }

  function whyLine(l) {
    if (l.manual) return 'Agregado a mano.';
    const left = l.left == null ? '' : l.left <= 0 ? ' Ya no hay.' : ` Te alcanza para ~${l.left} ${l.left === 1 ? 'día' : 'días'}.`;
    const cyc = l.cycleOwn ? `Le compras cada ~${l.cycle} días` : `Se compra cada ~${l.cycle} días (${l.lastBuy ? 'promedio del proveedor' : 'estimado'})`;
    return `Vendes ~${nfmt(l.rate)} cajas/semana y quedan ${cajas(l.stock ?? 0)}.${left} ${cyc} + ${OS.lead} de entrega + ${OS.safety}% colchón → pide ${l.sug}.` +
      (l.boost ? ' Incluye +30% porque está en un especial vigente.' : '');
  }

  function allSuggestions() {
    const special = inSpecial();
    return S.products
      .filter((p) => p.st && p.st.u90 > 0 && !EXCLUDE_CATS.includes(p.cat))
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
    $('#ordPickInfo').innerHTML = m.receipts
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
    $('#ordInfo').innerHTML = m.receipts
      ? `Calculado con tus ventas y <b>${m.receipts} recepciones</b> de InSitu · stock al ${fmtTs(m.at)}`
      : (syncing ? 'Bajando tus compras de InSitu…' : 'Todavía no se bajan tus compras de InSitu, por eso todo sale "Sin proveedor".') +
        (Insitu.token() && !syncing ? ' <button id="ordSync" class="btn-link" type="button">Bajar compras ahora</button>' : '');
    const os = $('#ordSync');
    if (os) os.addEventListener('click', () => syncInsitu({ silent: true }).catch(() => {}));
    $('#ordLead').value = OS.lead;
    $('#ordSafety').value = OS.safety;

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
    const hot = l.left != null && l.left <= 7;
    return `<article class="ol${l.qty !== l.sug ? ' edited' : ''}" data-id="${esc(l.id)}">
      <div class="ol-ph">${img}</div>
      <div class="ol-main">
        <div class="ol-name">${esc(l.name)}</div>
        <div class="meta">SKU ${esc(l.id)}${l.upc ? ' · UPC ' + esc(l.upc) : ''}${l.pack ? ' · ' + esc(l.pack) : ''}</div>
        <p class="ol-why${hot ? ' hot' : ''}">${esc(whyLine(l))}</p>
        ${l.manual ? '' : `<div class="ol-k"><span><b>${nfmt(l.stock ?? 0)}</b> stock</span><span><b>${nfmt(l.rate)}</b> /semana</span><span><b>${l.cycle}</b> días entre compras</span>${l.lastBuy ? `<span>última compra <b>${fmtD(l.lastBuy)}</b></span>` : ''}</div>`}
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
      <div class="kpi"><span class="lbl">Costo estimado</span><div class="kpi-v">${money(cost)}</div></div>
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
    el.querySelector('.stepper input').value = l.qty;
    el.classList.toggle('edited', l.qty !== l.sug);
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
    box.innerHTML = res.length ? res.map((p) => `<button type="button" role="option" data-add="${esc(p.id)}">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : ''}<span>${esc(p.name)}<small>SKU ${esc(p.id)}${p.stock != null ? ' · stock ' + nfmt(p.stock) : ''}</small></span></button>`).join('')
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
    if (!db) return p;
    await withTimeout(db.ref('ordenes/' + O.id).set(p));
    return p;
  }
  $('#ordSave').addEventListener('click', async () => {
    try { await saveOrder(O.status === 'enviada' ? 'enviada' : 'borrador'); toast('Orden guardada · ya la ve ' + PEOPLE.filter((x) => x !== S.who).join(' y ')); }
    catch (e) { toast('No se pudo guardar (' + (e.code || e.message) + ')'); }
  });

  function listenOrders() {
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
        head: [['#', 'SKU', 'UPC', 'Producto', 'Empaque', 'Cant.']],
        body: ls.map((l, i) => [i + 1, l.id, l.upc || '', l.name, l.pack || '', l.qty]),
        foot: [['', '', '', 'Total cajas', '', ls.reduce((a, l) => a + l.qty, 0)]],
        styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: [20, 18, 12] },
        headStyles: { fillColor: [15, 13, 10], textColor: [242, 163, 30], fontStyle: 'bold' },
        footStyles: { fillColor: [246, 242, 233], textColor: [20, 18, 12], fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 22 }, 1: { cellWidth: 60 }, 2: { cellWidth: 92 }, 4: { cellWidth: 60 }, 5: { cellWidth: 42, halign: 'right', fontStyle: 'bold' } },
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
