// Actualización automática desde InSitu (sin que nadie abra la IA): cada hora la llama una tarea programada.
// 1) Baja productos e inventario de InSitu con la sesión que guarda la IA (insitu/token, solo servidor).
// 2) Renueva la copia del catálogo (con existencia) que usan Jonathan y Rocío.
// 3) Ajusta las fechas de caducidad a la existencia real (sale primero la más vieja; en 0 se cierra).
// GET sin datos sensibles en la respuesta; se salta si ya corrió hace menos de 40 minutos.
const { db, loteQueda, r2 } = require('./_lib');

const INSITU = 'https://app.b2bmobilesales.com/api/v1';
const MIN_GAP = 40 * 60 * 1000;
const codeKey = (c) => String(c || '').trim().replace(/[.#$/[\]\s]+/g, '_').slice(0, 60);
function packLabel(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^case\s*(\d+)$/i);
  if (m) return 'Caja ' + m[1];
  if (/count in each/i.test(s)) return 'Pieza';
  if (/^\d+$/.test(s)) return Number(s) > 1 ? 'Caja ' + s : 'Pieza';
  return s;
}

async function insituAll(tok, path, key) {
  const out = [], LIM = 500;
  for (let off = 0; off < 20000; off += LIM) {
    const r = await fetch(`${INSITU}${path}?limit=${LIM}&offset=${off}`, { headers: { Authorization: (tok.scheme ?? 'Bearer ') + tok.token } });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('InSitu rechazó la sesión guardada'), { auth: true });
    if (!r.ok) throw new Error(`InSitu ${r.status} en ${path}`);
    const j = await r.json();
    const arr = j[key] || j.data || [];
    out.push(...arr);
    if (arr.length < LIM) break;
  }
  return out;
}

