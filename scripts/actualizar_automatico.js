'use strict';
/*
 * Búsqueda diaria automática de valores de referencia de pasajes (SOSUNC).
 *
 * Terrestre (Central de Pasajes, centraldepasajes.com.ar): promedio de los
 * precios de los servicios listados para la fecha y ruta. Reemplaza a
 * Plataforma 10, que daba valores correctos pero cada vez más lentos
 * (throttling tras varias búsquedas seguidas).
 * Aéreo (Aerolíneas Argentinas, aerolineas.com.ar): la tarifa más económica
 * encontrada. Se eligió por ser la única aerolínea con vuelos regulares a
 * estas 3 ciudades — comprar directo en su sitio da un precio limpio, sin
 * las tarifas de otras fechas o promociones mezcladas que contaminaban la
 * lectura cuando se scrapeaba Google Flights.
 *
 * Nunca pisa un valor ya cargado (automático, estimado o manual): si el
 * registro de esa fecha/ruta ya tiene empresa y valor, se lo salta. Si no
 * puede confirmar un valor con la fuente, lo deja pendiente en vez de
 * inventarlo.
 *
 * Corre como GitHub Action (ver .github/workflows/actualizacion-diaria.yml),
 * NO dentro de Claude, porque el entorno de Claude no tiene salida a estos
 * sitios. Ni Aerolíneas Argentinas ni Central de Pasajes se pudieron probar
 * en vivo (mismo motivo) — si algo de sus selectores no encuentra nada,
 * revisá el log de la Action (queda diagnóstico completo volcado en cada
 * corrida) y las capturas "diag_aereo_*" / "diag_terrestre_*" del artifact
 * de debug.
 *
 * Variables de entorno requeridas: FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
 * ROBOT_EMAIL, ROBOT_PASSWORD.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEBUG_DIR = 'debug';
fs.mkdirSync(DEBUG_DIR, { recursive: true });
async function capturarDebug(page, nombre) {
  try { await page.screenshot({ path: path.join(DEBUG_DIR, nombre + '.png'), fullPage: true }); } catch { /* no bloquea el proceso principal */ }
}
async function cerrarBannerCookies(page) {
  const textos = [/aceptar/i, /entendido/i, /de acuerdo/i, /accept/i];
  for (const t of textos) {
    try {
      const btn = page.getByRole('button', { name: t }).first();
      if (await btn.isVisible({ timeout: 1500 })) { await btn.click({ timeout: 1500 }); return; }
    } catch { /* no había banner con ese texto */ }
  }
}

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

// Aerolíneas Argentinas es prácticamente la única aerolínea con vuelos
// regulares a estas 3 ciudades — comprar directo ahí da un precio limpio
// (sin tarifas de otras fechas ni promociones mezcladas, que era el problema
// de fondo con Google Flights). Nunca se pudo probar este sitio en vivo
// (el entorno de Claude no tiene salida a internet general), así que se
// vuelca diagnóstico completo en cada corrida para poder ajustar selectores
// con datos reales si algo de esto no encuentra nada.
async function volcarDiagnostico(page, etiqueta) {
  try {
    const inputs = await page.locator('input:visible').evaluateAll(els =>
      els.slice(0, 25).map(e => ({ placeholder: e.placeholder || null, aria: e.getAttribute('aria-label'), name: e.name || null, type: e.type }))
    );
    console.log(`  [diagnóstico ${etiqueta}] inputs visibles: ` + JSON.stringify(inputs));
    const botones = await page.locator('button:visible, [role="button"]:visible').evaluateAll(els =>
      els.slice(0, 30).map(e => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean)
    );
    console.log(`  [diagnóstico ${etiqueta}] botones visibles: ` + JSON.stringify(botones));
  } catch (err) {
    console.log(`  [diagnóstico ${etiqueta}] no se pudo levantar: ` + err.message);
  }
}

// Busca un campo de texto por varios patrones de nombre/etiqueta posibles
// (placeholder, aria-label, o texto de un <label> asociado), ya que no se
// conoce el markup real del sitio de antemano.
async function ubicarCampoTexto(page, patrones, etiqueta) {
  for (const p of patrones) {
    for (const loc of [page.getByPlaceholder(p), page.getByLabel(p), page.getByRole('textbox', { name: p })]) {
      try {
        if (await loc.first().isVisible({ timeout: 800 })) {
          console.log(`  Campo ${etiqueta} encontrado con patrón ${p}.`);
          return loc.first();
        }
      } catch { /* patrón siguiente */ }
    }
  }
  console.log(`  No se encontró el campo ${etiqueta} con ninguno de los patrones probados.`);
  return null;
}

