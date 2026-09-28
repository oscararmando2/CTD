// Intuit regresa aquí después de que el administrador de QuickBooks autoriza la conexión.
// Se cambia el código por los tokens y se guardan en la base (solo el servidor los puede leer).
const { db, qbTokenRequest, tokenRecord, IA_URL, REDIRECT_URI } = require('./_lib');

module.exports = async (req, res) => {
  const back = (s, m) => res.redirect(302, IA_URL + '?qb=' + s + (m ? '&m=' + encodeURIComponent(String(m).slice(0, 120)) : ''));
  try {
    const { code, state, realmId, error } = req.query;
    if (error) return back('cancelado', error);
    if (!code || !state || !realmId) return back('error', 'Faltan datos de Intuit');
    const st = await db('GET', 'qb/oauthState/' + state);
    await db('DELETE', 'qb/oauthState/' + state);
    if (!st || Date.now() - st.ts > 15 * 60 * 1000) return back('error', 'La solicitud expiró, intenta de nuevo');
    const d = await qbTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    await db('PUT', 'qb/tokens', tokenRecord(d, { realmId: String(realmId), connectedBy: st.by, connectedAt: Date.now() }));
    return back('conectado');
  } catch (e) {
    return back('error', e.message || e);
  }
};
