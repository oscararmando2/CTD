// Especiales vigentes para la web pública del catálogo (centraltradedist.com/catalogo).
// GET, sin sesión: solo lo que el cliente ya ve en la web (nombre, precio especial, precio normal, fechas, foto).
// Nunca costos ni márgenes. Se arma con los especiales programados en la IA (qbEspeciales) y la copia del catálogo.
const { db, todayCT, r2 } = require('./_lib');

const ALLOWED_ORIGINS = ['https://www.centraltradedist.com', 'https://centraltradedist.com', 'https://ctd-seven.vercel.app'];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  try {
    const today = todayCT();
    const [all, cat] = await Promise.all([db('GET', 'qbEspeciales'), db('GET', 'catalogo')]);
    const items = (cat && Array.isArray(cat.items)) ? cat.items : [];
    const byId = {};
    items.forEach((p) => { if (p && p.id) byId[String(p.id)] = p; });
    // Vigentes hoy (activos) y los que empiezan en los próximos 7 días (programados)
    const limit = new Date(today + 'T12:00:00Z'); limit.setUTCDate(limit.getUTCDate() + 7);
    const hasta = limit.toISOString().slice(0, 10);
    const list = Object.values(all || {})
      .filter((e) => e && ['activo', 'programado'].includes(e.status) && e.to >= today && e.from <= hasta)
      .map((e) => {
        const p = byId[String(e.sku)] || {};
        const regular = e.original != null ? e.original : e.regular;
        return {
          code: String(e.sku || ''),
          nombre: e.name || e.qbName || p.name || '',
          precio: r2(e.special),
          antes: regular != null ? r2(regular) : null,
          desde: e.from, hasta: e.to,
          estado: e.status === 'activo' && e.from <= today ? 'activo' : 'proximo',
          foto: p.photo || '',
          empaque: p.pack || '',
          departamento: p.cat || '',
          grupo: e.grupo || '', grupoTitulo: e.grupoTitulo || '', grupoCorto: e.grupoCorto || '',
        };
      })
      .sort((a, b) => (a.estado === b.estado ? a.desde.localeCompare(b.desde) : a.estado === 'activo' ? -1 : 1));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5 min
    return res.json({ hoy: today, especiales: list });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudieron leer los especiales' });
  }
};
