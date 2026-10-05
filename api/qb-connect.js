// Inicia la conexión con QuickBooks: la IA abre esta dirección con el token de Firebase del usuario
// (solo Oscar o Luis) y aquí se redirige a la pantalla de autorización de Intuit.
const crypto = require('crypto');
const { RECIBO_ONLY, COSTEO_ONLY, verifyUser, db, IA_URL, REDIRECT_URI, env } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const who = await verifyUser(String(req.query.t || ''));
    if (!who || RECIBO_ONLY.includes(who) || COSTEO_ONLY.includes(who)) return res.redirect(302, IA_URL + '?qb=sin-acceso');
    if (!env('QB_CLIENT_ID')) return res.redirect(302, IA_URL + '?qb=faltan-llaves');
    const state = crypto.randomBytes(16).toString('hex');
    await db('PUT', 'qb/oauthState/' + state, { by: who, ts: Date.now() });
    const q = new URLSearchParams({
      client_id: env('QB_CLIENT_ID'),
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: REDIRECT_URI,
      state,
    });
    return res.redirect(302, 'https://appcenter.intuit.com/connect/oauth2?' + q.toString());
  } catch (e) {
    return res.redirect(302, IA_URL + '?qb=error&m=' + encodeURIComponent(String(e.message || e).slice(0, 120)));
  }
};
