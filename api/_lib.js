// Utilidades compartidas de las funciones de CTD en Vercel (proyecto ctd → ctd-seven.vercel.app).
// Archivos con "_" no se publican como endpoint. Nada de llaves aquí: todo viene de variables
// de entorno de Vercel (QB_CLIENT_ID, QB_CLIENT_SECRET, CTD_FIREBASE_SA, QB_ENVIRONMENT, CRON_SECRET).

const crypto = require('crypto');

const ALLOWED_ORIGINS = ['https://www.centraltradedist.com', 'https://centraltradedist.com', 'https://ctd-seven.vercel.app'];
const ALLOWED_EMAILS = ['oscar@ctd-ia.firebaseapp.com', 'luis@ctd-ia.firebaseapp.com'];
const FIREBASE_WEB_KEY = 'AIzaSyBhJuY0Wdh_UeZL0KHNn5WofWYPhQiVTuU'; // llave web pública del proyecto ctd-ia
const DB_URL = 'https://ctd-ia-default-rtdb.firebaseio.com';
const IA_URL = 'https://www.centraltradedist.com/IA/';
const REDIRECT_URI = 'https://ctd-seven.vercel.app/api/qb-callback';
const TZ = 'America/Chicago';

function cors(req, res, methods = 'POST, OPTIONS') {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Verifica el token de Firebase (Oscar o Luis) con Google y devuelve su nombre.
async function verifyUser(idToken) {
  if (!idToken) return null;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const email = String((d.users && d.users[0] && d.users[0].email) || '').toLowerCase();
  if (!ALLOWED_EMAILS.includes(email)) return null;
  return email.startsWith('oscar') ? 'Oscar' : 'Luis';
}
const bearer = (req) => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/* ---------- Realtime Database con la cuenta de servicio (solo servidor) ----------
 * Los nodos qb/ y qbEspeciales/ no son legibles desde el navegador (reglas: .read/.write false);
 * la cuenta de servicio entra como administrador. */
let saToken = null;
function b64url(x) { return Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function adminToken() {
  if (saToken && saToken.exp > Date.now() + 60000) return saToken.token;
  const raw = process.env.CTD_FIREBASE_SA;
  if (!raw) throw new Error('Falta CTD_FIREBASE_SA en Vercel');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
  }));
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key);
  const jwt = head + '.' + claim + '.' + b64url(sig);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Firebase admin: ' + (d.error_description || d.error || r.status));
  saToken = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return saToken.token;
}
async function db(method, path, body) {
  const t = await adminToken();
  const r = await fetch(`${DB_URL}/${path}.json?access_token=${t}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DB ${method} ${path}: ${r.status}`);
  return r.json();
}

