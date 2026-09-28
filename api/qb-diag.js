// Diagnóstico de configuración de QuickBooks (NO muestra las llaves: solo si existen, su largo
// y si traen espacios o saltos de línea pegados por error).
const { QB_ENV, REDIRECT_URI } = require('./_lib');

const check = (v) => (v ? { set: true, length: v.length, prefix: v.slice(0, 2), spaces: /\s/.test(v) } : { set: false });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    env: QB_ENV(),
    redirect_uri: REDIRECT_URI,
    QB_CLIENT_ID: check(process.env.QB_CLIENT_ID),
    QB_CLIENT_SECRET: (({ set, length, spaces }) => ({ set, length, spaces }))(check(process.env.QB_CLIENT_SECRET)),
    CTD_FIREBASE_SA: { set: !!process.env.CTD_FIREBASE_SA },
  });
};
