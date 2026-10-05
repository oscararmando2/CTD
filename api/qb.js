// API de QuickBooks para la IA de especiales (solo usuarios de la IA, con su token de Firebase).
// POST {action, ...}:
//   status     → ¿conectado?, empresa, ambiente (sandbox/production)
//   match      → busca en QuickBooks los productos de InSitu (por Id, Sku/UPC o nombre)
//   schedule   → programa especiales {qbId, special, from, to}; si empiezan hoy se aplican ya
//   cancel     → cancela un especial (si ya estaba activo, regresa el precio original)
//   list       → especiales programados/activos/terminados + últimos cambios
//   tick       → aplica/regresa lo que toque hoy (respaldo de la tarea diaria)
//   selftest   → solo sandbox: cambia y regresa el precio de un producto de prueba
//   disconnect → revoca el permiso en Intuit y borra los tokens guardados
const { RECIBO_ONLY, COSTEO_ONLY, cors, verifyUser, bearer, db, qb, qbQuery, qbItem, qbSetPrice, tick, log, todayCT, r2, same, QB_ENV, env, matchOne } = require('./_lib');

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  let who = null;
  try { who = await verifyUser(bearer(req)); } catch (e) { who = null; }
  if (!who) return res.status(401).json({ error: 'Sin acceso. Vuelve a entrar a la IA.' });
  if (RECIBO_ONLY.includes(who) || COSTEO_ONLY.includes(who)) return res.status(403).json({ error: 'Tu usuario no tiene acceso a especiales de QuickBooks.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  try {
    switch (body.action) {
      case 'status': {
        const t = await db('GET', 'qb/tokens');
        if (!t || !t.refresh_token || t.env !== QB_ENV()) return res.json({ connected: false, env: QB_ENV() });
        let company = '';
        try { const d = await qb('GET', `companyinfo/${t.realmId}`); company = d.CompanyInfo && d.CompanyInfo.CompanyName; } catch (e) { return res.json({ connected: false, env: QB_ENV(), error: e.message }); }
        return res.json({ connected: true, env: QB_ENV(), company, connectedBy: t.connectedBy, connectedAt: t.connectedAt, refreshExpires: t.refresh_expires_at });
      }
      case 'match': {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30);
        const out = {};
        for (const p of items) out[String(p.sku)] = await matchOne(p);
        return res.json({ matches: out });
      }
      case 'schedule': {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30);
        const all = (await db('GET', 'qbEspeciales')) || {};
        const today = todayCT();
        const saved = [], errors = [];
        for (const p of items) {
          const special = r2(p.special), regular = r2(p.regular);
          if (!p.qbId || !(special > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.to < p.from) { errors.push({ name: p.name, error: 'Datos incompletos' }); continue; }
          if (p.to < today) { errors.push({ name: p.name, error: 'La vigencia ya terminó' }); continue; }
          const clash = Object.values(all).find((e) => e.qbId === String(p.qbId) && ['programado', 'activo'].includes(e.status) && !(p.to < e.from || p.from > e.to));
          if (clash) { errors.push({ name: p.name, error: `Ya tiene un especial del ${clash.from} al ${clash.to}` }); continue; }
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          const rec = { qbId: String(p.qbId), qbName: String(p.qbName || ''), sku: String(p.sku || ''), name: String(p.name || ''), special, regular,
            from: p.from, to: p.to, status: 'programado', by: who, ts: Date.now(),
            // Especial de grupo (mismo precio): para volver a mostrarlo junto en el PDF de vigentes
            ...(p.grupo ? { grupo: String(p.grupo).slice(0, 40), grupoTitulo: String(p.grupoTitulo || '').slice(0, 80), grupoCorto: String(p.grupoCorto || '').slice(0, 240) } : {}) };
          await db('PUT', 'qbEspeciales/' + id, rec);
          await log({ id, action: 'programar', name: rec.name, special, from: p.from, to: p.to, by: who });
          all[id] = rec; saved.push(id);
        }
        const done = saved.length ? await tick(who) : [];
        return res.json({ saved, errors, applied: done.filter((d) => d.action === 'activar').length });
      }
      case 'cancel': {
        const id = String(body.id || '');
        const e = await db('GET', 'qbEspeciales/' + id);
        if (!e) return res.status(404).json({ error: 'No existe' });
        if (e.status === 'activo') {
          const it = await qbItem(e.qbId);
          if (same(it.UnitPrice, e.special)) {
            await qbSetPrice(e.qbId, r2(e.original));
            await log({ id, action: 'cancelar-regresar', name: e.name, from: r2(e.special), to: r2(e.original), by: who });
          } else {
            await log({ id, action: 'cancelar-sin-regresar', name: e.name, price: r2(it.UnitPrice), by: who });
          }
        } else {
          await log({ id, action: 'cancelar', name: e.name, by: who });
        }
        if (['programado', 'activo'].includes(e.status)) await db('PATCH', 'qbEspeciales/' + id, { status: 'cancelado', cancelledBy: who, cancelledAt: Date.now() });
        return res.json({ ok: true });
      }
      case 'list': {
        const all = (await db('GET', 'qbEspeciales')) || {};
        const list = Object.entries(all).map(([id, e]) => ({ id, ...e })).sort((a, b) => (b.from || '').localeCompare(a.from || '') || b.ts - a.ts).slice(0, 150);
        return res.json({ list, today: todayCT() });
      }
      case 'tick': {
        const done = await tick(who);
        return res.json({ done });
      }
      case 'selftest': {
        if (QB_ENV() !== 'sandbox') return res.status(400).json({ error: 'La prueba solo corre en la empresa de prueba (sandbox)' });
        const r = await qbQuery("select * from Item where Type = 'NonInventory' maxresults 5");
        const r2x = (r.Item && r.Item.length) ? r : await qbQuery('select * from Item maxresults 5');
        const it = (r2x.Item || []).find((x) => x.UnitPrice > 0) || (r2x.Item || [])[0];
        if (!it) return res.json({ error: 'La empresa de prueba no tiene productos' });
        const before = r2(it.UnitPrice || 0), test = r2(before + 1);
        await qbSetPrice(it.Id, test);
        const mid = r2((await qbItem(it.Id)).UnitPrice);
        await qbSetPrice(it.Id, before);
        const after = r2((await qbItem(it.Id)).UnitPrice);
        return res.json({ ok: mid === test && after === before, name: it.Name, before, test, mid, after });
      }
      case 'disconnect': {
        const t = await db('GET', 'qb/tokens');
        if (t && t.refresh_token) {
          await fetch('https://developer.api.intuit.com/v2/oauth2/tokens/revoke', {
            method: 'POST',
            headers: { Authorization: 'Basic ' + Buffer.from(`${env('QB_CLIENT_ID')}:${env('QB_CLIENT_SECRET')}`).toString('base64'), Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: t.refresh_token }),
          }).catch(() => {});
        }
        await db('DELETE', 'qb/tokens');
        await log({ action: 'desconectar', by: who });
        return res.json({ ok: true });
      }
      default:
        return res.status(400).json({ error: 'Acción desconocida' });
    }
  } catch (e) {
    return res.status(e.code === 'not_connected' ? 409 : 500).json({ error: String(e.message || e), code: e.code || '' });
  }
};