/* ---------- QuickBooks Online ---------- */
const QB_ENV = () => (process.env.QB_ENVIRONMENT === 'production' ? 'production' : 'sandbox');
const QB_API = () => (QB_ENV() === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
// Las llaves se pegan a mano en Vercel: se ignoran espacios/saltos de línea al principio y al final
const env = (k) => String(process.env[k] || '').trim();
const basicAuth = () => 'Basic ' + Buffer.from(`${env('QB_CLIENT_ID')}:${env('QB_CLIENT_SECRET')}`).toString('base64');

async function qbTokenRequest(params) {
  const r = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuth(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('QuickBooks rechazó la autorización: ' + (d.error_description || d.error || r.status));
  return d;
}
function tokenRecord(d, extra) {
  const now = Date.now();
  return { ...extra, access_token: d.access_token, refresh_token: d.refresh_token, expires_at: now + (d.expires_in - 60) * 1000,
    refresh_expires_at: now + (d.x_refresh_token_expires_in || 0) * 1000, env: QB_ENV(), updated: now };
}
// Token vigente de QuickBooks; se renueva solo (el refresh token de Intuit rota: se guarda el nuevo).
async function qbAuth() {
  const t = await db('GET', 'qb/tokens');
  if (!t || !t.refresh_token) throw Object.assign(new Error('QuickBooks no está conectado'), { code: 'not_connected' });
  if (t.env !== QB_ENV()) throw Object.assign(new Error('La conexión es de ' + t.env + '; vuelve a conectar QuickBooks'), { code: 'not_connected' });
  if (t.expires_at > Date.now()) return t;
  const d = await qbTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  const nt = tokenRecord(d, { realmId: t.realmId, connectedBy: t.connectedBy, connectedAt: t.connectedAt });
  await db('PUT', 'qb/tokens', nt);
  return nt;
}
async function qb(method, path, body) {
  const t = await qbAuth();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${QB_API()}/v3/company/${t.realmId}/${path}${sep}minorversion=75`, {
    method,
    headers: { Authorization: 'Bearer ' + t.access_token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const f = d.Fault && d.Fault.Error && d.Fault.Error[0];
    throw new Error('QuickBooks: ' + (f ? `${f.Message} ${f.Detail || ''}` : r.status));
  }
  return d;
}
const qbQuery = async (sql) => ((await qb('GET', 'query?query=' + encodeURIComponent(sql))).QueryResponse || {});
const qbItem = async (id) => (await qb('GET', 'item/' + encodeURIComponent(id))).Item;
// Cambia solo el precio (sparse update con el SyncToken vigente)
async function qbSetPrice(id, price) {
  const it = await qbItem(id);
  const d = await qb('POST', 'item', { Id: it.Id, SyncToken: it.SyncToken, sparse: true, UnitPrice: price });
  return d.Item;
}

/* ---------- Especiales programados ---------- */
const todayCT = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const same = (a, b) => Math.abs(r2(a) - r2(b)) < 0.005;
async function log(entry) {
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  await db('PUT', 'qbLog/' + id, { ts: Date.now(), ...entry });
}

// Aplica y regresa precios según la fecha de hoy (Chicago). Idempotente: se puede correr varias veces.
async function tick(by = 'automático') {
  const all = (await db('GET', 'qbEspeciales')) || {};
  const today = todayCT();
  const done = [];
  for (const [id, e] of Object.entries(all)) {
    try {
      if (e.status === 'programado' && e.from <= today && e.to >= today) {
        const it = await qbItem(e.qbId);
        const original = r2(it.UnitPrice || 0);
        await qbSetPrice(e.qbId, r2(e.special));
        await db('PATCH', 'qbEspeciales/' + id, { status: 'activo', original, appliedAt: Date.now() });
        await log({ id, action: 'activar', name: e.name, from: original, to: r2(e.special), by });
        done.push({ id, action: 'activar' });
      } else if (e.status === 'programado' && e.to < today) {
        await db('PATCH', 'qbEspeciales/' + id, { status: 'vencido', note: 'La fecha pasó sin activarse' });
      } else if (e.status === 'activo' && e.to < today) {
        const it = await qbItem(e.qbId);
        if (same(it.UnitPrice, e.special)) {
          await qbSetPrice(e.qbId, r2(e.original));
          await db('PATCH', 'qbEspeciales/' + id, { status: 'terminado', revertedAt: Date.now() });
          await log({ id, action: 'regresar', name: e.name, from: r2(e.special), to: r2(e.original), by });
          done.push({ id, action: 'regresar' });
        } else {
          // Alguien lo cambió a mano mientras duraba el especial: no se toca
          await db('PATCH', 'qbEspeciales/' + id, { status: 'omitido', note: `El precio en QuickBooks ya era ${r2(it.UnitPrice)}; no se regresó a ${r2(e.original)}` });
          await log({ id, action: 'omitido', name: e.name, price: r2(it.UnitPrice), by });
        }
      }
    } catch (err) {
      await db('PATCH', 'qbEspeciales/' + id, { lastError: String(err.message || err), lastErrorAt: Date.now() });
      if (err.code === 'not_connected') break;
    }
  }
  return done;
}

module.exports = {
  cors, verifyUser, bearer, db, qbTokenRequest, tokenRecord, qbAuth, qb, qbQuery, qbItem, qbSetPrice, tick, log,
  todayCT, r2, same, QB_ENV, IA_URL, REDIRECT_URI, env,
};
