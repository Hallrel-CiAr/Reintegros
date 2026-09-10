'use strict';
/*
 * Migración única: da de alta en la colección "rutas" las 7 combinaciones
 * que ya venían funcionando con el sistema viejo de rutas fijas (3 aéreas +
 * 4 terrestres, todas hacia CABA), usando EXACTAMENTE los mismos códigos
 * ("NQN-CABA", "BRC-CABA", etc.) que ya tienen los registros históricos en
 * "records" — así no hace falta tocar ni un registro viejo, quedan
 * enganchados solos a la ruta migrada.
 *
 * createdDate se pone bien atrás (no "ayer") para que estas rutas queden
 * activas desde ya, no recién "a partir de mañana" como una ruta nueva.
 *
 * No pisa una ruta que ya exista (por si se corre más de una vez).
 *
 * Se dispara desde GitHub Actions (ver .github/workflows/migrar-rutas.yml)
 * con las mismas variables de entorno que la actualización automática.
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
const CREATED_DATE_MIGRACION = '2026-08-31'; // anterior a cualquier fecha ya cargada

const RUTAS_A_MIGRAR = [
  { id: 'NQN-CABA', origen: 'Neuquén', destino: 'CABA', modo: 'aereo' },
  { id: 'BRC-CABA', origen: 'Bariloche', destino: 'CABA', modo: 'aereo' },
  { id: 'VDM-CABA', origen: 'Viedma', destino: 'CABA', modo: 'aereo' },
  { id: 'NQN-CABA', origen: 'Neuquén', destino: 'CABA', modo: 'terrestre' },
  { id: 'BRC-CABA', origen: 'Bariloche', destino: 'CABA', modo: 'terrestre' },
  { id: 'VDM-CABA', origen: 'Viedma', destino: 'CABA', modo: 'terrestre' },
  { id: 'ROC-CABA', origen: 'General Roca', destino: 'CABA', modo: 'terrestre' }
];

function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
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

(async () => {
  console.log('=== Migración de rutas fijas a rutas configurables ===');
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL + '\n');

  let creadas = 0, saltadas = 0;
  for (const r of RUTAS_A_MIGRAR) {
    // El id de DOCUMENTO combina código + modo (un doc de Firestore solo
    // puede tener un modo), pero el campo "codigo" queda igual al código
    // viejo ("NQN-CABA", sin sufijo) — es lo que la app usa para enlazar con
    // los registros históricos (records.ruta), y aéreo/terrestre comparten
    // el mismo código a propósito, igual que antes.
    const docId = `${r.id}__${r.modo}`;
    const getRes = await fetch(`${FIRESTORE_BASE}/rutas/${encodeURIComponent(docId)}`, {
      headers: { Authorization: `Bearer ${idToken}` }
    });
    if (getRes.ok) { console.log(`  ${docId}: ya existe, no se toca.`); saltadas++; continue; }

    const putRes = await fetch(`${FIRESTORE_BASE}/rutas/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: jsToFsFields({
          origen: r.origen, destino: r.destino, modo: r.modo, codigo: r.id,
          createdDate: CREATED_DATE_MIGRACION, createdAt: new Date().toISOString(),
          createdBy: ROBOT_EMAIL, createdByName: 'Migración automática'
        })
      })
    });
    if (!putRes.ok) { console.log(`  ${docId}: error HTTP ${putRes.status} al crear.`); continue; }
    console.log(`  ${docId}: creada (${r.origen} → ${r.destino}, ${r.modo}, codigo=${r.id}).`);
    creadas++;
  }

  console.log(`\n=== Fin — ${creadas} ruta(s) creada(s), ${saltadas} ya existían ===`);
})().catch(err => { console.error('Error: ' + err.message); process.exit(1); });