// Selecciona una sugerencia de un desplegable de autocompletado de ciudad —
// se reutiliza para Aerolíneas Argentinas y Central de Pasajes, que arman
// este tipo de desplegable de forma parecida. Prefiere la opción cuyo texto
// contiene lo buscado (por si aparecen resultados mezclados) y, si no
// aparece ninguna sugerencia visible, cae a navegar con el teclado.
async function seleccionarSugerencia(page, input, texto, etiqueta, opciones_ = {}) {
  // Algunos sitios (Central de Pasajes) esconden el input real detrás de un
  // widget (Select2) que intercepta los clics normales — Playwright espera
  // 30s a que "deje de estar tapado" y nunca pasa. Si el clic normal no
  // entra en 5s, se fuerza (ignora la comprobación de que esté tapado).
  // clickTarget: si el elemento clickeable para ABRIR el desplegable es
  // distinto del input real (típico de Select2, que renderiza su propio
  // widget visual encima de un <input>/<select> oculto), se puede pasar por
  // separado. searchField: Select2 además arma, al abrir el desplegable, un
  // campo de búsqueda PROPIO (.select2-search__field) donde hay que escribir
  // — escribir en el input oculto original no hace nada (se vio en una
  // captura real: el campo quedaba vacío y el sitio pedía completarlo, aunque
  // el código ya le había hecho fill()).
  const clickTarget = opciones_.clickTarget || input;
  const campoTexto = opciones_.searchField || input;
  await clickTarget.click({ timeout: 5000 }).catch(() => clickTarget.click({ force: true }));
  await campoTexto.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  await campoTexto.fill(texto);
  const opciones = page.locator(
    '[role="option"], .MuiAutocomplete-option, .select2-results__option, li[class*="suggest" i], li[class*="option" i], li[class*="autocomplete" i], ul[class*="suggest" i] li, ul[class*="autocomplete" i] li'
  );
  let seleccionado = false;
  try {
    await opciones.first().waitFor({ state: 'visible', timeout: 6000 });
    const total = await opciones.count();
    let candidata = opciones.first();
    for (let i = 0; i < total; i++) {
      const t = (await opciones.nth(i).innerText().catch(() => '')).toLowerCase();
      if (t.includes(texto.toLowerCase())) { candidata = opciones.nth(i); break; }
    }
    await candidata.click({ timeout: 3000 });
    seleccionado = true;
  } catch {
    console.log(`  No aparecieron sugerencias en pantalla para "${texto}" (${etiqueta}); se intenta con el teclado.`);
  }
  if (!seleccionado) {
    await page.waitForTimeout(600);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(400);
  const valorFinal = await input.inputValue().catch(() => '');
  if (!valorFinal.trim()) {
    console.log(`  Atención: el campo ${etiqueta} quedó vacío después de intentar seleccionar "${texto}".`);
  }
  return seleccionado || !!valorFinal.trim();
}

async function buscarAereo(page, ciudad, codigoOrigen, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const url = 'https://www.aerolineas.com.ar/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await cerrarBannerCookies(page);
  await page.waitForTimeout(2500);
  console.log('  Página cargada: "' + (await page.title().catch(() => '?')) + '"');
  await volcarDiagnostico(page, 'home');
  await capturarDebug(page, `diag_aereo_${codigoOrigen}_home`);

  try {
    // El buscador arranca en "Ida y vuelta" — el radio para cambiarlo dice
    // simplemente "Ida" (no "Solo ida", como se asumía antes; se vio en una
    // captura real). Sin este cambio, el formulario también exige fecha de
    // regreso y rechaza el envío con "Ingresa una fecha válida" aunque la
    // fecha de ida esté bien completada.
    const soloIda = page.getByText('Ida', { exact: true }).first();
    if (await soloIda.count().catch(() => 0)) {
      await soloIda.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else {
      console.log('  No se encontró el botón "Ida" — puede que ya sea el modo por defecto.');
    }

    const origenInput = await ubicarCampoTexto(page, [/origen/i, /desde/i, /ciudad de origen/i, /salida/i], 'Origen');
    const destinoInput = await ubicarCampoTexto(page, [/destino/i, /hasta/i, /ciudad de destino/i, /llegada/i], 'Destino');
    if (!origenInput || !destinoInput) {
      console.log('  No se pudo ubicar el formulario de búsqueda de Aerolíneas Argentinas.');
      return null;
    }
    await seleccionarSugerencia(page, origenInput, ciudad, 'Origen');
    await seleccionarSugerencia(page, destinoInput, 'Buenos Aires', 'Destino');

    // Relevado con diagnóstico en una corrida real: el campo de fecha de ida
    // tiene name="from-date" (placeholder "dd/mm/aaaa") — el intento anterior
    // no lo encontraba (buscaba /fecha de ida/i, que no matchea nada de eso),
    // así que el formulario quedaba sin fecha y "Buscar vuelos" no navegaba a
    // ningún lado: lo que se leía después eran precios promocionales de la
    // portada, no tarifas reales (se vio en una corrida real: las 3 rutas
    // guardaron exactamente el mismo precio).
    const fechaInput = page.locator('input[name="from-date"]');
    if (await fechaInput.count().catch(() => 0)) {
      await fechaInput.fill(`${d}/${m}/${y}`).catch(async err => {
        console.log('  No se pudo completar la fecha de Aerolíneas Argentinas: ' + err.message);
      });
      // Escribir la fecha suele abrir un calendario propio encima del
      // formulario; si queda abierto tapa el botón "Buscar vuelos" (se vio
      // en una corrida real: el clic ahí tiraba timeout). Se cierra con
      // Escape y, por las dudas, con un clic afuera del campo.
      await page.keyboard.press('Escape').catch(() => {});
      await page.locator('body').click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
    } else {
      console.log('  No se encontró el campo de fecha (name="from-date") — se sigue igual por si ya tiene una fecha válida por defecto.');
    }
    await page.waitForTimeout(500);
    await capturarDebug(page, `diag_aereo_${codigoOrigen}_formulario-completo`);

    const urlAntes = page.url();
    const botonBuscar = page.getByRole('button', { name: /buscar/i }).first();
    await botonBuscar.click({ timeout: 5000 }).catch(() => botonBuscar.click({ force: true }));
    await page.waitForTimeout(6000);
    // Si la URL no cambió, lo más probable es que el formulario no se haya
    // enviado (por ejemplo por falta de fecha) y seguimos en la portada — los
    // precios que se leerían ahí son promocionales, no de la ruta buscada.
    if (page.url() === urlAntes) {
      console.log('  La URL no cambió después de "Buscar vuelos" — probablemente el formulario no se envió. Se descarta cualquier precio de esta página.');
      await capturarDebug(page, `diag_aereo_${codigoOrigen}_no-navego`);
      return null;
    }
  } catch (err) {
    console.log('  No se pudo completar el formulario de Aerolíneas Argentinas: ' + err.message);
    await capturarDebug(page, `diag_aereo_${codigoOrigen}_error`);
    return null;
  }

  await capturarDebug(page, `diag_aereo_${codigoOrigen}_resultados`);
  const sinVuelos = page.getByText(/no (hay|encontramos) vuelos|sin disponibilidad/i).first();
  if (await sinVuelos.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('  La página indica que no hay vuelos disponibles para la fecha pedida.');
    return null;
  }
  await volcarDiagnostico(page, 'resultados');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const matches = [...bodyText.matchAll(/\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g)];
  const precios = matches
    .map(mm => ({ valor: Number(mm[0].replace(/[^\d]/g, '')), index: mm.index }))
    .filter(p => Number.isFinite(p.valor) && p.valor > 1000);
  if (!precios.length) return null;
  const ordenados = precios.map(p => p.valor).sort((a, b) => a - b);
  console.log('  Precios detectados (primeros 8): ' + ordenados.slice(0, 8).join(', '));
  const min = precios.reduce((a, b) => (b.valor < a.valor ? b : a));
  return { valor: min.valor, empresa: 'Aerolíneas Argentinas', fuente: { texto: 'Aerolíneas Argentinas', url: page.url() } };
}

async function destildarAlojamiento(page) {
  // El buscador tilda "Quiero buscar alojamiento" por defecto: si queda
  // tildado, "Buscar pasajes" manda a resultados de hoteles (Booking) en
  // vez de resultados de micros, aunque el resto del formulario esté bien.
  try {
    const porRol = page.getByRole('checkbox', { name: /alojamiento/i });
    const n = await porRol.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const chk = porRol.nth(i);
      if (await chk.isChecked().catch(() => false)) {
        await chk.uncheck({ timeout: 2000 }).catch(() => chk.click({ timeout: 2000 }).catch(() => {}));
      }
    }
    if (n === 0) {
      // El checkbox puede no tener "nombre accesible" (aria) armado: se
      // busca por el texto de la etiqueta y se destilda el input más cercano.
      const etiqueta = page.locator('label, span, div').filter({ hasText: /quiero buscar alojamiento/i }).first();
      if (await etiqueta.count().catch(() => 0)) {
        const caja = etiqueta.locator('input[type="checkbox"]').first();
        if (await caja.count().catch(() => 0) && await caja.isChecked().catch(() => false)) {
          await caja.click({ timeout: 2000 }).catch(() => {});
        }
      }
    }
  } catch { /* si no aparece el checkbox en esta versión de la página, no hay nada que destildar */ }
}

// Plataforma 10 daba valores correctos pero cada vez más lentos (throttling
// tras varias búsquedas seguidas — una corrida llegó a tardar 7 min por
// ruta). Se prueba Central de Pasajes como alternativa. Igual que con
// Aerolíneas Argentinas, nunca se pudo probar este sitio en vivo, así que
// se vuelca el mismo diagnóstico completo en cada corrida.
async function buscarTerrestre(page, ciudad, codigoOrigen, fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  const url = 'https://www.centraldepasajes.com.ar/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await cerrarBannerCookies(page);
  await page.waitForTimeout(2000);
  console.log('  Página cargada: "' + (await page.title().catch(() => '?')) + '"');
  await volcarDiagnostico(page, 'home');
  await capturarDebug(page, `diag_terrestre_${codigoOrigen}_home`);

  try {
    await destildarAlojamiento(page);

    // Relevado con diagnóstico en una corrida real (ver diag_terrestre_*):
    // los campos tienen name="PadOrigen" / "PadDestino" / "fechaPartida" y
    // el botón de submit es name="btnCons" — mucho más confiable que adivinar
    // por placeholder (el intento anterior fallaba porque buscaba /hasta/i
    // y el placeholder real dice "Ingresá hacia dónde viajás").
    const origenInput = page.locator('input[name="PadOrigen"]');
    const destinoInput = page.locator('input[name="PadDestino"]');
    if (!(await origenInput.count().catch(() => 0)) || !(await destinoInput.count().catch(() => 0))) {
      console.log('  No se encontró el formulario de búsqueda de Central de Pasajes (cambió el markup).');
      return null;
    }
    // El input real queda oculto detrás del widget visual que arma Select2
    // (patrón típico: un <span id="select2-<name>-container"> al lado del
    // input) — hay que clickear ESE elemento para que abra el desplegable de
    // sugerencias, clickear el input escondido no lo dispara aunque el clic
    // en sí entre (se vio en una corrida real: el clic ya no tira timeout,
    // pero nunca aparecen sugerencias). Si no existe ese contenedor, se cae
    // al input con clic forzado como antes.
    const origenVisual = page.locator('#select2-PadOrigen-container');
    const destinoVisual = page.locator('#select2-PadDestino-container');
    if (!(await origenVisual.count().catch(() => 0))) {
      console.log('  No se encontró #select2-PadOrigen-container — volcando el HTML alrededor del input para ajustar en la próxima corrida.');
      const html = await origenInput.evaluate(el => el.closest('div,span')?.outerHTML?.slice(0, 1500) || el.outerHTML).catch(() => null);
      console.log('  [diagnóstico] HTML cerca de PadOrigen: ' + html);
    }
    // El campo de búsqueda que Select2 arma al abrir el desplegable es el
    // mismo para cualquier instancia de la página (se reutiliza) — como
    // Origen y Destino se completan uno por vez, ":visible" siempre apunta
    // al que está realmente abierto en ese momento. Solo se usa cuando
    // realmente se pudo clickear el widget visual — si se cayó al input
    // escondido (fallback), no hay desplegable Select2 abierto y ese campo
    // de búsqueda no existiría.
    const campoBusquedaSelect2 = page.locator('.select2-search__field:visible').first();
    const hayOrigenVisual = await origenVisual.count().catch(() => 0);
    const hayDestinoVisual = await destinoVisual.count().catch(() => 0);
    await seleccionarSugerencia(page, origenInput, ciudad, 'Origen', {
      clickTarget: hayOrigenVisual ? origenVisual : origenInput,
      searchField: hayOrigenVisual ? campoBusquedaSelect2 : undefined
    });
    await seleccionarSugerencia(page, destinoInput, 'Retiro', 'Destino', {
      clickTarget: hayDestinoVisual ? destinoVisual : destinoInput,
      searchField: hayDestinoVisual ? campoBusquedaSelect2 : undefined
    });

    const fechaInput = page.locator('input[name="fechaPartida"]');
    if (await fechaInput.count().catch(() => 0)) {
      const diaTexto = String(Number(d));
      const esEditable = await fechaInput.isEditable().catch(() => false);
      let escrita = false;
      if (esEditable) {
        try { await fechaInput.fill(`${d}/${m}/${y}`); escrita = true; } catch { /* se prueba con el calendario */ }
      }
      if (!escrita) {
        await fechaInput.click();
        await page.waitForTimeout(800);
        await page.locator('button', { hasText: new RegExp('^' + diaTexto + '$') }).first().click({ timeout: 5000 }).catch(async () => {
          console.log('  No se pudo clickear el día en el calendario de Central de Pasajes.');
          await volcarDiagnostico(page, 'calendario');
        });
      }
    } else {
      console.log('  No se encontró el campo de fecha (name="fechaPartida") — se sigue igual por si ya tiene una fecha válida por defecto.');
    }
    await page.waitForTimeout(500);
    await capturarDebug(page, `diag_terrestre_${codigoOrigen}_formulario-completo`);

    await page.locator('[name="btnCons"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(6000);
  } catch (err) {
    console.log('  No se pudo completar el formulario de Central de Pasajes: ' + err.message);
    await capturarDebug(page, `diag_terrestre_${codigoOrigen}_error`);
    return null;
  }

  await capturarDebug(page, `diag_terrestre_${codigoOrigen}_resultados`);
  const sinServicio = page.getByText(/no (hay|disponemos|encontramos) (servicios|resultados)|sin disponibilidad/i).first();
  if (await sinServicio.isVisible({ timeout: 1000 }).catch(() => false)) {
    console.log('  La página indica que no hay servicios para la fecha pedida.');
    return null;
  }
  await volcarDiagnostico(page, 'resultados');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const matches = bodyText.match(/\$\s?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|ARS\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?/g) || [];
  const precios = matches
    .map(s => Number(s.replace(/[^\d]/g, '')))
    .filter(n => Number.isFinite(n) && n > 1000);
  if (!precios.length) return null;
  console.log('  Precios detectados: ' + precios.join(', '));
  const promedio = Math.round(precios.reduce((a, b) => a + b, 0) / precios.length);
  return {
    valor: promedio,
    empresa: 'Promedio (Central de Pasajes, ' + precios.length + ' servicio' + (precios.length === 1 ? '' : 's') + ')',
    fuente: { texto: 'Central de Pasajes', url: page.url() }
  };
}

/* ---------- Orquestación ---------- */

async function procesarFecha(idToken, browser, fecha) {
  // User-Agent de un Chrome de escritorio real: por defecto Playwright ya
  // manda uno parecido, pero se fija explícito por si acaso — Aerolíneas
  // Argentinas devolvió "403 Forbidden" en las 3 rutas en una corrida real
  // (probablemente bloquea por reputación de IP de datacenter, no por esto),
  // así que vale la pena descartar esto como causa antes de asumir que es
  // un bloqueo de red que no se puede arreglar desde acá.
  const page = await browser.newPage({
    locale: 'es-AR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
  });
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
      resultado = r.medio === 'aereo' ? await buscarAereo(page, r.ciudad, r.code.split('-')[0], fecha) : await buscarTerrestre(page, r.ciudad, r.code.split('-')[0], fecha);
    } catch (err) {
      console.log('  Error buscando: ' + err.message);
    }
    await capturarDebug(page, `${fecha}_${r.medio}_${r.code}${resultado ? '' : '_SIN-RESULTADO'}`);
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
