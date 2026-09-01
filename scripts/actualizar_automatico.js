'use strict';
/*
 * Búsqueda diaria automática de valores de referencia de pasajes (SOSUNC).
 *
 * Terrestre (Plataforma 10): promedio de los precios de los servicios
 * listados para la fecha y ruta.
 * Aéreo (Google Flights): la tarifa más económica encontrada.
 *
 * Nunca pisa un valor ya cargado (automático, estimado o manual): si el
 * registro de esa fecha/ruta ya tiene empresa y valor, se lo salta. Si no
 * puede confirmar un valor con la fuente, lo deja pendiente en vez de
 * inventarlo.
 *
 * Corre como GitHub Action (ver .github/workflows/actualizacion-diaria.yml),
 * NO dentro de Claude, porque el entorno de Claude no tiene salida a estos
 * sitios. Este script fue escrito a partir de capturas de pantalla de
 * Plataforma 10 y Google Flights, sin poder probarlo en vivo contra los
 * sitios reales — si algo cambió su diseño, va a fallar y hay que ajustarlo
 * (revisá el log de la Action para ver en qué paso se cae).
 *
 * Variables de entorno requeridas: FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
 * ROBOT_EMAIL, ROBOT_PASSWORD.
 */
const { chromium } = require('playwright');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const ROBOT_EMAIL = process.env.ROBOT_EMAIL;
const ROBOT_PASSWORD = process.env.ROBOT_PASSWORD;

if (!FIREBASE_API_KEY || !FIREBASE_PROJECT_ID || !ROBOT_EMAIL || !ROBOT_PASSWORD) {
  console.error('Faltan variables de entorno (FIREBASE_API_KEY, FIREBASE_PROJECT_ID, ROBOT_EMAIL, ROBOT_PASSWORD).');
  process.exit(1);
}

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const AIR_ROUTES = [
  { code: 'NQN-CABA', ciudad: 'Neuquén' },
  { code: 'BRC-CABA', ciudad: 'Bariloche' },
  { code: 'VDM-CABA', ciudad: 'Viedma' }
];
const BUS_ROUTES = [
  { code: 'NQN-CABA', ciudad: 'Neuquén' },
  { code: 'BRC-CABA', ciudad: 'Bariloche' },
  { code: 'VDM-CABA', ciudad: 'Viedma' },
  { code: 'ROC-CABA', ciudad: 'General Roca' }
];
const AIR_COMPANY_PATTERNS = [
  { match: /jetsmart/i, name: 'JetSmart' },
  { match: /flybondi/i, name: 'Flybondi' },
  { match: /aerol[ií]neas/i, name: 'Aerolíneas Argentinas' }
];

function todayStr() { return new Date().toISOString().slice(0, 10); }
function recordId(fecha, medio, ruta) { return [fecha, medio, ruta].join('|'); }
function recordValid(rec) { return !!(rec && rec.empresa && rec.valor !== null && rec.valor !== undefined && rec.valor !== ''); }

/* ---------- Firestore REST (autenticado con la cuenta robot) ---------- */

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
function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { doubleValue: v };
  if (typeof v === 'object') return { mapValue: { fields: jsToFsFields(v) } };
  throw new Error('Tipo no soportado: ' + typeof v);
}
function jsToFsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = jsToFsValue(obj[k]);
  return fields;
}

async function getRecord(idToken, id) {
  const res = await fetch(`${FIRESTORE_BASE}/records/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return fsMapToJs(await res.json());
}

async function writeRecord(idToken, id, rec) {
  const res = await fetch(`${FIRESTORE_BASE}/records/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields(rec) })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + await res.text());
}

async function writeHistoryEntry(idToken, entry) {
  const res = await fetch(`${FIRESTORE_BASE}/historial`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields(entry) })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + await res.text());
}

async function obtenerSolicitudesPendientes(idToken) {
  const res = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'solicitudes' }],
        where: { fieldFilter: { field: { fieldPath: 'estado' }, op: 'EQUAL', value: { stringValue: 'pendiente' } } }
      }
    })
  });
  if (!res.ok) { console.log('No se pudieron leer las solicitudes pendientes: HTTP ' + res.status); return []; }
  const rows = await res.json();
  return (rows || []).filter(r => r.document).map(r => ({ name: r.document.name, ...fsMapToJs(r.document) }));
}
async function marcarSolicitudResuelta(idToken, docName) {
  const path = docName.split('/documents/')[1];
  await fetch(`${FIRESTORE_BASE}/${path}?updateMask.fieldPaths=estado&updateMask.fieldPaths=resueltoEn`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: jsToFsFields({ estado: 'resuelto', resueltoEn: new Date().toISOString() }) })
  }).catch(() => {});
}

/* ---------- Búsqueda de tarifas ---------- */

function inferAirline(text) {
  for (const p of AIR_COMPANY_PATTERNS) if (p.match.test(text)) return p.name;
  return null;
}

