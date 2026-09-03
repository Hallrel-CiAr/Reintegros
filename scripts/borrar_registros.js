'use strict';
/*
 * Borra registros puntuales de "records" en Firestore (y deja constancia en
 * el historial de auditoría) para poder forzar que la búsqueda automática
 * los vuelva a traer en su próxima corrida — la página no tiene botón de
 * borrado, así que esto es lo que usamos para reintentar un valor sin
 * esperar al día siguiente.
 *
 * Se dispara desde GitHub Actions (ver .github/workflows/borrar-registro.yml)
 * con las mismas variables de entorno que la actualización automática, más:
 *   FECHA  (AAAA-MM-DD, default hoy)
 *   MEDIO  ("aereo" | "terrestre" | "ambos", default "aereo")
 *   RUTAS  (códigos separados por coma, ej "NQN-CABA,BRC-CABA"; vacío = todas
 *           las rutas del/de los medio(s) elegido(s))
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

const AIR_ROUTES = ['NQN-CABA', 'BRC-CABA', 'VDM-CABA'];
const BUS_ROUTES = ['NQN-CABA', 'BRC-CABA', 'VDM-CABA', 'ROC-CABA'];

function todayStr() { return new Date().toISOString().slice(0, 10); }
function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}
function jsToFsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = jsToFsValue(obj[k]);
  return fields;
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

async function borrarRegistro(idToken, fecha, medio, ruta) {
  const id = [fecha, medio, ruta].join('|');
  const res = await fetch(`${FIRESTORE_BASE}/records/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (res.status === 404) { console.log(`  ${id}: no existía, nada que borrar.`); return false; }
  if (!res.ok) { console.log(`  ${id}: error HTTP ${res.status} al borrar.`); return false; }
  console.log(`  ${id}: borrado.`);
  const nowIso = new Date().toISOString();
  await fetch(`${FIRESTORE_BASE}/historial`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: jsToFsFields({
        recordId: id, fecha, medio, ruta,
        accion: 'eliminar', cambios: 'Borrado manualmente para forzar una nueva búsqueda automática.',
        userEmail: ROBOT_EMAIL, userName: 'Proceso automático (borrado manual)',
        ts: nowIso, tsDate: nowIso.slice(0, 10)
      })
    })
  }).catch(err => console.log(`  ${id}: no se pudo dejar constancia en el historial (${err.message}).`));
  return true;
}

(async () => {
  const fecha = (process.env.FECHA || '').trim() || todayStr();
  const medio = (process.env.MEDIO || 'aereo').trim().toLowerCase();
  const rutasEnv = (process.env.RUTAS || '').trim();

  let medios;
  if (medio === 'ambos') medios = ['aereo', 'terrestre'];
  else if (medio === 'aereo' || medio === 'terrestre') medios = [medio];
  else { console.error('MEDIO inválido: ' + medio + ' (usar "aereo", "terrestre" o "ambos")'); process.exit(1); }

  console.log(`=== Borrado manual de registros — fecha ${fecha}, medio(s): ${medios.join(', ')} ===`);
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL + '\n');

  let total = 0;
  for (const m of medios) {
    const rutas = rutasEnv ? rutasEnv.split(',').map(s => s.trim()).filter(Boolean) : (m === 'aereo' ? AIR_ROUTES : BUS_ROUTES);
    for (const ruta of rutas) {
      if (await borrarRegistro(idToken, fecha, m, ruta)) total++;
    }
  }
  console.log(`\n=== Fin — ${total} registro(s) borrado(s) ===`);
})().catch(err => { console.error('Error: ' + err.message); process.exit(1); });
