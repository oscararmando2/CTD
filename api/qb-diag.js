// Diagnóstico de configuración de QuickBooks (NO muestra las llaves: solo si existen, su largo
// y si traen espacios o saltos de línea pegados por error).
const { QB_ENV, REDIRECT_URI } = require('./_lib');

// length = largo ya sin espacios de las orillas; inner_spaces = espacios en medio (eso sí está mal)
const check = (raw) => { const v = String(raw || '').trim(); return v ? { set: true, length: v.length, prefix: v.slice(0, 2), inner_spaces: /\s/.test(v) } : { set: false }; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    env: QB_ENV(),
    redirect_uri: REDIRECT_URI,
    QB_CLIENT_ID: check(process.env.QB_CLIENT_ID),
    QB_CLIENT_SECRET: (({ set, length, inner_spaces }) => ({ set, length, inner_spaces }))(check(process.env.QB_CLIENT_SECRET)),
    CTD_FIREBASE_SA: { set: !!process.env.CTD_FIREBASE_SA },
  });
};
