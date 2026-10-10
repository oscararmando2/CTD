// Costeo de facturas de proveedor para la IA de CTD (solo usuarios de la IA).
// POST {action, ...}:
//   parse   → lee la factura (imágenes JPEG en base64) con Claude y regresa los renglones
//   dup     → ¿ya se subió esa factura de ese proveedor?
//   lookup  → busca los productos en QuickBooks (precio, costo, tipo) y si tienen especial activo
//   apply   → cambia precio/costo en QuickBooks y da de alta productos nuevos
//   save    → guarda la factura (con lo que se decidió) y aprende códigos de proveedor
//   list    → últimas facturas;  get → una factura;  map → códigos aprendidos de un proveedor
//   recibo_save / recibo_list / recibo_get → Recibo de mercancía (Jonathan revisa qué llegó y las caducidades)
//   recibo_costeado → la factura ya pasó por Costeo;  lotes → caducidades por producto (lote = fecha)
// QuickBooks es el dueño de productos y precios: InSitu recibe los cambios en su sincronización (cada hora).
const crypto = require('crypto');
const { insituGet, insituPost, RECIBO_ONLY, COSTEO_ONLY, cors, verifyUser, bearer, db, qb, qbQuery, qbItem, log, todayCT, r2, same, env, matchOne, norm } = require('./_lib');

const MODEL = 'claude-opus-5';
const MAX_IMAGES = 12;

const SYSTEM = `Lees facturas de proveedores de Central Trade Distribution (CTD), mayorista de abarrotes latinos en Kansas City. CTD compra y vende POR CAJA.
Extrae TODOS los renglones de producto de la factura, en el orden en que aparecen. Para cada renglón:
- upc: el código de barras / UPC si aparece (solo dígitos o como venga), si no, cadena vacía.
- codigo_proveedor: el número de artículo / item # / SKU del proveedor, si aparece.
- producto: la descripción tal como viene.
- cantidad: cantidad ENVIADA/SURTIDA (si hay columnas "ordered" y "shipped", usa shipped; si no se surtió, 0).
- empaque: presentación tal como viene (ej. "12/16 OZ", "24 CT", "CS").
- unidades_por_caja: número de unidades en la caja si se puede saber del empaque (ej. 12/16 OZ → 12), si no null.
- costo_caja: precio por caja (unit price de la factura; si la factura cobra por pieza y trae unidades por caja, multiplícalo).
- total_linea: importe del renglón.
- caducidad: si junto al renglón hay una fecha de caducidad escrita a mano (ej. "OCT-25-27", "07-22-27", "DIC-26-26", "15-mar-28"), conviértela a YYYY-MM-DD (en EE.UU. suele ser mes-día-año; el año de 2 dígitos es 20XX). Si no hay, cadena vacía. No confundas la fecha de la factura con una caducidad.
Aparte: flete/freight, otros cargos y créditos/descuentos/devoluciones NO son productos; van en sus campos.
Si un dato no se lee con claridad, pon lo más probable y márcalo en "dudas" con el número de renglón (empezando en 1).`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['proveedor', 'factura', 'fecha', 'total_factura', 'flete', 'otros_cargos', 'creditos', 'items', 'dudas'],
  properties: {
    proveedor: { type: 'string' },
    factura: { type: 'string', description: 'Número de factura' },
    fecha: { type: 'string', description: 'YYYY-MM-DD o vacío' },
    total_factura: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    flete: { type: 'number' },
    otros_cargos: { type: 'number' },
    creditos: { type: 'number', description: 'Positivo; se resta' },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['upc', 'codigo_proveedor', 'producto', 'cantidad', 'empaque', 'unidades_por_caja', 'costo_caja', 'total_linea', 'caducidad'],
        properties: {
          upc: { type: 'string' }, codigo_proveedor: { type: 'string' }, producto: { type: 'string' },
          cantidad: { type: 'number' }, empaque: { type: 'string' },
          unidades_por_caja: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          costo_caja: { type: 'number' }, total_linea: { type: 'number' },
          caducidad: { type: 'string', description: 'YYYY-MM-DD escrita a mano, o vacío' },
        },
      },
    },
    dudas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['renglon', 'nota'], properties: { renglon: { type: 'integer' }, nota: { type: 'string' } } } },
  },
};

