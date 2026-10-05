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
const { RECIBO_ONLY, cors, verifyUser, bearer, db, qb, qbQuery, qbItem, log, todayCT, r2, same, env, matchOne, norm } = require('./_lib');

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
        const m = (await db('GET', 'costeoMap/' + vendorKey(body.proveedor))) || {};
        return res.json({ map: m });
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
            if (tpl.Type === 'Inventory') Object.assign(item, { AssetAccountRef: tpl.AssetAccountRef, TrackQtyOnHand: true, QtyOnHand: 0, InvStartDate: todayCT() });
            const d = await qb('POST', 'item', item);
            await log({ action: 'costeo-alta', name, qbId: d.Item.Id, price: item.UnitPrice, cost: item.PurchaseCost, factura: body.factura || '', by: who });
            if (c.photo) await db('PUT', 'costeoFotos/' + d.Item.Id, { photo: String(c.photo).slice(0, 1000), name, sku: item.Sku || '', ts: Date.now(), by: who });
            results.push({ create: name, ok: true, qbId: d.Item.Id, type: tpl.Type });
          } catch (err) {
            results.push({ create: c.name, ok: false, error: String(err.message || err) });
          }
        }
        return res.json({ results });
      }
      case 'save': {
        const f = body.factura || {};
        const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        const key = vendorKey(f.proveedor) + '|' + codeKey(f.factura);
        const rec = {
          key, proveedor: str(f.proveedor, 120), factura: str(f.factura, 60), fecha: str(f.fecha, 10),
          total_factura: num(f.total_factura), total_calculado: num(f.total_calculado), cuadra: f.cuadra ?? null,
          flete: num(f.flete), creditos: num(f.creditos), otros_cargos: num(f.otros_cargos),
          lines: (Array.isArray(f.lines) ? f.lines : []).slice(0, 300).map((l) => ({
            producto: str(l.producto, 160), upc: str(l.upc, 40), codigo_proveedor: str(l.codigo_proveedor, 40), cantidad: num(l.cantidad),
            empaque: str(l.empaque, 40), costo_caja: num(l.costo_caja), sku: str(l.sku, 40), qbId: str(l.qbId, 40), nombre: str(l.nombre, 160),
            costo_antes: num(l.costo_antes), precio_antes: num(l.precio_antes), precio_nuevo: num(l.precio_nuevo), aplicado: !!l.aplicado, nuevo: !!l.nuevo,
            caducidad: ymdOk(l.caducidad),
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
      case 'photos': {
        return res.json({ photos: (await db('GET', 'costeoFotos')) || {} });
      }
      case 'photo_done': {
        await db('DELETE', 'costeoFotos/' + String(body.qbId || ''));
        return res.json({ ok: true });
      }
      case 'catalogo_save': {
        // Copia del catálogo de InSitu (con fotos) que sube quien sincroniza, para Recibo en el teléfono de bodega
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 5000).map((p) => ({ id: str(p.id, 40), name: str(p.name, 160), upc: str(p.upc, 40), photo: /^https:\/\//.test(p.photo || '') ? str(p.photo, 500) : '' })).filter((p) => p.id && p.name);
        if (!items.length) return res.status(400).json({ error: 'Catálogo vacío' });
        await db('PUT', 'catalogo', { at: Date.now(), by: who, items });
        return res.json({ ok: true, n: items.length });
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
          })),
          nota: str(r.nota, 1500),
          status: final ? (costeoId ? 'costeado' : 'revisado') : 'borrador',
          by: (prev && prev.by) || who, ts: (prev && prev.ts) || now, updated: now, updatedBy: who,
          doneAt: final ? ((prev && prev.doneAt) || now) : null,
        };
        await db('PUT', 'recibos/' + id, rec);
        if (final) await syncLotes(id, prev, rec);
        if (final && costeoId) {
          // Aviso para Costeo: lo que bodega encontró distinto a la factura
          const dif = rec.lines.filter((l) => l.estado !== 'ok' || l.nota).map((l) => ({ producto: l.nombre || l.producto, estado: l.estado || 'sin revisar', recibido: l.recibido, cantidad: l.cantidad, nota: l.nota }));
          await db('PATCH', 'costeoFacturas/' + costeoId, { bodega: { reciboId: id, by: rec.updatedBy, at: now, nota: rec.nota, dif } });
        }
        return res.json({ id, status: rec.status, costeoId });
      }
      case 'recibo_list': {
        const all = (await db('GET', 'recibos')) || {};
        const list = Object.values(all).map((f) => {
          const L = f.lines || [];
          const c = (e) => L.filter((l) => l.estado === e).length;
          return { id: f.id, proveedor: f.proveedor, factura: f.factura, fecha: f.fecha, status: f.status, by: f.by, ts: f.ts, updated: f.updated, doneAt: f.doneAt || null,
            lines: L.length, ok: c('ok'), parcial: c('parcial'), no: c('no'), pendiente: c('pendiente'), sinRevisar: c(''),
            fechas: L.filter((l) => l.caducidad).length, costeoId: f.costeoId || null, origen: f.origen || 'bodega', updatedBy: f.updatedBy || '' };
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
      case 'lotes': {
        // { sku: { nombre, fechas: { 'YYYY-MM-DD': cajas recibidas con esa caducidad } } }
        const all = (await db('GET', 'lotes')) || {};
        const out = {};
        Object.entries(all).forEach(([sku, v]) => {
          const fechas = {};
          Object.entries(v.f || {}).forEach(([d, x]) => {
            const q = Object.values(x.e || {}).reduce((a, e) => a + (Number(e.q) || 0), 0);
            const last = Object.values(x.e || {}).reduce((a, e) => Math.max(a, e.ts || 0), 0);
            if (q > 0) fechas[d] = { q: r2(q), ts: last };
          });
          if (Object.keys(fechas).length) out[sku] = { nombre: v.n || '', fechas };
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

const RECIBO_ACTIONS = ['parse', 'map', 'lookup', 'catalogo', 'recibo_find', 'recibo_save', 'recibo_list', 'recibo_get', 'lotes'];
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
async function syncLotes(id, prev, rec) {
  const up = {};
  ((prev && prev.lines) || []).forEach((l, i) => {
    if (l.sku && l.caducidad) up[`lotes/${codeKey(l.sku)}/f/${l.caducidad}/e/${id}_${i}`] = null;
  });
  rec.lines.forEach((l, i) => {
    const q = l.estado === 'ok' ? (l.recibido ?? l.cantidad) : l.estado === 'parcial' ? l.recibido : 0;
    if (!l.sku || !l.caducidad || !(q > 0)) return;
    up[`lotes/${codeKey(l.sku)}/f/${l.caducidad}/e/${id}_${i}`] = { q, f: rec.factura, p: rec.proveedor, ts: Date.now() };
    up[`lotes/${codeKey(l.sku)}/n`] = l.nombre || l.producto;
  });
  if (Object.keys(up).length) await db('PATCH', '', up);
}

function str(v, n) { return String(v == null ? '' : v).slice(0, n); }
function num(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null; }
