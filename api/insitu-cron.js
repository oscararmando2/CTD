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
      pack: packLabel(p.units), brand: String(p.brand_name || '').trim(), stock: r2(stockBy[p.id] || 0),
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
    await db('PUT', 'insitu/lastRun', { at: Date.now(), productos: items.length, ajustes });
    return res.json({ ok: true, productos: items.length, conExistencia: items.filter((p) => p.stock > 0).length, ajustes });
  } catch (e) {
    await db('PUT', 'insitu/lastRun', { at: Date.now(), error: String(e.message || e).slice(0, 200) }).catch(() => {});
    return res.status(e.auth ? 401 : 500).json({ ok: false, error: String(e.message || e) });
  }
};
