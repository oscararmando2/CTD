/* CTD · IA de Especiales
 * - Acceso: Firebase Phone Auth (SMS). Solo los números de la lista pueden entrar.
 * - Datos compartidos (Firestore, proyecto ctd-ia): el Excel ya procesado y el historial
 *   de propuestas. Las reglas de Firestore solo dejan leer/escribir a esos dos teléfonos.
 *   El código del sitio no lleva costos; viven en Firestore detrás del login.
 */
(function () {
  'use strict';

  /* ================= CONFIG ================= */
  // Pegar aquí la config web del proyecto de Firebase (Consola → Configuración del proyecto → Tus apps → Web).
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBhJuY0Wdh_UeZL0KHNn5WofWYPhQiVTuU',
    authDomain: 'ctd-ia.firebaseapp.com',
    projectId: 'ctd-ia',
    storageBucket: 'ctd-ia.firebasestorage.app',
    messagingSenderId: '914488691883',
    appId: '1:914488691883:web:57d809a1e899c6b0be3bee',
  };

  // Números permitidos, guardados como SHA-256 del número en formato E.164 (no se publican en claro).
  const ALLOWED = {
    '4b6e9c232e14b912f231b3e1c4eb40f6c21fb5f82e4c1f2e0630e04e826d8406': 'Oscar', // …96 15
    '5207ddd6e8b5461f1bc38294e065ba866fa5108e0a936291b3e6cca40b990eee': 'Luis',  // …51 31
  };

  const EXCLUDE_CATS = ['Spoilage', 'Shipping', 'TEST'];
  const MODES = { equilibrado: [6, 12], agresivo: [12, 22], cuidar: [3, 7] };
  const K_DATA = 'ctdIA.data', K_SET = 'ctdIA.settings', K_HIST = 'ctdIA.hist';
  const CHUNK = 400; // productos por documento (Firestore: máx 1 MB por doc)

  const DEV = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('dev');

  /* ================= HELPERS ================= */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const r2 = (n) => Math.round(n * 100) / 100;
  const rand = (a, b) => a + Math.random() * (b - a);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  async function sha256hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function toE164(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return d ? '+' + d : '';
  }
  async function allowedName(phone) {
    if (!phone) return null;
    return ALLOWED[await sha256hex(phone)] || null;
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  // Fechas locales YYYY-MM-DD
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseYmd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fmtD = (s) => { if (!s) return '—'; const d = parseYmd(s); return `${d.getDate()} ${MES[d.getMonth()]}`; };
  function nextWeek() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const add = ((8 - t.getDay()) % 7) || 7; // próximo lunes
    const mon = new Date(t); mon.setDate(t.getDate() + add);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return [ymd(mon), ymd(sun)];
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
    user: null,
    products: [],
    meta: null,
    cards: [],
    set: Object.assign(
      { count: 8, mode: 'equilibrado', dMin: 6, dMax: 12, floor: 5, vendor: '', brand: '', combo: true, cats: null },
      store.get(K_SET, {}),
      { from: defFrom, to: defTo }
    ),
  };
  const saveSettings = () => { const { from, to, ...rest } = S.set; store.set(K_SET, rest); };

  /* ================= ACCESO ================= */
  let auth = null, db = null, verifier = null, confirmation = null;

  function gateMsg(txt, kind) {
    const m = $('#gateMsg');
    m.textContent = txt || '';
    m.className = 'gate-msg' + (kind ? ' ' + kind : '');
  }
  function showGate() {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    $('#phoneForm').hidden = false;
    $('#codeForm').hidden = true;
  }
  function freshVerifier() {
    if (verifier) { try { verifier.clear(); } catch (e) {} }
    const old = $('#recaptcha');
    const div = document.createElement('div');
    div.id = 'recaptcha';
    old.replaceWith(div);
    verifier = new firebase.auth.RecaptchaVerifier('recaptcha', { size: 'invisible' });
    return verifier;
  }
  const AUTH_ERR = {
    'auth/invalid-phone-number': 'Número inválido. Escribe los 10 dígitos.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/quota-exceeded': 'Se alcanzó el límite de SMS por hoy.',
    'auth/operation-not-allowed': 'El acceso por teléfono no está activado en Firebase.',
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase.',
    'auth/billing-not-enabled': 'Firebase necesita el plan Blaze para mandar SMS.',
    'auth/invalid-verification-code': 'Código incorrecto. Revisa el mensaje.',
    'auth/code-expired': 'El código expiró. Pide uno nuevo.',
    'auth/captcha-check-failed': 'Falló la verificación anti-robot. Intenta de nuevo.',
    'auth/network-request-failed': 'Sin conexión. Revisa tu internet.',
  };
  const errText = (e) => AUTH_ERR[e && e.code] || 'No se pudo completar. ' + ((e && e.message) || '');

  function initAuth() {
    if (DEV) { enterApp('Dev'); return; }
    if (!FIREBASE_CONFIG.apiKey || typeof firebase === 'undefined') {
      gateMsg('Falta conectar Firebase (config vacía).', 'err');
      $('#sendBtn').disabled = true;
      return;
    }
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    auth.languageCode = 'es';
    db = firebase.firestore();
    auth.onAuthStateChanged(async (u) => {
      if (!u) { showGate(); return; }
      const name = await allowedName(u.phoneNumber);
      if (name) { enterApp(name); return; }
      await auth.signOut();
      showGate();
      gateMsg('Este número no tiene acceso.', 'err');
    });

    $('#phoneForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const phone = toE164($('#phoneInput').value);
      if (!(await allowedName(phone))) { gateMsg('Este número no tiene acceso.', 'err'); return; }
      const btn = $('#sendBtn');
      btn.disabled = true;
      gateMsg('Enviando código…');
      try {
        confirmation = await auth.signInWithPhoneNumber(phone, freshVerifier());
        $('#phoneForm').hidden = true;
        $('#codeForm').hidden = false;
        $('#codeInput').value = '';
        $('#codeInput').focus();
        gateMsg('Código enviado al número que termina en ' + phone.slice(-4) + '.', 'ok');
      } catch (e) {
        gateMsg(errText(e), 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('#codeForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!confirmation) return;
      const btn = $('#verifyBtn');
      btn.disabled = true;
      gateMsg('Verificando…');
      try {
        await confirmation.confirm($('#codeInput').value.trim());
        gateMsg('');
      } catch (e) {
        gateMsg(errText(e), 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('#backBtn').addEventListener('click', () => {
      confirmation = null;
      $('#codeForm').hidden = true;
      $('#phoneForm').hidden = false;
      gateMsg('');
    });
  }

  $('#logoutBtn').addEventListener('click', async () => {
    if (unHist) { unHist(); unHist = null; }
    S.user = null;
    if (auth) await auth.signOut();
    else location.reload();
  });

  /* ================= ENTRAR ================= */
  async function enterApp(name) {
    if (S.user === name) return;
    S.user = name;
    $('#whoami').innerHTML = 'Hola, <b>' + esc(name) + '</b>';
    $('#gate').hidden = true;
    $('#app').hidden = false;
    listenHist();
    let data = null;
    try { data = await Cloud.loadProducts(); } catch (e) { toast('No se pudo leer la base compartida'); }
    if (!data) data = store.get(K_DATA, null); // respaldo local
    if (data && Array.isArray(data.items) && data.items.length) {
      S.products = data.items;
      S.meta = data.meta;
      showWorkspace();
    } else {
      $('#dropzone').hidden = false;
      $('#workspace').hidden = true;
    }
  }

  /* ================= NUBE (Firestore) =================
   * datos/meta            {file, at, by, total, chunks}
   * datos/chunk_N         {items:[...]}
   * propuestas/{id}       {ts, by, from, to, m1, cards}
   * Sin Firebase (modo dev local) todo cae a localStorage. */
  const Cloud = {
    async loadProducts() {
      if (!db) return null;
      const meta = await db.doc('datos/meta').get();
      if (!meta.exists) return null;
      const m = meta.data();
      const parts = await Promise.all(Array.from({ length: m.chunks }, (_, i) => db.doc('datos/chunk_' + i).get()));
      const items = parts.flatMap((d) => (d.exists ? d.data().items || [] : []));
      store.set(K_DATA, { meta: m, items });
      return { meta: m, items };
    },
    async saveProducts(meta, items) {
      store.set(K_DATA, { meta, items });
      if (!db) return;
      const chunks = Math.ceil(items.length / CHUNK);
      const old = await db.doc('datos/meta').get();
      const oldChunks = old.exists ? old.data().chunks || 0 : 0;
      const batch = db.batch();
      for (let i = 0; i < chunks; i++) batch.set(db.doc('datos/chunk_' + i), { items: items.slice(i * CHUNK, (i + 1) * CHUNK) });
      for (let i = chunks; i < oldChunks; i++) batch.delete(db.doc('datos/chunk_' + i));
      batch.set(db.doc('datos/meta'), { ...meta, chunks });
      await batch.commit();
    },
    async addProposal(p) {
      if (!db) { const h = store.get(K_HIST, []); h.unshift(p); store.set(K_HIST, h.slice(0, 60)); S.hist = h; return; }
      const { id, ...rest } = p;
      await db.collection('propuestas').doc(id).set(rest);
    },
    async delProposal(id) {
      if (!db) { S.hist = store.get(K_HIST, []).filter((x) => x.id !== id); store.set(K_HIST, S.hist); return; }
      await db.collection('propuestas').doc(id).delete();
    },
  };

  S.hist = [];
  let unHist = null;
  function listenHist() {
    if (!db) { S.hist = store.get(K_HIST, []); return; }
    if (unHist) unHist();
    unHist = db.collection('propuestas').orderBy('ts', 'desc').limit(60).onSnapshot(
      (snap) => {
        S.hist = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!$('#histModal').hidden) renderHist();
      },
      () => toast('No se pudo leer el historial compartido')
    );
  }

  /* ================= EXCEL ================= */
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });

  async function loadFile(file) {
    const msg = $('#dropMsg');
    msg.textContent = 'Leyendo ' + file.name + '…';
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });
      const items = parseRows(rows);
      if (!items.length) throw new Error('No encontré productos con precio y costo. ¿Es el export de InSitu?');
      S.products = items;
      S.meta = { file: file.name, at: Date.now(), total: rows.length - 1, by: S.user || '' };
      msg.textContent = 'Guardando en la base compartida…';
      try { await Cloud.saveProducts(S.meta, items); }
      catch (e) { toast('Aviso: no se pudo compartir el Excel (' + (e.code || e.message) + ')'); }
      S.set.cats = null; // nuevas categorías → todas activas
      S.cards = S.cards.filter((c) => c.pinned);
      msg.textContent = '';
      showWorkspace();
      toast(items.length + ' productos cargados');
    } catch (e) {
      msg.textContent = e.message || 'No se pudo leer el archivo.';
    }
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
      });
    }
    return out;
  }

  function packLabel(v) {
    const s = String(v || '').trim();
    const m = s.match(/^case\s*(\d+)$/i);
    if (m) return 'Caja ' + m[1];
    if (/count in each/i.test(s)) return 'Pieza';
    return s;
  }

  /* ================= CONTROLES ================= */
  function showWorkspace() {
    $('#dropzone').hidden = true;
    $('#workspace').hidden = false;
    buildFilters();
    syncControls();
    const m = S.meta || {};
    const d = m.at ? new Date(m.at) : null;
    $('#dataInfo').innerHTML =
      `<b>${S.products.length}</b> productos · ${esc(m.file || 'Excel')}${d ? ' · ' + d.getDate() + ' ' + MES[d.getMonth()] : ''}${m.by ? ' por ' + esc(m.by) : ''} · ` +
      `<button id="changeXls" class="btn-link" type="button">cambiar Excel</button>`;
    $('#changeXls').addEventListener('click', () => $('#fileInput').click());
    render();
  }

  function eligibleBase() {
    return S.products.filter((p) => p.price > 0 && p.cost > 0 && p.cost < p.price && p.photo && !EXCLUDE_CATS.includes(p.cat));
  }

  function buildFilters() {
    const base = eligibleBase();
    const cats = {};
    base.forEach((p) => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
    const catNames = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
    if (!Array.isArray(S.set.cats)) S.set.cats = catNames.slice();
    $('#catChips').innerHTML = catNames
      .map((c) => `<button type="button" class="chip${S.set.cats.includes(c) ? ' on' : ''}" data-cat="${esc(c)}">${esc(c)}<small>${cats[c]}</small></button>`)
      .join('');

    const opts = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $('#fVendor').innerHTML = '<option value="">Todos</option>' + opts(base.map((p) => p.vendor)).map((v) => `<option>${esc(v)}</option>`).join('');
    $('#fBrand').innerHTML = '<option value="">Todas</option>' + opts(base.map((p) => p.brand)).map((v) => `<option>${esc(v)}</option>`).join('');
    $('#fVendor').value = S.set.vendor;
    $('#fBrand').value = S.set.brand;
    if ($('#fVendor').value !== S.set.vendor) S.set.vendor = '';
    if ($('#fBrand').value !== S.set.brand) S.set.brand = '';
  }

  function syncControls() {
    $$('#segCount button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === S.set.count));
    $$('#segMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.set.mode));
    $('#dMin').value = S.set.dMin;
    $('#dMax').value = S.set.dMax;
    $('#floor').value = S.set.floor;
    $('#dFrom').value = S.set.from;
    $('#dTo').value = S.set.to;
    $('#fCombo').checked = !!S.set.combo;
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
  $('#fVendor').addEventListener('change', (e) => { S.set.vendor = e.target.value; saveSettings(); });
  $('#fBrand').addEventListener('change', (e) => { S.set.brand = e.target.value; saveSettings(); });
  $('#fCombo').addEventListener('change', (e) => { S.set.combo = e.target.checked; saveSettings(); });
  $('#catChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const c = b.dataset.cat;
    S.set.cats = S.set.cats.includes(c) ? S.set.cats.filter((x) => x !== c) : [...S.set.cats, c];
    b.classList.toggle('on');
    saveSettings();
  });
  $('#catAll').addEventListener('click', () => { S.set.cats = $$('#catChips .chip').map((b) => b.dataset.cat); $$('#catChips .chip').forEach((b) => b.classList.add('on')); saveSettings(); });
  $('#catNone').addEventListener('click', () => { S.set.cats = []; $$('#catChips .chip').forEach((b) => b.classList.remove('on')); saveSettings(); });

  /* ================= MOTOR DE ESPECIALES ================= */
  const floorF = () => Math.min(0.9, S.set.floor / 100);
  const minPrice = (C) => C / (1 - floorF()); // precio más bajo que respeta el margen mínimo

  // Precio especial para regular P y costo C. null = no aguanta descuento.
  function specialPrice(P, C) {
    const d = rand(S.set.dMin, S.set.dMax) / 100;
    let s = psychDown(P * (1 - d));
    const floorP = minPrice(C);
    if (s < floorP) s = psychUp(floorP);
    s = r2(s);
    if (s >= P || (P - s) / P < 0.02) return null;
    return s;
  }

  function pool() {
    const cats = S.set.cats || [];
    return eligibleBase().filter((p) =>
      cats.includes(p.cat) && (!S.set.vendor || p.vendor === S.set.vendor) && (!S.set.brand || p.brand === S.set.brand));
  }

  // Barajado ponderado: los de más margen tienen más chance (más espacio para descontar)
  function weightedShuffle(arr) {
    return arr
      .map((p) => ({ p, k: Math.pow(Math.random(), 1 / (0.4 + (p.price - p.cost) / p.price)) }))
      .sort((a, b) => b.k - a.k)
      .map((x) => x.p);
  }

  const snap = (p) => ({ id: p.id, name: p.name, key: p.key, brand: p.brand, cat: p.cat, upc: p.upc, photo: p.photo, pack: p.pack, vendor: p.vendor });

  function makeCard(items, P, C, s) {
    const c = { uid: uid(), kind: items.length > 1 ? 'combo' : 'single', items: items.map(snap), P: r2(P), C: r2(C), S: s, from: S.set.from, to: S.set.to, pinned: false, open: false, customDates: false };
    c.tag = tagFor(c);
    return c;
  }

  function tagFor(c) {
    const off = (c.P - c.S) / c.P, m0 = (c.P - c.C) / c.P;
    if (c.kind === 'combo') return ['combo', 'Combo'];
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
          const s = specialPrice(p.price, p.cost);
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
      const s = specialPrice(P, C);
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
    if (!need) { toast('Todas están fijadas 📌'); return; }
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

  function viewHTML(c) {
    const st = stats(c), fl = floorF();
    const name = c.items.map((i) => i.name).join(' + ');
    const brand = [...new Set(c.items.map((i) => i.brand).filter(Boolean))].join(' · ') || c.items[0].cat;
    const meta = c.kind === 'combo'
      ? `${c.items.length} productos · ${esc(c.items[0].cat)}`
      : [c.items[0].pack, c.items[0].upc && 'UPC ' + c.items[0].upc, c.items[0].cat].filter(Boolean).map(esc).join(' · ');
    const w0 = Math.max(0, Math.min(100, st.m0 * 100 / 0.6 * 1)), w1 = Math.max(0, Math.min(100, st.m1 * 100 / 0.6));
    const flx = Math.min(100, fl * 100 / 0.6);
    const low = st.m1 < fl - 1e-9;
    return `
      <div>
        <div class="brand">${esc(brand)}</div>
        <h3 class="name">${esc(name)}</h3>
        <div class="meta">${meta}</div>
      </div>
      <div class="prices">
        <span class="p-old">${money(c.P)}</span>
        <span class="p-new">${money(c.S)}</span>
        <span class="p-save">Ahorra ${money(st.save)}</span>
      </div>
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
      <div class="dates">📅 Vigencia <b>${fmtD(c.from)} – ${fmtD(c.to)}</b></div>`;
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
        <p class="adj-warn" data-v="warn"${st.m1 < floorF() - 1e-9 ? '' : ' hidden'}>⚠️ Abajo del margen mínimo (${pct(floorF(), 0)}).</p>
      </div>`;
  }

  function cardHTML(c, i) {
    return `
      <article class="card${c.pinned ? ' pinned' : ''}" data-uid="${c.uid}" style="animation-delay:${Math.min(i, 12) * 45}ms">
        ${photoHTML(c)}
        <button class="pin${c.pinned ? ' on' : ''}" data-act="pin" type="button" title="${c.pinned ? 'Soltar' : 'Fijar'}" aria-label="Fijar">📌</button>
        <div class="cb">
          <div class="view">${viewHTML(c)}</div>
          ${adjHTML(c)}
          <div class="acts">
            <button class="btn btn-ghost" data-act="swap" type="button">🔄 Cambiar</button>
            <button class="btn btn-ghost" data-act="adj" type="button">✏️ ${c.open ? 'Listo' : 'Ajustar'}</button>
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
      grid.innerHTML = `<div class="empty"><p class="hud">Listo</p><p>Dale <b>🎲 Generar propuesta</b> para armar ${S.set.count} especiales.</p></div>`;
      $('#summary').hidden = true;
      $('#bottomBar').hidden = true;
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
    $('#bottomBar').hidden = false;
  }

  function renderSummary() {
    const n = S.cards.length;
    const all = S.cards.map(stats);
    const avg = (f) => all.reduce((a, s) => a + f(s), 0) / n;
    const cats = {};
    S.cards.forEach((c) => { const k = c.kind === 'combo' ? 'Combo' : c.items[0].cat; cats[k] = (cats[k] || 0) + 1; });
    $('#summary').hidden = false;
    $('#summary').innerHTML = `
      <div class="stat"><span class="lbl">Especiales</span><div class="stat-v">${n}</div></div>
      <div class="stat"><span class="lbl">Margen prom.</span><div class="stat-v">${pct(avg((s) => s.m0))}<span class="arrow">→</span><span class="down">${pct(avg((s) => s.m1))}</span></div></div>
      <div class="stat"><span class="lbl">Ahorro cliente</span><div class="stat-v">${pct(avg((s) => s.off))}</div></div>
      <div class="stat"><span class="lbl">Ganancia prom. / caja</span><div class="stat-v">${money(avg((s) => s.g1))}</div></div>
      <div class="stat stat-wide"><span class="lbl">Mezcla</span><div class="stat-cats">${Object.entries(cats).map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`).join('')}</div></div>`;
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
    } else if (act === 'swap') {
      if (c.pinned) { toast('Está fijada 📌 — suéltala para cambiarla'); return; }
      swapCard(c.uid);
    } else if (act === 'adj') {
      c.open = !c.open;
      el.querySelector('.adj').hidden = !c.open;
      b.textContent = c.open ? '✏️ Listo' : '✏️ Ajustar';
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

  /* ================= HISTORIAL ================= */
  const openModal = (id) => { $(id).hidden = false; };
  $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach((m) => (m.hidden = true)); });

  $('#saveBtn').addEventListener('click', async () => {
    if (!S.cards.length) return;
    const btn = $('#saveBtn');
    btn.disabled = true;
    const all = S.cards.map(stats);
    try {
      await Cloud.addProposal({
        id: Date.now().toString(36) + uid(), ts: Date.now(), by: S.user,
        from: S.set.from, to: S.set.to,
        m1: all.reduce((a, s) => a + s.m1, 0) / all.length,
        cards: S.cards.map(({ open, ...c }) => JSON.parse(JSON.stringify(c))),
      });
      toast('Propuesta guardada 💾');
    } catch (e) {
      toast('No se pudo guardar (' + (e.code || e.message) + ')');
    } finally {
      btn.disabled = false;
    }
  });

  function renderHist() {
    const hist = S.hist || [];
    $('#histList').innerHTML = hist.length ? hist.map((h) => {
      const d = new Date(h.ts);
      const thumbs = h.cards.slice(0, 5).map((c) => `<img src="${esc(c.items[0].photo)}" alt="">`).join('');
      return `<div class="hist-item" data-id="${h.id}">
        <div class="hi-thumbs">${thumbs}</div>
        <div class="hi-txt"><b>${h.cards.length} especiales · ${fmtD(h.from)} – ${fmtD(h.to)}</b>
          ${d.getDate()} ${MES[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${esc(h.by || '')} · margen ${pct(h.m1 || 0)}</div>
        <button class="btn btn-oro btn-sm" data-h="open" type="button">Abrir</button>
        <button class="btn-x" data-h="del" type="button" title="Quitar" aria-label="Quitar">🗑</button>
      </div>`;
    }).join('') : '<p class="data-info">Aún no hay propuestas guardadas.</p>';
  }
  $('#histBtn').addEventListener('click', () => { renderHist(); openModal('#histModal'); });
  $('#histList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]'); if (!b) return;
    const id = b.closest('.hist-item').dataset.id;
    const h = (S.hist || []).find((x) => x.id === id); if (!h) return;
    if (b.dataset.h === 'open') {
      S.cards = h.cards.map((c) => ({ ...c, uid: uid(), open: false }));
      S.set.from = h.from; S.set.to = h.to;
      if ($('#workspace').hidden) { toast('Carga tu Excel primero'); return; }
      syncControls();
      render(true);
      $('#histModal').hidden = true;
    } else if (confirm('¿Quitar esta propuesta del historial? (Oscar y Luis dejan de verla)')) {
      Cloud.delProposal(id).then(renderHist).catch((e) => toast('No se pudo quitar (' + (e.code || e.message) + ')'));
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

  /* ================= INICIO ================= */
  initAuth();
})();
