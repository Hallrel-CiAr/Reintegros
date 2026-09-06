'use strict';
/*
 * Lista los registros de "records" en Firestore desde una fecha en adelante,
 * para poder revisar a ojo si algún valor quedó cargado con precio de ida y
 * vuelta en vez de solo ida (u otro dato sospechoso) — no modifica nada,
 * solo imprime.
 *
 * Se dispara desde GitHub Actions (ver .github/workflows/listar-registros.yml)
 * con las mismas variables de entorno que la actualización automática, más:
 *   DESDE (AAAA-MM-DD, default "2026-09-01")
 */
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const ROBOT_EMAIL = process.env.ROBOT_EMAIL;
const ROBOT_PASSWORD = process.env.ROBOT_PASSWORD;

if (!FIREBASE_API_KEY || !FIREBASE_PROJECT_ID || !ROBOT_EMAIL || !ROBOT_PASSWORD) {
  console.error('Faltan variables de entorno (FIREBASE_API_KEY, FIREBASE_PROJECT_ID, ROBOT_EMAIL, ROBOT_PASSWORD).');
  process.exit(1);
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function fsValueToJs(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.nullValue !== undefined) return null;
  if (v.mapValue) return fsMapToJs(v.mapValue);
  return null;
}
function fsMapToJs(mapValue) {
  const out = {};
  const fields = (mapValue && mapValue.fields) || {};
  for (const k of Object.keys(fields)) out[k] = fsValueToJs(fields[k]);
  return out;
}

async function signIn() {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ROBOT_EMAIL, password: ROBOT_PASSWORD, returnSecureToken: true })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('No se pudo iniciar sesión en Firebase: ' + JSON.stringify(data));
  return data.idToken;
}

async function listarRegistros(idToken, desde) {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'records' }],
        where: { fieldFilter: { field: { fieldPath: 'fecha' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: desde } } },
        orderBy: [{ field: { fieldPath: 'fecha' } }]
      }
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + await res.text());
  const rows = await res.json();
  return (rows || []).filter(r => r.document).map(r => fsMapToJs(r.document));
}

(async () => {
  const desde = (process.env.DESDE || '').trim() || '2026-09-01';
  console.log(`=== Registros desde ${desde} ===`);
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL + '\n');

  const registros = await listarRegistros(idToken, desde);
  registros.sort((a, b) => (a.fecha + a.medio + a.ruta).localeCompare(b.fecha + b.medio + b.ruta));

  for (const r of registros) {
    const fuente = (r.fuente && r.fuente.texto) || '';
    console.log(`${r.fecha} | ${r.medio} | ${r.ruta} | $${r.valor} | ${r.empresa} | ${r.tipo} | ${fuente}`);
  }
  console.log(`\n=== Fin — ${registros.length} registro(s) ===`);
})().catch(err => { console.error('Error: ' + err.message); process.exit(1); });
