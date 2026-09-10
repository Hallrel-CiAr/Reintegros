'use strict';
/*
 * Corrección única: la migración (migrar_rutas.js) dejó las 7 rutas
 * heredadas con destino:"CABA" en la colección "rutas". Ese texto no lo
 * reconoce el autocompletado de Aerolíneas Argentinas ni el de Central de
 * Pasajes (se vio en la primera corrida real post-migración: 0 de 7 rutas
 * encontraron valor), así que se corrige al texto que sí funcionaba con el
 * sistema viejo de rutas fijas: "Buenos Aires" para aéreo y "Retiro" para
 * terrestre (son documentos separados por ruta+modo, así que pueden tener
 * cada uno su propio destino).
 *
 * Se dispara desde GitHub Actions (ver
 * .github/workflows/corregir-destinos.yml) con las mismas variables de
 * entorno que la actualización automática.
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

const CORRECCIONES = [
  { docId: 'NQN-CABA__aereo', destino: 'Buenos Aires' },
  { docId: 'BRC-CABA__aereo', destino: 'Buenos Aires' },
  { docId: 'VDM-CABA__aereo', destino: 'Buenos Aires' },
  { docId: 'NQN-CABA__terrestre', destino: 'Retiro' },
  { docId: 'BRC-CABA__terrestre', destino: 'Retiro' },
  { docId: 'VDM-CABA__terrestre', destino: 'Retiro' },
  { docId: 'ROC-CABA__terrestre', destino: 'Retiro' }
];

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

(async () => {
  console.log('=== Corrección de destino en rutas migradas ===');
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL + '\n');

  let corregidas = 0;
  for (const c of CORRECCIONES) {
    const res = await fetch(`${FIRESTORE_BASE}/rutas/${encodeURIComponent(c.docId)}?updateMask.fieldPaths=destino`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { destino: { stringValue: c.destino } } })
    });
    if (!res.ok) { console.log(`  ${c.docId}: error HTTP ${res.status} al corregir.`); continue; }
    console.log(`  ${c.docId}: destino -> "${c.destino}".`);
    corregidas++;
  }

  console.log(`\n=== Fin — ${corregidas} ruta(s) corregida(s) ===`);
})().catch(err => { console.error('Error: ' + err.message); process.exit(1); });