async function buscarAereo(page, ciudad, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const fechaLegible = `${d}/${m}/${y}`;
  const q = `vuelos de ${ciudad} a Buenos Aires el ${fechaLegible} solo ida`;
  const url = 'https://www.google.com/travel/flights?gl=AR&hl=es-419&curr=ARS&q=' + encodeURIComponent(q);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const matches = [...bodyText.matchAll(/ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g)];
  const precios = matches
    .map(mm => ({ valor: Number(mm[0].replace(/[^\d]/g, '')), index: mm.index }))
    .filter(p => Number.isFinite(p.valor) && p.valor > 1000);
  if (!precios.length) return null;
  const min = precios.reduce((a, b) => (b.valor < a.valor ? b : a));
  const ventana = bodyText.slice(Math.max(0, min.index - 250), min.index);
  const aerolinea = inferAirline(ventana) || 'Tarifa más económica (ver fuente)';
  return { valor: min.valor, empresa: aerolinea, fuente: { texto: 'Google Flights', url } };
}

async function buscarTerrestre(page, ciudad, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const fechaDDMMYYYY = `${d}-${m}-${y}`;
  await page.goto('https://www.plataforma10.com.ar/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  try {
    const origenInput = page.getByPlaceholder(/Origen/i).first();
    await origenInput.click();
    await origenInput.fill(ciudad);
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const destinoInput = page.getByPlaceholder(/Destino|dónde/i).first();
    await destinoInput.click();
    await destinoInput.fill('Retiro');
    await page.waitForTimeout(1000);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const fechaInput = page.getByPlaceholder(/Partida|Fecha/i).first();
    await fechaInput.click();
    await fechaInput.fill(fechaDDMMYYYY);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Buscar pasajes/i }).click();
    await page.waitForTimeout(6000);
  } catch (err) {
    console.log('  No se pudo completar el formulario de Plataforma 10: ' + err.message);
    return null;
  }
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const matches = bodyText.match(/ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g) || [];
  const precios = matches
    .map(s => Number(s.replace(/[^\d]/g, '')))
    .filter(n => Number.isFinite(n) && n > 1000);
  if (!precios.length) return null;
  const promedio = Math.round(precios.reduce((a, b) => a + b, 0) / precios.length);
  return {
    valor: promedio,
    empresa: 'Promedio (Plataforma 10, ' + precios.length + ' servicio' + (precios.length === 1 ? '' : 's') + ')',
    fuente: { texto: 'Plataforma 10', url: page.url() }
  };
}

/* ---------- Orquestación ---------- */

async function procesarFecha(idToken, browser, fecha) {
  const page = await browser.newPage({ locale: 'es-AR' });
  const rutas = [
    ...AIR_ROUTES.map(r => ({ medio: 'aereo', ...r })),
    ...BUS_ROUTES.map(r => ({ medio: 'terrestre', ...r }))
  ];
  for (const r of rutas) {
    const id = recordId(fecha, r.medio, r.code);
    console.log(`\n[${fecha}] ${r.medio} ${r.code} (${r.ciudad})`);
    let before = null;
    try { before = await getRecord(idToken, id); } catch (err) { console.log('  Error leyendo Firestore: ' + err.message); continue; }
    if (recordValid(before)) { console.log('  Ya tiene un valor cargado, no se toca.'); continue; }

    let resultado = null;
    try {
      resultado = r.medio === 'aereo' ? await buscarAereo(page, r.ciudad, fecha) : await buscarTerrestre(page, r.ciudad, fecha);
    } catch (err) {
      console.log('  Error buscando: ' + err.message);
    }
    if (!resultado) { console.log('  No se pudo confirmar un valor con la fuente. Queda pendiente.'); continue; }

    const nowIso = new Date().toISOString();
    const after = {
      fecha, medio: r.medio, ruta: r.code, empresa: resultado.empresa, valor: resultado.valor,
      fuente: resultado.fuente, tipo: 'automatico',
      updatedAt: nowIso, updatedBy: ROBOT_EMAIL, updatedByName: 'Proceso automático'
    };
    try {
      await writeRecord(idToken, id, after);
      await writeHistoryEntry(idToken, {
        recordId: id, fecha, medio: r.medio, ruta: r.code,
        accion: 'crear', cambios: 'Cargado automáticamente: ' + after.empresa + ' — $' + after.valor,
        userEmail: ROBOT_EMAIL, userName: 'Proceso automático',
        ts: nowIso, tsDate: nowIso.slice(0, 10)
      });
      console.log('  Guardado: ' + after.empresa + ' — $' + after.valor);
    } catch (err) {
      console.log('  Error guardando en Firestore: ' + err.message);
    }
  }
  await page.close();
}

(async () => {
  console.log('=== Actualización automática de pasajes SOSUNC ===');
  const idToken = await signIn();
  console.log('Sesión iniciada como ' + ROBOT_EMAIL);

  const fechas = new Set([todayStr()]);
  const solicitudes = await obtenerSolicitudesPendientes(idToken);
  for (const s of solicitudes) if (s.fecha) fechas.add(s.fecha);
  if (solicitudes.length) console.log(`Hay ${solicitudes.length} solicitud(es) de "forzar actualización" pendiente(s).`);

  const browser = await chromium.launch();
  for (const fecha of fechas) {
    console.log(`\n--- Procesando fecha ${fecha} ---`);
    await procesarFecha(idToken, browser, fecha);
  }
  await browser.close();

  for (const s of solicitudes) await marcarSolicitudResuelta(idToken, s.name);

  console.log('\n=== Fin de la actualización ===');
})().catch(err => {
  console.error('Error fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
