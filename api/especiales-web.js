// Especiales vigentes para la web pública del catálogo (centraltradedist.com/catalogo).
// GET, sin sesión: solo lo que el cliente ya ve en la web (nombre, precio especial, precio normal, fechas, foto).
// Nunca costos ni márgenes. Se arma con los especiales programados en la IA (qbEspeciales) y la copia del catálogo.
const { db, todayCT, r2 } = require('./_lib');

// Nombres cortos de los productos de un grupo (igual que en la IA): se quita lo que comparten, tamaños y empaques
const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SHORT_STOP = new Set(['oz', 'fl', 'lb', 'lbs', 'ml', 'lt', 'lts', 'gr', 'grs', 'kg', 'ct', 'cs', 'pk', 'pz', 'pcs', 'pc', 'bag', 'pack', 'pck', 'caja', 'case', 'ow', 'bs', 'bolsa', 'und', 'unds', 'x', 'jar', 'tin', 'box', 'display', 'disp', 'shipper', 'cookie', 'cookies', 'galleta', 'galletas', 'gta', 'mto', 'fda', 'flavor', 'sabor', 'pieces', 'piezas']);
const CONECT = new Set(['de', 'la', 'el', 'los', 'las', 'y', 'con', 'del', 'en']);
const SABOR = { lemon: 'Limón', lime: 'Limón', strawberry: 'Fresa', vanilla: 'Vainilla', vanila: 'Vainilla', coconut: 'Coco', orange: 'Naranja', pineapple: 'Piña', grape: 'Uva', apple: 'Manzana', peach: 'Durazno', cherry: 'Cereza', guava: 'Guayaba', tamarind: 'Tamarindo', watermelon: 'Sandía', blackberry: 'Mora', cinnamon: 'Canela', honey: 'Miel', milk: 'Leche', caramel: 'Cajeta', passionfruit: 'Maracuyá', soursop: 'Guanábana', banana: 'Plátano', white: 'Blanca', red: 'Roja', green: 'Verde', hot: 'Picante', spicy: 'Picante' };
function shortNames(names) {
  const toks = names.map((n) => String(n).replace(/[\/,.()]+/g, ' ').split(/\s+/).filter(Boolean));
  const common = new Set(toks[0].map(normTxt).filter((w) => !CONECT.has(w) && toks.every((ts) => ts.some((x) => normTxt(x) === w))));
  return toks.map((ts) => {
    let k = ts.filter((w) => !common.has(normTxt(w)) && !/\d/.test(w) && !SHORT_STOP.has(normTxt(w)));
    while (k.length && CONECT.has(normTxt(k[0]))) k.shift();
    while (k.length && CONECT.has(normTxt(k[k.length - 1]))) k.pop();
    if (!k.length) k = ts.filter((w) => !/\d/.test(w)).slice(0, 2);
    return k.slice(0, 4).map((w) => SABOR[normTxt(w)] || w).join(' ').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()).replace(/\b(De|La|El|Los|Las|Y|Con|Del|En)\b/g, (m) => m.toLowerCase());
  });
}

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
    const [all, cat, props] = await Promise.all([db('GET', 'qbEspeciales'), db('GET', 'catalogo'), db('GET', 'propuestas')]);
    // Grupos armados en las propuestas guardadas de la IA (para los programados antes de que se guardara el grupo)
    const grupoDe = {};
    Object.entries(props || {}).forEach(([pid, h]) => (Array.isArray(h && h.cards) ? h.cards : []).forEach((c, i) => {
      if (!c || c.kind !== 'group' || !Array.isArray(c.items) || c.items.length < 2) return;
      const names = c.items.map((x) => x.name || '');
      const corto = c.shortEdited && c.shortTxt ? c.shortTxt : shortNames(names).join(' · ');
      c.items.forEach((x) => { grupoDe[`${x.id}|${c.from}|${c.to}`] = { grupo: `p_${pid}_${i}`, titulo: c.title || '', corto }; });
    }));
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
          ...(() => {
            const g = e.grupo ? null : grupoDe[`${e.sku}|${e.from}|${e.to}`];
            return { grupo: e.grupo || (g && g.grupo) || '', grupoTitulo: e.grupoTitulo || (g && g.titulo) || '', grupoCorto: e.grupoCorto || (g && g.corto) || '' };
          })(),
        };
      })
      .sort((a, b) => (a.estado === b.estado ? a.desde.localeCompare(b.desde) : a.estado === 'activo' ? -1 : 1));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5 min
    return res.json({ hoy: today, especiales: list });
  } catch (e) {
    return res.status(500).json({ error: 'No se pudieron leer los especiales' });
  }
};