const PROD_KEYS = ['code', 'name', 'channel_name', 'description', 'line_name', 'subline_name', 'brand_name', 'barcode', 'group_name', 'default_price', 'default_cost', 'default_tax', 'photourl', 'units', 'is_featured', 'retail_price', 'hidden', 'disabled'];
async function completarAltas(tok, prods) {
  const pend = (await db('GET', 'costeoFotos')) || {};
  const auth = { Authorization: (tok.scheme ?? 'Bearer ') + tok.token };
  let n = 0;
  const diag = { pendientes: Object.keys(pend).length, sinLlegar: 0, errores: [] };
  for (const [qbId, a] of Object.entries(pend)) {
    const p = prods.find((x) => String(x.code ?? '').trim() === String(qbId));
    if (!p) { diag.sinLlegar++; if (Date.now() - (a.ts || 0) > 14 * 864e5) await db('DELETE', 'costeoFotos/' + qbId); continue; } // aún no llega de QuickBooks
    // Se manda el producto completo como está en InSitu, cambiando solo lo que se capturó (no se toca precio ni costo)
    const body = {};
    PROD_KEYS.forEach((k) => { if (p[k] !== undefined && p[k] !== null) body[k] = p[k]; });
    if (a.cat) body.line_name = a.cat;
    if (a.brand) body.brand_name = a.brand;
    if (a.barcode) body.barcode = a.barcode;
    if (a.photo) body.photourl = a.photo;
    if (a.units) body.units = a.units;
    // El producto ya existe en InSitu (llegó de QuickBooks): se actualiza por código con la operación masiva
    const r = await fetch(`${INSITU}/products/bulk/operations`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify([body]) });
    if (!r.ok) {
      const txt = (await r.text().catch(() => '')).slice(0, 160);
      await db('PUT', `costeoFotos/${qbId}/error`, `InSitu ${r.status} ${txt}`);
      diag.errores.push(`${qbId}: InSitu ${r.status} ${txt}`);
      continue;
    }
    // La foto también como imagen del producto (InSitu no siempre muestra solo el link)
    if (a.photo) {
      try {
        const img = await fetch(a.photo);
        if (img.ok) {
          const type = img.headers.get('content-type') || 'image/jpeg';
          const fd = new FormData();
          fd.append('file', new Blob([await img.arrayBuffer()], { type }), 'foto.' + (type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'));
          await fetch(`${INSITU}/products/${p.id}/images`, { method: 'PUT', headers: auth, body: fd });
        }
      } catch (e) { /* queda el link */ }
    }
    // Comprobar que InSitu sí lo guardó antes de darlo por hecho
    try {
      const v = await fetch(`${INSITU}/products?where=${encodeURIComponent(JSON.stringify({ code: String(p.code) }))}`, { headers: auth });
      const j = v.ok ? await v.json() : {};
      const q = ((j.products || j.data || []).find((x) => String(x.code) === String(p.code))) || null;
      const falta = q ? [['cat', 'line_name'], ['brand', 'brand_name'], ['barcode', 'barcode'], ['units', 'units']].filter(([k, f]) => a[k] && String(q[f] || '').trim() !== String(a[k]).trim()).map(([k]) => k) : ['?'];
      if (falta.length) { const msg = `InSitu no guardó: ${falta.join(', ')}`; await db('PUT', `costeoFotos/${qbId}/error`, msg); diag.errores.push(`${qbId}: ${msg}`); continue; }
    } catch (e) { /* sin comprobación, se da por hecho */ }
    await db('DELETE', 'costeoFotos/' + qbId);
    await db('PUT', 'qbLog/' + Date.now().toString(36) + qbId, { ts: Date.now(), action: 'insitu-alta', name: p.name, qbId, cat: a.cat || '', brand: a.brand || '', barcode: a.barcode || '', units: a.units || '', photo: !!a.photo, by: a.by || 'auto' });
    n++;
  }
  diag.hechas = n;
  return diag;
}

// Unit of Measurement que falta en productos dados de alta desde la IA: se saca del nombre (20/145 GRS → Case20, CJ 12 → Case12)
// o "pieza" si en Costeo se marcó que se vende por pieza. Solo valores que ya existen en InSitu. Se aplican con completarAltas.
async function autoUnidades(prods) {
  const [log, pzMem, pend] = await Promise.all([db('GET', 'qbLog'), db('GET', 'costeoPz'), db('GET', 'costeoFotos')]);
  const altas = new Set(Object.values(log || {}).filter((x) => x && x.action === 'costeo-alta' && x.qbId).map((x) => String(x.qbId)));
  if (!altas.size) return 0;
  const units = [...new Set(prods.map((p) => String(p.units || '').trim()).filter(Boolean))];
  const pieza = units.find((u) => /each|pieza|count/i.test(u)) || '';
  const caseN = (n) => units.find((u) => u.replace(/\s+/g, '').toLowerCase() === 'case' + n) || '';
  const up = {};
  prods.forEach((p) => {
    const code = String(p.code ?? '').trim();
    if (!altas.has(code) || String(p.units || '').trim() || (pend && pend[code])) return;
    const mem = (pzMem || {})[code.replace(/[.#$/[\]\s]+/g, '_')];
    const s = String(p.name || '');
    const m = s.match(/\bcj\.?\s*(\d{1,3})\b/i) || s.match(/\b(\d{1,3})\s*(?:unds?|pzas?|piezas|pcs|ct)\b/i) || s.match(/(?:^|\s)(\d{1,3})\s*\/\s*\d/);
    const u = mem > 1 ? pieza : m ? caseN(Number(m[1])) : '';
    if (u) up['costeoFotos/' + code] = { units: u, name: s, ts: Date.now(), by: 'auto' };
  });
  if (Object.keys(up).length) await db('PATCH', '', up);
  return Object.keys(up).length;
}

module.exports = async (req, res) => {
  try {
    const force = req.query && req.query.force === '1';
    const last = (await db('GET', 'insitu/lastRun')) || {};
    if (!force && last.at && Date.now() - last.at < MIN_GAP) return res.json({ ok: true, skipped: 'reciente', at: last.at });
    const tok = await db('GET', 'insitu/token');
    if (!tok || !tok.token) return res.json({ ok: false, error: 'Falta la sesión de InSitu: que Oscar, Luis o Diego abran la IA una vez' });

    const [prods, stocks] = await Promise.all([insituAll(tok, '/products', 'products'), insituAll(tok, '/inventory_stock', 'warehouse_stocks')]);
    const stockBy = {};
    stocks.forEach((w) => { stockBy[w.product_id] = (stockBy[w.product_id] || 0) + (Number(w.stock) || 0); });
    const items = prods.filter((p) => !p.hidden && !p.disabled && p.name).map((p) => ({
      id: String(p.code ?? p.id).trim(), name: String(p.name).replace(/\s+/g, ' ').trim(),
      upc: String(p.barcode || '').trim(), ean: String(p.ean || '').trim(),
      photo: /^https:\/\//.test(p.photourl || '') ? String(p.photourl).trim() : '',
      price: Number(p.default_price) || 0, cat: String(p.line_name || p.group_name || 'Otros').trim(),
      pack: packLabel(p.units), units: String(p.units || '').trim(), brand: String(p.brand_name || '').trim(), stock: r2(stockBy[p.id] || 0),
    }));
    if (!items.length || !stocks.length) throw new Error('InSitu regresó sin productos o sin inventario');
    await db('PUT', 'catalogo', { at: Date.now(), by: 'auto', items });

    // Fechas de caducidad siguen a la existencia
    const lotes = (await db('GET', 'lotes')) || {};
    const stockSku = {};
    items.forEach((p) => { stockSku[codeKey(p.id)] = p.stock; });
    const up = {}, now = Date.now();
    let ajustes = 0;
    Object.entries(lotes).forEach(([sku, v]) => {
      if (!(sku in stockSku)) return;
      let left = Math.max(0, stockSku[sku]);
      Object.keys(v.f || {}).sort().reverse().forEach((d) => { // nueva → vieja
        const q = loteQueda(v.f[d]);
        if (!(q > 0)) return;
        const queda = Math.min(q, left);
        left -= queda;
        if (queda < q - 0.01) { up[`lotes/${sku}/f/${d}/aj`] = { r: r2(queda), ts: now, by: 'auto' }; ajustes++; }
      });
    });
    if (ajustes) await db('PATCH', '', up);
    // Productos dados de alta en Costeo: cuando ya llegaron de QuickBooks a InSitu se les pone categoría, marca, código de barras y foto
    let altas = 0;
    try { await autoUnidades(prods); } catch (e) { /* sigue */ }
    try { altas = await completarAltas(tok, prods); } catch (e) { altas = { error: String(e.message || e).slice(0, 200) }; } // no detiene la sincronización
    await db('PUT', 'insitu/lastRun', { at: Date.now(), productos: items.length, ajustes, altas });
    return res.json({ ok: true, productos: items.length, conExistencia: items.filter((p) => p.stock > 0).length, ajustes, altas });
  } catch (e) {
    await db('PUT', 'insitu/lastRun', { at: Date.now(), error: String(e.message || e).slice(0, 200) }).catch(() => {});
    return res.status(e.auth ? 401 : 500).json({ ok: false, error: String(e.message || e) });
  }
};
