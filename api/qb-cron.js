// Tarea diaria (Vercel Cron, ~4am Chicago): activa los especiales que empiezan hoy y regresa el
// precio original de los que ya terminaron. Si hay CRON_SECRET, Vercel lo manda y aquí se exige.
const { tick } = require('./_lib');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== 'Bearer ' + secret) return res.status(401).json({ error: 'No autorizado' });
  try {
    const done = await tick('automático');
    return res.status(200).json({ ok: true, done });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