const vendorKey = (v) => norm(v).replace(/\b(llc|inc|corp|co|sa|de|cv|s a|distributors?|distribuitors?)\b/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'sin-proveedor';
const codeKey = (c) => String(c || '').trim().replace(/[.#$/[\]\s]+/g, '_').slice(0, 60);
const cleanName = (s) => String(s || '').replace(/[:\t\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

async function parseInvoice(images) {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY en Vercel (proyecto ctd)');
  const content = images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }));
  content.push({ type: 'text', text: 'Desglosa esta factura de proveedor.' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 16000, fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM, messages: [{ role: 'user', content }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Claude: ' + (data.error ? data.error.message : r.status));
  if (data.stop_reason === 'refusal') throw new Error('Claude no pudo leer la factura');
  if (data.stop_reason === 'max_tokens') throw new Error('La factura es muy larga; súbela en partes');
  const block = (data.content || []).find((b) => b.type === 'text');
  const out = JSON.parse(block ? block.text : '{}');
  // Cuadre: mercancía + flete + otros − créditos contra el total impreso
  const merch = r2((out.items || []).reduce((a, it) => a + (Number(it.total_linea) || (Number(it.cantidad) || 0) * (Number(it.costo_caja) || 0)), 0));
  const calc = r2(merch + (out.flete || 0) + (out.otros_cargos || 0) - (out.creditos || 0));
  out.mercancia = merch; out.total_calculado = calc;
  out.cuadra = typeof out.total_factura === 'number' ? Math.abs(out.total_factura - calc) <= Math.max(1, out.total_factura * 0.01) : null;
  out.modelo = data.model || MODEL;
  return out;
}

// Plantilla para altas: tipo y cuentas contables del tipo de producto más común en QuickBooks
async function itemTemplate() {
  const r = await qbQuery('select * from Item where Active = true maxresults 200');
  const items = (r.Item || []).filter((i) => ['Inventory', 'NonInventory'].includes(i.Type) && i.IncomeAccountRef);
  if (!items.length) throw new Error('No encontré un producto de ejemplo en QuickBooks para copiar sus cuentas');
  const counts = {};
  items.forEach((i) => { counts[i.Type] = (counts[i.Type] || 0) + 1; });
  const type = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return items.find((i) => i.Type === type && (type !== 'Inventory' || i.AssetAccountRef));
}

// Categoría de QuickBooks con ese nombre (la misma de InSitu); si no existe se crea
let CAT_CACHE = null;
async function qbCategoria(nombre) {
  const n = norm(nombre || ''); if (!n) return null;
  if (!CAT_CACHE || Date.now() - CAT_CACHE.at > 10 * 60000) {
    const r = await qbQuery("select * from Item where Type = 'Category' maxresults 1000");
    CAT_CACHE = { at: Date.now(), list: (r.Item || []).filter((c) => c.Active !== false) };
  }
  let c = CAT_CACHE.list.find((x) => norm(x.Name) === n || norm(x.FullyQualifiedName || '') === n);
  if (!c) {
    const d = await qb('POST', 'item', { Name: String(nombre).trim().slice(0, 100), Type: 'Category' });
    c = d.Item; CAT_CACHE.list.push(c);
    await log({ action: 'qb-categoria', name: c.Name, qbId: c.Id });
  }
  return c;
}

async function activeSpecial(qbId) {
  const all = (await db('GET', 'qbEspeciales')) || {};
  const hit = Object.entries(all).find(([, e]) => e.qbId === String(qbId) && e.status === 'activo');
  return hit ? { id: hit[0], ...hit[1] } : null;
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  let who = null;
  try { who = await verifyUser(bearer(req)); } catch (e) { who = null; }
  if (!who) return res.status(401).json({ error: 'Sin acceso. Vuelve a entrar a la IA.' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  if (RECIBO_ONLY.includes(who) && !RECIBO_ACTIONS.includes(body.action)) return res.status(403).json({ error: 'Tu usuario solo tiene acceso a Recibo.' });
  // Rocío consulta fechas pero no las cambia
  if (COSTEO_ONLY.includes(who) && ['lote_add', 'lote_del', 'lote_ajuste'].includes(body.action)) return res.status(403).json({ error: 'Tu usuario solo puede consultar las fechas.' });

  try {
    switch (body.action) {
      case 'parse': {
        const images = (Array.isArray(body.images) ? body.images : []).map((d) => String(d || '').replace(/^data:[^,]+,/, '')).filter(Boolean).slice(0, MAX_IMAGES);
        if (!images.length) return res.status(400).json({ error: 'Falta la factura' });
        return res.json(await parseInvoice(images));
      }
      case 'dup': {
        const key = vendorKey(body.proveedor) + '|' + codeKey(body.factura);
        const all = (await db('GET', 'costeoFacturas')) || {};
        const hit = Object.entries(all).find(([, f]) => f.key === key);
        return res.json({ dup: hit ? { id: hit[0], ts: hit[1].ts, by: hit[1].by } : null });
      }
      case 'map': {
        const [m, pz] = await Promise.all([db('GET', 'costeoMap/' + vendorKey(body.proveedor)), db('GET', 'costeoPz')]);
        return res.json({ map: m || {}, pz: pz || {} }); // pz: { sku: piezas por caja (0 = por caja) } aprendido en Costeo
      }
      case 'lookup': {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 150);
        const all = (await db('GET', 'qbEspeciales')) || {};
        const out = {};
        for (const p of items) {
          const m = await matchOne(p);
          if (m) {
            const sp = Object.values(all).find((e) => e.qbId === m.qbId && e.status === 'activo');
            if (sp) m.special = { price: sp.special, original: sp.original, to: sp.to };
          }
          out[String(p.sku)] = m;
        }
        return res.json({ items: out });
      }
      case 'apply': {
        const changes = (Array.isArray(body.changes) ? body.changes : []).slice(0, 150);
        const creates = (Array.isArray(body.creates) ? body.creates : []).slice(0, 50);
        const results = [];
        for (const c of changes) {
          try {
            const it = await qbItem(c.qbId);
            const upd = { Id: it.Id, SyncToken: it.SyncToken, sparse: true };
            let note = '';
            if (c.cost != null && !same(it.PurchaseCost || 0, c.cost)) upd.PurchaseCost = r2(c.cost);
            if (c.price != null && !same(it.UnitPrice || 0, c.price)) {
              const sp = await activeSpecial(c.qbId);
              if (sp) {
                // Con especial activo no se toca el precio: se actualiza el precio al que regresará al terminar
                await db('PATCH', 'qbEspeciales/' + sp.id, { original: r2(c.price), regular: r2(c.price) });
                note = `tiene especial activo hasta ${sp.to}: regresará a ${r2(c.price)}`;
              } else upd.UnitPrice = r2(c.price);
            }
            if (upd.PurchaseCost != null || upd.UnitPrice != null) await qb('POST', 'item', upd);
            await log({ action: 'costeo-cambio', name: it.Name, qbId: it.Id, from: { price: r2(it.UnitPrice || 0), cost: r2(it.PurchaseCost || 0) }, to: { price: upd.UnitPrice ?? null, cost: upd.PurchaseCost ?? null }, note, factura: body.factura || '', by: who });
            results.push({ qbId: c.qbId, ok: true, note });
          } catch (err) {
            results.push({ qbId: c.qbId, ok: false, error: String(err.message || err) });
          }
        }
        let tpl = null;
        for (const c of creates) {
          try {
            const name = cleanName(c.name);
            if (!name) throw new Error('Falta el nombre');
            const exists = await qbQuery(`select * from Item where Name = '${name.replace(/'/g, "\\'")}'`);
            if (exists.Item && exists.Item.length) throw new Error('Ya existe un producto con ese nombre en QuickBooks');
            tpl = tpl || await itemTemplate();
            const item = {
              Name: name, Type: tpl.Type, Sku: String(c.sku || '').slice(0, 100) || undefined,
              UnitPrice: r2(c.price), PurchaseCost: r2(c.cost),
              Description: c.description ? String(c.description).slice(0, 4000) : undefined,
              IncomeAccountRef: tpl.IncomeAccountRef, ExpenseAccountRef: tpl.ExpenseAccountRef,
            };
            if (/^\d+$/.test(String(c.vendorId || ''))) item.PrefVendorRef = { value: String(c.vendorId) };
            if (c.cat) { try { const cat = await qbCategoria(c.cat); if (cat) Object.assign(item, { SubItem: true, ParentRef: { value: cat.Id } }); } catch (e) { /* sin categoría */ } }
            if (tpl.Type === 'Inventory') Object.assign(item, { AssetAccountRef: tpl.AssetAccountRef, TrackQtyOnHand: true, QtyOnHand: 0, InvStartDate: todayCT() });
            const d = await qb('POST', 'item', item);
            await log({ action: 'costeo-alta', name, qbId: d.Item.Id, price: item.UnitPrice, cost: item.PurchaseCost, factura: body.factura || '', by: who });
            // Lo que QuickBooks no guarda (categoría, marca, código de barras, foto) se pone en InSitu cuando el producto llegue (cron de cada hora)
            const extra = { photo: /^https?:\/\//.test(String(c.photo || '')) ? String(c.photo).trim().slice(0, 1000) : '', barcode: str(c.barcode, 40), cat: str(c.cat, 80), brand: str(c.brand, 80), units: str(c.units, 40) };
            if (extra.photo || extra.barcode || extra.cat || extra.brand || extra.units) await db('PUT', 'costeoFotos/' + d.Item.Id, { ...extra, name, sku: item.Sku || '', ts: Date.now(), by: who });
            results.push({ create: name, ok: true, qbId: d.Item.Id, type: tpl.Type });
          } catch (err) {
            results.push({ create: c.name, ok: false, error: String(err.message || err) });
          }
        }
        return res.json({ results });
      }
      case 'save': {
        const f = body.factura || {};
        // Misma factura vuelta a guardar (ej. se corrigió y se aplicó otra vez): se actualiza, no se duplica
        const prevId = /^[a-z0-9]{6,40}$/.test(String(body.id || '')) ? String(body.id) : '';
        const id = prevId && (await db('GET', 'costeoFacturas/' + prevId + '/key')) ? prevId : Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const key = vendorKey(f.proveedor) + '|' + codeKey(f.factura);
        const rec = {
          key, proveedor: str(f.proveedor, 120), factura: str(f.factura, 60), fecha: str(f.fecha, 10),
          total_factura: num(f.total_factura), total_calculado: num(f.total_calculado), cuadra: f.cuadra ?? null,
          flete: num(f.flete), creditos: num(f.creditos), otros_cargos: num(f.otros_cargos),
          lines: (Array.isArray(f.lines) ? f.lines : []).slice(0, 300).map((l) => ({
            producto: str(l.producto, 160), upc: str(l.upc, 40), codigo_proveedor: str(l.codigo_proveedor, 40), cantidad: num(l.cantidad),
            empaque: str(l.empaque, 40), costo_caja: num(l.costo_caja), sku: str(l.sku, 40), qbId: str(l.qbId, 40), nombre: str(l.nombre, 160),
            costo_antes: num(l.costo_antes), precio_antes: num(l.precio_antes), precio_nuevo: num(l.precio_nuevo), aplicado: !!l.aplicado, nuevo: !!l.nuevo,
            caducidad: ymdOk(l.caducidad), pz: Math.max(0, Math.round(num(Number(l.pz)) || 0)), pzSet: !!l.pzSet,
          })),
          applied: Array.isArray(body.results) ? body.results.slice(0, 300) : [],
          by: who, ts: Date.now(),
        };
        await db('PUT', 'costeoFacturas/' + id, rec);
        // Aprende: código del proveedor → producto (para reconocerlo solo la próxima vez)
        const vk = vendorKey(f.proveedor);
        const learn = {};
        rec.lines.forEach((l) => { if (l.codigo_proveedor && l.sku) learn[codeKey(l.codigo_proveedor)] = { sku: l.sku, nombre: l.nombre }; });
        if (Object.keys(learn).length) await db('PATCH', 'costeoMap/' + vk, learn);
        // Aprende si el producto se vende por pieza (para todas las facturas, de cualquier proveedor)
        const pzLearn = {};
        rec.lines.forEach((l) => { if (l.sku && l.pzSet) pzLearn[codeKey(l.sku)] = l.pz > 1 ? l.pz : 0; });
        if (Object.keys(pzLearn).length) await db('PATCH', 'costeoPz', pzLearn);
        // Liga con Recibo (misma factura = proveedor + número): si bodega ya la revisó queda costeada;
        // si no existe, se le crea a bodega para que la revise y confirme
        let recibo = await findRecibo(key), recStatus = 'enviado';
        if (recibo) {
          recStatus = recibo.status;
          if (recibo.status === 'revisado') { await db('PATCH', 'recibos/' + recibo.id, { status: 'costeado', costeoId: id, costeadoBy: who, costeadoAt: Date.now() }); recStatus = 'costeado'; }
          else if (recibo.status === 'borrador') await db('PATCH', 'recibos/' + recibo.id, { costeoId: id });
        } else {
          const rid = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
          recibo = {
            id: rid, key, proveedor: rec.proveedor, factura: rec.factura, fecha: rec.fecha, origen: 'costeo', costeoId: id,
            head: { total_factura: rec.total_factura, total_calculado: rec.total_calculado, cuadra: rec.cuadra, flete: rec.flete, creditos: rec.creditos, otros_cargos: rec.otros_cargos },
            lines: rec.lines.map((l) => ({ producto: l.producto, upc: l.upc, codigo_proveedor: l.codigo_proveedor, cantidad: l.cantidad, empaque: l.empaque, costo_caja: l.costo_caja,
              sku: l.sku || (l.nuevo && l.aplicado ? l.qbId : ''), nombre: l.nombre, how: 'costeo', estado: '', recibido: null, caducidad: l.caducidad || '', leida: l.caducidad || '', nota: '' })),
            nota: '', status: 'borrador', by: who, ts: Date.now(), updated: Date.now(), updatedBy: who, doneAt: null,
          };
          await db('PUT', 'recibos/' + rid, recibo);
        }
        // recStatus: 'enviado' (se le mandó a bodega), 'borrador' (bodega la está revisando), 'costeado' (bodega ya la había revisado)
        return res.json({ id, recibo: { id: recibo.id, status: recStatus } });
      }
      case 'list': {
        const all = (await db('GET', 'costeoFacturas')) || {};
        const recs = (await db('GET', 'recibos')) || {};
        const recBy = {};
        Object.values(recs).forEach((r) => { if (r.costeoId) recBy[r.costeoId] = r.status; });
        const list = Object.entries(all).map(([id, f]) => ({ id, proveedor: f.proveedor, factura: f.factura, fecha: f.fecha, total_factura: f.total_factura, lines: (f.lines || []).length, by: f.by, ts: f.ts, cuadra: f.cuadra,
          bodega: f.bodega ? { dif: (f.bodega.dif || []).length, by: f.bodega.by } : null, bodegaStatus: recBy[id] || null }))
          .sort((a, b) => b.ts - a.ts).slice(0, 40);
        return res.json({ list });
      }
      case 'get': {
        const f = await db('GET', 'costeoFacturas/' + String(body.id || ''));
        if (!f) return res.status(404).json({ error: 'No existe' });
        return res.json({ factura: f });
      }
      case 'qb_buscar': {
        // Buscar un producto que ya existe en QuickBooks por Id, SKU o nombre (aunque todavía no llegue a InSitu)
        const s = str(body.q, 80).trim();
        if (s.length < 2) return res.json({ items: [] });
        const qq = s.replace(/\\/g, '').replace(/'/g, "\\'");
        const found = new Map();
        const add = (r) => (r.Item || []).forEach((it) => { if (['Inventory', 'NonInventory', 'Service'].includes(it.Type)) found.set(it.Id, it); });
        if (/^\d+$/.test(s)) { try { const it = await qbItem(s); if (it) found.set(it.Id, it); } catch (e) { /* no es Id */ } }
        try { add(await qbQuery(`select * from Item where Sku = '${qq}'`)); } catch (e) { /* ok */ }
        const words = norm(s).split(' ').filter((w) => w.length > 1).slice(0, 3).join('%');
        if (words) { try { add(await qbQuery(`select * from Item where Name like '%${words.replace(/'/g, "\\'")}%' maxresults 15`)); } catch (e) { /* ok */ } }
        return res.json({ items: [...found.values()].slice(0, 12).map((it) => ({ qbId: String(it.Id), name: it.Name, sku: it.Sku || '', price: r2(it.UnitPrice || 0), cost: r2(it.PurchaseCost || 0), active: it.Active !== false })) });
      }
      case 'alta_completar': {
        // Producto ya dado de alta: categoría en QuickBooks ahora; categoría, marca, unidad, código y foto en InSitu (cron de cada hora)
        const id = String(body.qbId || '');
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Falta el producto' });
        const it = await qbItem(id);
        let qbCat = '';
        if (body.cat) {
          const cat = await qbCategoria(str(body.cat, 80));
          if (cat && !(it.ParentRef && it.ParentRef.value === cat.Id)) {
            await qb('POST', 'item', { Id: it.Id, SyncToken: it.SyncToken, sparse: true, SubItem: true, ParentRef: { value: cat.Id } });
            qbCat = cat.Name;
          }
        }
        const extra = { photo: /^https?:\/\//.test(String(body.photo || '')) ? String(body.photo).trim().slice(0, 1000) : '', barcode: str(body.barcode, 40), cat: str(body.cat, 80), brand: str(body.brand, 80), units: str(body.units, 40) };
        Object.keys(extra).forEach((k) => { if (!extra[k]) delete extra[k]; });
        if (Object.keys(extra).length) await db('PUT', 'costeoFotos/' + id, { ...extra, name: it.Name, sku: it.Sku || '', ts: Date.now(), by: who });
        await log({ action: 'costeo-completar', name: it.Name, qbId: id, ...extra, qbCat, by: who });
        return res.json({ ok: true, qbCat, insitu: Object.keys(extra).length > 0 });
      }
      case 'qb_vendors': {
        const r = await qbQuery('select Id, DisplayName from Vendor where Active = true maxresults 1000');
        return res.json({ vendors: (r.Vendor || []).map((v) => ({ id: String(v.Id), name: String(v.DisplayName || '') })).sort((a, b) => a.name.localeCompare(b.name)) });
      }
      case 'photos': {
        return res.json({ photos: (await db('GET', 'costeoFotos')) || {} });
      }
      case 'photo_done': {
        await db('DELETE', 'costeoFotos/' + String(body.qbId || ''));
        return res.json({ ok: true });
      }
      case 'catalogo_save': {
        // Copia del catálogo de InSitu (con fotos) que sube quien sincroniza, para Recibo en el teléfono de bodega
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 5000).map((p) => ({ id: str(p.id, 40), name: str(p.name, 160), upc: str(p.upc, 40), ean: str(p.ean, 40), photo: /^https:\/\//.test(p.photo || '') ? str(p.photo, 500) : '',
          price: num(p.price), cat: str(p.cat, 60), pack: str(p.pack, 40), brand: str(p.brand, 60), stock: num(p.stock) })).filter((p) => p.id && p.name);
        if (!items.length) return res.status(400).json({ error: 'Catálogo vacío' });
        await db('PUT', 'catalogo', { at: Date.now(), by: who, items });
        return res.json({ ok: true, n: items.length });
      }
      case 'vigentes': {
        // Especiales activos o programados (solo lectura, sin costos) para el catálogo
        const all = (await db('GET', 'qbEspeciales')) || {};
        const today = todayCT();
        const list = Object.values(all).filter((e) => ['activo', 'programado'].includes(e.status) && e.to >= today)
          .map((e) => ({ sku: e.sku, name: e.name, qbName: e.qbName, special: e.special, original: e.original ?? null, regular: e.regular ?? null, from: e.from, to: e.to, status: e.status,
            grupo: e.grupo || '', grupoTitulo: e.grupoTitulo || '', grupoCorto: e.grupoCorto || '' }));
        return res.json({ list, today });
      }
      case 'catalogo': {
        // Primero la copia de InSitu (trae fotos); si no hay, la lista de QuickBooks (el Id es el mismo código que en InSitu)
        const snap = await db('GET', 'catalogo');
        if (snap && Array.isArray(snap.items) && snap.items.length) return res.json({ items: snap.items, at: snap.at });
        const out = [];
        for (let start = 1; start < 6000; start += 1000) {
          const r = await qbQuery(`select Id, Name, Sku, Active from Item startposition ${start} maxresults 1000`);
          const items = r.Item || [];
          items.forEach((i) => { if (i.Active !== false && ['Inventory', 'NonInventory'].includes(i.Type || 'Inventory')) out.push({ id: String(i.Id), name: i.Name, upc: i.Sku || '' }); });
          if (items.length < 1000) break;
        }
        return res.json({ items: out });
      }
      case 'recibo_save': {
        const r = body.recibo || {};
        const id = /^[a-z0-9]{6,32}$/.test(String(r.id || '')) ? String(r.id) : Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const prev = await db('GET', 'recibos/' + id);
        if (prev && prev.status === 'costeado') return res.status(409).json({ error: 'Este recibo ya se costeó; ya no se puede cambiar.' });
        const final = body.final === true || (prev && prev.status === 'revisado');
        const now = Date.now();
        const h = r.head || {};
        const rkey = vendorKey(r.proveedor) + '|' + codeKey(r.factura);
        // ¿Ya se costeó esta factura? (subida primero en Costeo)
        let costeoId = (prev && prev.costeoId) || '';
        if (!costeoId && r.factura) {
          const all = (await db('GET', 'costeoFacturas')) || {};
          const hit = Object.entries(all).find(([, f]) => f.key === rkey);
          if (hit) costeoId = hit[0];
        }
        const rec = {
          id, key: rkey, origen: (prev && prev.origen) || 'bodega', costeoId,
          proveedor: str(r.proveedor, 120), factura: str(r.factura, 60), fecha: str(r.fecha, 10),
          head: { total_factura: num(h.total_factura), total_calculado: num(h.total_calculado), mercancia: num(h.mercancia), cuadra: h.cuadra ?? null,
            flete: num(h.flete), creditos: num(h.creditos), otros_cargos: num(h.otros_cargos) },
          lines: (Array.isArray(r.lines) ? r.lines : []).slice(0, 300).map((l) => ({
            producto: str(l.producto, 160), upc: str(l.upc, 40), codigo_proveedor: str(l.codigo_proveedor, 40), cantidad: num(l.cantidad),
            empaque: str(l.empaque, 40), unidades_por_caja: Number.isInteger(l.unidades_por_caja) ? l.unidades_por_caja : null,
            costo_caja: num(l.costo_caja), total_linea: num(l.total_linea),
            sku: str(l.sku, 40), nombre: str(l.nombre, 160), how: str(l.how, 40),
            photo: /^https:\/\//.test(l.photo || '') ? str(l.photo, 500) : '', upcSis: str(l.upcSis, 40),
            estado: ESTADOS.includes(l.estado) ? l.estado : '', recibido: num(l.recibido),
            caducidad: ymdOk(l.caducidad), leida: ymdOk(l.leida), nota: str(l.nota, 300),
            fechas: Array.isArray(l.fechas) && l.fechas.length > 1 ? l.fechas.slice(0, 6).map((x) => ({ f: ymdOk(x && x.f), q: num(Number(x && x.q)) })).filter((x) => x.f && x.q > 0) : null,
          })),
          nota: str(r.nota, 1500),
          status: final ? (costeoId ? 'costeado' : 'revisado') : 'borrador',
          by: (prev && prev.by) || who, ts: (prev && prev.ts) || now, updated: now, updatedBy: who,
          doneAt: final ? ((prev && prev.doneAt) || now) : null,
          inv: (prev && prev.inv) || null,
          invManual: r.invManual != null ? !!r.invManual : !!(prev && prev.invManual),
          recv: r.recv && typeof r.recv === 'object' ? { pallets: str(r.recv.pallets, 10), combinados: str(r.recv.combinados, 10), temp: str(r.recv.temp, 20), por: str(r.recv.por, 80) } : (prev && prev.recv) || null,
        };
        await db('PUT', 'recibos/' + id, rec);
        if (final) await syncLotes(id, prev, rec);
        // Inventario: lo que llegó entra a InSitu (ajuste), en piezas o cajas según se venda el producto
        let inv = rec.inv;
        if (final) {
          try { inv = await recInventario(rec); } catch (e) { inv = { ...(rec.inv || {}), errores: [String(e.message || e)], at: Date.now() }; }
          if (inv) await db('PATCH', 'recibos/' + id, { inv });
        }
        if (final && costeoId) {
          // Aviso para Costeo: lo que bodega encontró distinto a la factura
          const dif = rec.lines.filter((l) => l.estado !== 'ok' || l.nota).map((l) => ({ producto: l.nombre || l.producto, estado: l.estado || 'sin revisar', recibido: l.recibido, cantidad: l.cantidad, nota: l.nota }));
          await db('PATCH', 'costeoFacturas/' + costeoId, { bodega: { reciboId: id, by: rec.updatedBy, at: now, nota: rec.nota, dif } });
        }
        return res.json({ id, status: rec.status, costeoId, inv });
      }
      case 'recibo_inventario': {
        // Reintentar meter el inventario de un recibo ya terminado (ej. faltaba la sesión de InSitu)
        const rid = codeKey(body.id);
        const rec = await db('GET', 'recibos/' + rid);
        if (!rec || !['revisado', 'costeado'].includes(rec.status)) return res.status(400).json({ error: 'Ese recibo no está terminado' });
        if (body.manual === true) { rec.invManual = true; await db('PATCH', 'recibos/' + rid, { invManual: true }); }
        const inv = await recInventario(rec);
        if (inv) await db('PATCH', 'recibos/' + rid, { inv });
        return res.json({ inv });
      }
      case 'recibo_list': {
        const all = (await db('GET', 'recibos')) || {};
        const list = Object.values(all).map((f) => {
          const L = f.lines || [];
          const c = (e) => L.filter((l) => l.estado === e).length;
          return { id: f.id, proveedor: f.proveedor, factura: f.factura, fecha: f.fecha, status: f.status, by: f.by, ts: f.ts, updated: f.updated, doneAt: f.doneAt || null,
            lines: L.length, ok: c('ok'), parcial: c('parcial'), no: c('no'), pendiente: c('pendiente'), sinRevisar: c(''),
            fechas: L.filter((l) => l.caducidad).length, costeoId: f.costeoId || null, origen: f.origen || 'bodega', updatedBy: f.updatedBy || '', invManual: !!f.invManual,
            inv: f.inv ? { hechos: Object.keys(f.inv.aplicado || {}).length, errores: (f.inv.errores || []).slice(0, 8) } : null };
        }).sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts)).slice(0, 60);
        return res.json({ list });
      }
      case 'borrar': {
        // Borra una factura de Costeo (ej. de prueba) y su recibo ligado, con sus fechas de caducidad.
        // Los cambios que ya se hayan aplicado en QuickBooks NO se deshacen.
        const id = codeKey(body.id);
        const f = await db('GET', 'costeoFacturas/' + id);
        if (!f) return res.status(404).json({ error: 'No existe' });
        const recs = (await db('GET', 'recibos')) || {};
        const ligados = Object.values(recs).filter((r) => r.costeoId === id || (f.key && r.key === f.key));
        for (const r of ligados) {
          await syncLotes(r.id, r, { lines: [] }); // quita sus entradas de lotes
          await db('DELETE', 'recibos/' + r.id);
        }
        await db('DELETE', 'costeoFacturas/' + id);
        try { await log({ action: 'costeo-borrar', factura: f.factura, proveedor: f.proveedor, recibos: ligados.length, by: who }); } catch (e) { /* el registro no detiene el borrado */ }
        return res.json({ ok: true, recibos: ligados.length, aplicados: (f.lines || []).filter((l) => l.aplicado).length });
      }
      case 'recibo_find': {
        const r = await findRecibo(vendorKey(body.proveedor) + '|' + codeKey(body.factura));
        return res.json({ recibo: r || null });
      }
      case 'recibo_get': {
        const f = await db('GET', 'recibos/' + codeKey(body.id));
        if (!f) return res.status(404).json({ error: 'No existe' });
        return res.json({ recibo: f });
      }
      case 'recibo_costeado': {
        const id = codeKey(body.id);
        const f = await db('GET', 'recibos/' + id);
        if (!f) return res.status(404).json({ error: 'No existe' });
        await db('PATCH', 'recibos/' + id, { status: 'costeado', costeoId: str(body.costeoId, 40), costeadoBy: who, costeadoAt: Date.now() });
        return res.json({ ok: true });
      }
      case 'lote_add': {
        // Fecha puesta a mano (ej. mercancía que ya estaba en la bodega sin fecha)
        const sku = codeKey(body.sku), fecha = ymdOk(body.fecha), q = num(Number(body.q));
        if (!sku || !fecha || !(q > 0)) return res.status(400).json({ error: 'Faltan producto, fecha o cajas' });
        await db('PATCH', '', {
          [`lotes/${sku}/n`]: str(body.nombre, 160),
          [`lotes/${sku}/f/${fecha}/e/m_${Date.now().toString(36)}`]: { q, f: 'a mano', p: '', ts: Date.now(), by: who },
        });
        return res.json({ ok: true });
      }
      case 'lote_del': {
        // Quita las fechas puestas a mano de un producto en esa fecha (las de recibos no se tocan)
        const sku = codeKey(body.sku), fecha = ymdOk(body.fecha);
        const e = (await db('GET', `lotes/${sku}/f/${fecha}/e`)) || {};
        const up = {};
        Object.keys(e).filter((k) => k.startsWith('m_')).forEach((k) => { up[`lotes/${sku}/f/${fecha}/e/${k}`] = null; });
        if (Object.keys(up).length) await db('PATCH', '', up);
        return res.json({ ok: true, n: Object.keys(up).length });
      }
      /* ---------- Créditos a clientes (Rocío): revisión con las facturas de InSitu y seguimiento ---------- */
      case 'cr_clientes': {
        if (!CLI_CACHE.at || Date.now() - CLI_CACHE.at > 10 * 60000) {
          const list = await insituGet('/customers', {}, true);
          CLI_CACHE.list = list.filter((c) => !c.disabled && (c.branch_name || c.branch_code))
            .map((c) => ({ code: String(c.branch_code || c.id), name: String(c.branch_name || c.branch_code), seller: c.mobile_user_login || '', city: c.ship_address_city || c.city || '' }));
          CLI_CACHE.at = Date.now();
        }
        return res.json({ clientes: CLI_CACHE.list });
      }
      case 'cr_historial': {
        // Todo lo que se le vendió a ese cliente en 3 años (la IA filtra: el producto, su CR- y los parecidos)
        const code = str(body.code, 60);
        if (!code) return res.status(400).json({ error: 'Falta el cliente' });
        const d = new Date(); d.setDate(d.getDate() - 1095);
        const rango = { fromDate: d.toISOString().slice(0, 10), toDate: todayCT() };
        const delCliente = (i) => [i.client_branch_code, i.client_nit, i.account_number].map((x) => String(x || '')).includes(code);
        let invs = (await insituGet('/invoices', { ...rango, where: JSON.stringify({ client_branch_code: code }) }, true)).filter(delCliente);
        if (!invs.length) invs = (await insituGet('/invoices', { ...rango, where: JSON.stringify({ client_nit: code }) }, true)).filter(delCliente);
        let vendedor = '', lastT = 0;
        const lines = [];
        invs.forEach((inv) => {
          if (invCancel(inv)) return;
          const fecha = invYmd(inv.invoice_date || inv.invoice_ship_date);
          const t = Date.parse(fecha);
          const mu = inv.mobile_user || {};
          if (t >= lastT && (mu.name || inv.mobile_user_login)) { lastT = t; vendedor = mu.name || inv.mobile_user_login; }
          (inv.invoiceDetailList || []).forEach((l) => {
            const pc = String(l.product_code || '').trim();
            if (!pc || lines.length >= 6000) return;
            lines.push({ sku: pc, fecha, factura: inv.invoice_number || '', cant: Number(l.quantity) || 0, precio: num(Number(l.product_price)), unidades: str(l.units, 20) });
          });
        });
        lines.sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
        return res.json({ facturas: invs.length, desde: rango.fromDate, vendedor, lineas: lines });
      }
      case 'cr_save': {
        const c = body.credito || {};
        const id = /^[a-z0-9]{6,32}$/.test(String(c.id || '')) ? String(c.id) : Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const prev = await db('GET', 'creditos/' + id);
        const rec = {
          id, cliente: { code: str(c.cliente && c.cliente.code, 60), name: str(c.cliente && c.cliente.name, 120) },
          vendedor: str(c.vendedor, 80), nota: str(c.nota, 500),
          lineas: (Array.isArray(c.lineas) ? c.lineas : []).slice(0, 60).map((l) => ({
            sku: str(l.sku, 40), nombre: str(l.nombre, 160), skuOrig: str(l.skuOrig, 40), nombreOrig: str(l.nombreOrig, 160),
            piezas: num(Number(l.piezas)), precio: num(Number(l.precio)), motivo: str(l.motivo, 40), caducidad: ymdOk(l.caducidad),
            alerta: str(l.alerta, 300),
          })),
          status: (prev && prev.status) || 'capturado', numero: (prev && prev.numero) || '',
          by: (prev && prev.by) || who, ts: (prev && prev.ts) || Date.now(), updated: Date.now(),
        };
        rec.total = num(rec.lineas.reduce((a, l) => a + (l.piezas || 0) * (l.precio || 0), 0));
        await db('PUT', 'creditos/' + id, rec);
        return res.json({ id });
      }
      case 'cr_list': {
        const all = (await db('GET', 'creditos')) || {};
        return res.json({ list: Object.values(all).sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts)).slice(0, 200) });
      }
      case 'cr_aplicar': {
        const id = codeKey(body.id), numero = str(body.numero, 40);
        if (!(await db('GET', 'creditos/' + id))) return res.status(404).json({ error: 'No existe' });
        await db('PATCH', 'creditos/' + id, numero ? { status: 'aplicado', numero, aplicadoBy: who, aplicadoAt: Date.now() } : { status: 'capturado', numero: '' });
        return res.json({ ok: true });
      }
      case 'cr_borrar': {
        await db('DELETE', 'creditos/' + codeKey(body.id));
        return res.json({ ok: true });
      }
      case 'insitu_token': {
        // La IA guarda la sesión de InSitu para que el servidor actualice existencia y fechas solo, cada hora.
        // Se guarda en un nodo que solo lee el servidor; nunca se regresa al navegador.
        if (RECIBO_ONLY.includes(who) || COSTEO_ONLY.includes(who)) return res.status(403).json({ error: 'Sin permiso' });
        const token = String(body.token || '').replace(/^Bearer\s+/i, '').trim();
        if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return res.status(400).json({ error: 'Sesión inválida' });
        const prev = await db('GET', 'insitu/token');
        if (!prev || prev.token !== token) await db('PUT', 'insitu/token', { token, scheme: body.scheme === '' ? '' : 'Bearer ', by: who, at: Date.now() });
        const last = (await db('GET', 'insitu/lastRun')) || {};
        return res.json({ ok: true, lastRun: last.at || null, error: last.error || null });
      }
      case 'lote_ajuste': {
        // La IA (con la existencia de InSitu) guarda cuánto queda de cada fecha; solo baja, nunca sube
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 500);
        const up = {}, now = Date.now();
        items.forEach((x) => {
          const sku = codeKey(x.sku), fecha = ymdOk(x.fecha), r = Number(x.r);
          if (!sku || !fecha || !(r >= 0)) return;
          up[`lotes/${sku}/f/${fecha}/aj`] = { r: r2(r), ts: now, by: who };
        });
        if (Object.keys(up).length) await db('PATCH', '', up);
        return res.json({ ok: true, n: Object.keys(up).length });
      }
      case 'avisos_tienda': {
        if (RECIBO_ONLY.includes(who)) return res.status(403).json({ error: 'Sin permiso' });
        const c = await db('GET', 'avisosTienda');
        if (!body.force && c && c.at && Date.now() - c.at < 2 * 3600e3) return res.json(c);
        const list = await avisosTienda();
        const rec = { at: Date.now(), list };
        await db('PUT', 'avisosTienda', rec);
        return res.json(rec);
      }
      case 'lotes': {
        // { sku: { nombre, fechas: { 'YYYY-MM-DD': cajas recibidas con esa caducidad } } }
        // Lo que queda de cada fecha: si ya se ajustó con la existencia real (aj = {r, ts}), cuenta ese resto
        // más lo que entró después; si llega a 0 la fecha queda cerrada. 'prev' = fechas que ha tenido (para "¿la misma?")
        const all = (await db('GET', 'lotes')) || {};
        const out = {};
        Object.entries(all).forEach(([sku, v]) => {
          const fechas = {};
          const prev = Object.keys(v.f || {}).sort().reverse().slice(0, 3);
          Object.entries(v.f || {}).forEach(([d, x]) => {
            const es = Object.entries(x.e || {});
            const aj = x.aj && typeof x.aj.r === 'number' ? x.aj : null;
            const q = aj ? aj.r + es.filter(([, e]) => (e.ts || 0) > aj.ts).reduce((a, [, e]) => a + (Number(e.q) || 0), 0)
              : es.reduce((a, [, e]) => a + (Number(e.q) || 0), 0);
            const last = es.reduce((a, [, e]) => Math.max(a, e.ts || 0), 0);
            const man = es.filter(([k]) => k.startsWith('m_')).length;
            if (q > 0) fechas[d] = { q: r2(q), ts: last, man, all: man === es.length };
          });
          if (Object.keys(fechas).length || prev.length) out[sku] = { nombre: v.n || '', fechas, prev };
        });
        return res.json({ lotes: out });
      }
      default:
        return res.status(400).json({ error: 'Acción desconocida' });
    }
  } catch (e) {
    return res.status(e.code === 'not_connected' ? 409 : 500).json({ error: String(e.message || e), code: e.code || '' });
  }
};

const CLI_CACHE = { at: 0, list: [] };
function invYmd(s) {
  const t = String(s || '');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const y = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return y ? y[0] : '';
}
const invCancel = (inv) => inv.cancelled === true || inv.cancelled === 1 || /cancel|void|anulad/i.test(inv.status || '');
// ¿Seguía vivo ese lote (con cajas) en el momento t? Usa las entradas hasta t y el último ajuste si fue antes de t.
function loteVivoEn(x, t) {
  const es = Object.values((x && x.e) || {});
  const aj = x && x.aj && typeof x.aj.r === 'number' ? x.aj : null;
  if (!es.some((e) => (e.ts || 0) <= t)) return false; // todavía no llegaba
  if (aj && aj.ts <= t) return aj.r + es.filter((e) => e.ts > aj.ts && e.ts <= t).reduce((a, e) => a + (Number(e.q) || 0), 0) > 0;
  return true;
}
// Avisos: tiendas que se llevaron un lote que ya vence (≤30 días o vencido hace ≤15) y no han vuelto a comprar ese producto
async function avisosTienda() {
  const hoy = todayCT(), dHoy = Date.parse(hoy + 'T12:00:00Z');
  const dias = (d) => Math.round((Date.parse(d + 'T12:00:00Z') - dHoy) / 864e5);
  const lotes = (await db('GET', 'lotes')) || {};
  const cand = {};
  Object.entries(lotes).forEach(([sku, v]) => {
    const fs = Object.entries(v.f || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (fs.some(([d]) => dias(d) <= 30 && dias(d) >= -15)) cand[sku] = { n: v.n || '', fs };
  });
  if (!Object.keys(cand).length) return [];
  const from = new Date(dHoy - 150 * 864e5).toISOString().slice(0, 10);
  const invs = await insituGet('/invoices', { fromDate: from + ' 00:00:00', toDate: hoy + ' 23:59:59' }, true);
  const ult = {}; // cliente|sku → última compra
  invs.forEach((inv) => {
    if (invCancel(inv)) return;
    const fecha = invYmd(inv.invoice_date || inv.invoice_ship_date); if (!fecha) return;
    const cid = String(inv.client_branch_code || inv.client_nit || inv.account_number || inv.client_branch_name || '');
    if (!cid) return;
    const mu = inv.mobile_user || {};
    (inv.invoiceDetailList || []).forEach((l) => {
      const sku = String(l.product_code || '').trim(), q = Number(l.quantity) || 0;
      if (!cand[sku] || q <= 0) return;
      const k = cid + '|' + sku, prev = ult[k];
      if (prev && prev.fecha > fecha) return;
      if (prev && prev.fecha === fecha) { prev.cajas += q; return; }
      ult[k] = { cid, sku, fecha, cajas: q, factura: String(inv.invoice_number || ''), tienda: String(inv.client_branch_name || cid),
        vendedorId: String(inv.mobile_user_login || mu.login || inv.mobile_user_id || ''), vendedor: String(mu.name || inv.mobile_user_login || ''), tel: String(mu.phone || '') };
    });
  });
  const cat = await db('GET', 'catalogo');
  const nombre = {};
  ((cat && cat.items) || []).forEach((p) => { nombre[String(p.id)] = p.name; });
  const out = [];
  Object.values(ult).forEach((u) => {
    // Lote que salió (FEFO): el de fecha más próxima que ya había llegado, seguía con cajas y no estaba vencido ese día
    const t = Date.parse(u.fecha + 'T23:59:59Z');
    const lote = cand[u.sku].fs.filter(([d, x]) => d >= u.fecha && loteVivoEn(x, t)).map(([d]) => d).sort()[0];
    if (!lote) return;
    const dd = dias(lote);
    if (dd > 30 || dd < -15) return;
    out.push({ ...u, nombre: nombre[u.sku] || cand[u.sku].n || u.sku, caduca: lote, dias: dd, hace: -dias(u.fecha) });
  });
  return out.sort((a, b) => a.dias - b.dias || a.tienda.localeCompare(b.tienda)).slice(0, 300);
}
const RECIBO_ACTIONS = ['recibo_inventario', 'parse', 'map', 'lookup', 'catalogo', 'recibo_find', 'lote_add', 'lote_del', 'recibo_save', 'recibo_list', 'recibo_get', 'lotes'];
const ESTADOS = ['', 'ok', 'parcial', 'no', 'pendiente'];
const ymdOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');

async function findRecibo(key) {
  if (!key || /\|$/.test(key)) return null;
  const all = (await db('GET', 'recibos')) || {};
  return Object.values(all).filter((r) => r.key === key).sort((a, b) => (b.updated || b.ts) - (a.updated || a.ts))[0] || null;
}

// Lotes = producto + fecha de caducidad. Cada recibo deja su entrada (lotes/{sku}/f/{fecha}/e/{recibo_renglón}):
// la misma fecha suma, otra fecha es otro lote. Al volver a guardar un recibo se reemplazan sus entradas.
// No toca el inventario de InSitu ni de QuickBooks.
// ---- Inventario desde Recibo ----
// Solo recibos terminados desde que existe esto (los de antes ya se metieron a mano).
// Se guarda lo aplicado por producto: si Jona corrige después, solo se ajusta la diferencia (nunca se duplica).
const INV_DESDE = Date.parse('2026-10-09T20:00:00Z');
function piezasDe(l) {
  if (Number(l.unidades_por_caja) > 1) return Number(l.unidades_por_caja);
  const s = `${l.producto || ''} ${l.empaque || ''} ${l.nombre || ''}`;
  const m = s.match(/\bcj\.?\s*(\d{1,3})\b/i) || s.match(/\bcaja\s*(?:de\s*)?(\d{1,3})\b/i) || s.match(/\b(\d{1,3})\s*(?:unds?|pzas?|piezas|pcs|ct)\b/i) || s.match(/(?:^|\s)(\d{1,3})\s*\/\s*\d/);
  return m ? Number(m[1]) : 0;
}
// APAGADO (10 oct 2026): el inventario de InSitu viene de QuickBooks (Jona hace "Recibir artículos" en QB),
// así que ajustar InSitu directo duplicaría. Solo se permite REGRESAR lo que la IA ya hubiera metido.
const INV_INSITU_ACTIVO = false;
async function recInventario(rec) {
  if (!rec.doneAt || rec.doneAt < INV_DESDE) return rec.inv || null;
  if (!INV_INSITU_ACTIVO && !Object.values((rec.inv && rec.inv.aplicado) || {}).some((v) => v)) return rec.inv || null;
  if (!INV_INSITU_ACTIVO) rec = { ...rec, invManual: true }; // si algo ya entró por la IA, se regresa
  const inv = { ...(rec.inv || {}), aplicado: { ...((rec.inv && rec.inv.aplicado) || {}) }, detalle: { ...((rec.inv && rec.inv.detalle) || {}) }, errores: [], at: Date.now() };
  const [pzMem, cat] = await Promise.all([db('GET', 'costeoPz'), db('GET', 'catalogo')]);
  const units = {};
  ((cat && cat.items) || []).forEach((p) => { units[String(p.id)] = String(p.units || ''); });
  const target = {}, cajasBy = {};
  // Metido a mano: no se mete nada (y lo que la IA ya hubiera metido se regresa)
  if (!rec.invManual) rec.lines.forEach((l) => {
    if (!l.sku) return;
    const cajas = l.estado === 'ok' ? l.cantidad : l.estado === 'parcial' ? l.recibido : 0; // solo lo que llegó
    if (!(cajas > 0)) return;
    const mem = (pzMem || {})[codeKey(l.sku)];
    const porPieza = mem > 1 || (mem == null && /each|count|pieza|unit/i.test(units[l.sku] || ''));
    const n = mem > 1 ? mem : piezasDe(l);
    if (porPieza && !(n > 1)) { inv.errores.push(`${l.nombre || l.producto}: se vende por pieza pero no sé cuántas trae la caja`); return; }
    const q = porPieza ? cajas * n : cajas;
    target[l.sku] = r2((target[l.sku] || 0) + q);
    cajasBy[l.sku] = r2((cajasBy[l.sku] || 0) + cajas);
    inv.detalle[l.sku] = { nombre: l.nombre || l.producto, cajas: cajasBy[l.sku], unidad: porPieza ? `piezas (${n} por caja)` : 'cajas', cantidad: target[l.sku] };
  });
  const deltas = [...new Set([...Object.keys(target), ...Object.keys(inv.aplicado)])]
    .map((s) => [s, r2((target[s] || 0) - (inv.aplicado[s] || 0))]).filter(([, d]) => Math.abs(d) > 0.001);
  if (!deltas.length) return inv;
  const stocks = await insituGet('/inventory_stock', {}, true);
  const wc = {};
  stocks.forEach((w) => { wc[w.warehouse_id] = (wc[w.warehouse_id] || 0) + 1; });
  const defW = Number(Object.keys(wc).sort((a, b) => wc[b] - wc[a])[0]);
  // Ubicación (bin) dentro del almacén: InSitu la exige en los ajustes. La del producto, o la más usada del almacén.
  const binOf = (x) => (x && (x.bin_location_id || (Array.isArray(x.bin_locations) && x.bin_locations[0] && x.bin_locations[0].bin_location_id) || (Array.isArray(x.bins) && x.bins[0] && x.bins[0].bin_location_id))) || null;
  const bc = {};
  stocks.forEach((w) => { const b = binOf(w); if (b) { const k = w.warehouse_id + '|' + b; bc[k] = (bc[k] || 0) + 1; } });
  // Las existencias no traen la ubicación: se toma de los ajustes y recepciones que ya se hicieron en InSitu
  for (const [path, key] of [['/inventory_adjustment', 'lines'], ['/item_receipt', 'lines']]) {
    if (Object.keys(bc).length) break;
    try {
      const j = await insituGet(path, { limit: 200, order: JSON.stringify([['id', 'DESC']]) });
      const arr = Object.values(j).find(Array.isArray) || [];
      arr.forEach((x) => [x, ...(Array.isArray(x[key]) ? x[key] : [])].forEach((y) => { const b = binOf(y); if (b && y.warehouse_id) { const k = y.warehouse_id + '|' + b; bc[k] = (bc[k] || 0) + 1; } }));
    } catch (e) { /* sigue */ }
  }
  const defBin = (wid) => { const k = Object.keys(bc).filter((x) => x.startsWith(wid + '|')).sort((a, b) => bc[b] - bc[a])[0] || Object.keys(bc).sort((a, b) => bc[b] - bc[a])[0]; return k ? Number(k.split('|')[1]) : null; };
  let hechos = 0;
  for (const [sku, d] of deltas) {
    const nom = (inv.detalle[sku] || {}).nombre || sku;
    try {
      const pr = await insituGet('/products', { where: JSON.stringify({ code: sku }) });
      const p = (Object.values(pr).find(Array.isArray) || []).find((x) => String(x.code).trim() === sku);
      if (!p) throw new Error('no está en InSitu todavía');
      const mine = stocks.filter((x) => x.product_id === p.id);
      const wid = mine.length ? mine.sort((a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0))[0].warehouse_id : defW;
      const cur = mine.filter((x) => x.warehouse_id === wid).reduce((a, x) => a + (Number(x.stock) || 0), 0);
      const bin = binOf(mine.find((x) => x.warehouse_id === wid && binOf(x))) || defBin(wid);
      if (!bin) throw new Error(`InSitu no dice la ubicación (bin) del almacén${stocks[0] ? ' · campos: ' + Object.keys(stocks[0]).join(',').slice(0, 120) : ''}`);
      await insituPost('/inventory_adjustment', { warehouse_id: wid, bin_location_id: bin, product_id: p.id, quantity: d, new_quantity: r2(cur + d), remark: `Recibo IA: ${rec.proveedor} #${rec.factura}`.slice(0, 200), ref_number: String(rec.factura || '').slice(0, 60), approved: 1 });
      inv.aplicado[sku] = r2((inv.aplicado[sku] || 0) + d);
      hechos++;
      // Comprobar que la existencia sí cambió
      try {
        const v = await insituGet('/inventory_stock', { where: JSON.stringify({ product_id: p.id }) });
        const now = (Object.values(v).find(Array.isArray) || []).filter((x) => x.product_id === p.id && x.warehouse_id === wid).reduce((a, x) => a + (Number(x.stock) || 0), 0);
        if (Math.abs(now - (cur + d)) > 0.01) inv.errores.push(`${nom}: se mandó +${d} pero InSitu muestra ${now} (antes ${cur}); revisa si el ajuste necesita aprobación`);
      } catch (e) { /* sin comprobación */ }
      await log({ action: 'recibo-inventario', name: nom, sku, qty: d, antes: cur, factura: rec.factura, proveedor: rec.proveedor, by: rec.updatedBy || '' });
    } catch (e) {
      inv.errores.push(`${nom}: ${e.message || e}`);
    }
  }
  inv.hechos = hechos;
  return inv;
}

async function syncLotes(id, prev, rec) {
  const up = {};
  ((prev && prev.lines) || []).forEach((l, i) => {
    if (l.sku && l.caducidad) up[`lotes/${codeKey(l.sku)}/f/${l.caducidad}/e/${id}_${i}`] = null;
    if (l.sku && Array.isArray(l.fechas)) l.fechas.forEach((x, k) => { if (x.f) up[`lotes/${codeKey(l.sku)}/f/${x.f}/e/${id}_${i}_${k}`] = null; });
  });
  rec.lines.forEach((l, i) => {
    const q = l.estado === 'ok' ? (l.recibido ?? l.cantidad) : l.estado === 'parcial' ? l.recibido : 0;
    if (!l.sku || !l.caducidad || !(q > 0)) return;
    if (Array.isArray(l.fechas) && l.fechas.length > 1) {
      // Varias fechas en el mismo renglón: un lote por fecha con sus cajas
      l.fechas.forEach((x, k) => { up[`lotes/${codeKey(l.sku)}/f/${x.f}/e/${id}_${i}_${k}`] = { q: x.q, f: rec.factura, p: rec.proveedor, ts: Date.now() }; });
    } else up[`lotes/${codeKey(l.sku)}/f/${l.caducidad}/e/${id}_${i}`] = { q, f: rec.factura, p: rec.proveedor, ts: Date.now() };
    up[`lotes/${codeKey(l.sku)}/n`] = l.nombre || l.producto;
  });
  if (Object.keys(up).length) await db('PATCH', '', up);
}

function str(v, n) { return String(v == null ? '' : v).slice(0, n); }
function num(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null; }
module.exports.avisosTienda = avisosTienda; // para pruebas
module.exports.recInventario = recInventario;
